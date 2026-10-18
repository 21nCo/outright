import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { defaultProviderAccountId } from "./database.mjs";
import { EXECUTION_ADAPTERS, withAccountHome, withoutDirectProviderCredentials } from "./execution-adapters/index.mjs";
import { defaultProbe } from "./provider-discovery.mjs";

// Account inventory, switching and usage for execution adapters.
//
// A harness account is a CLI home directory (CLAUDE_CONFIG_DIR, CODEX_HOME)
// that the user signed in to with the CLI itself. Outright stores only the
// directory and never reads the credentials inside it. Each provider also
// has an implicit default account: whatever home the runtime's environment
// selects, or a direct provider's own credential variable.
//
// A run resolves its account once, at launch, and records it. Resuming a
// session keeps the account that created it; any other launch uses the
// provider's active account. Nothing falls back to another account.
const LABEL_CHARACTERS = 80;
const HOME_PATH_BYTES = 4096;
const IDENTITY_TIMEOUT_MS = 5_000;
const NOTIFY_DELAY_MS = 250;
// A reported window older than this is shown as stale rather than current.
export const LIMIT_STALE_AFTER_MS = 30 * 60_000;
export const MEASURED_PERIODS = Object.freeze([
  Object.freeze({ id: "5h", label: "Last 5 hours", durationMs: 5 * 3_600_000 }),
  Object.freeze({ id: "7d", label: "Last 7 days", durationMs: 7 * 86_400_000 }),
]);

function accountError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = { code };
  return error;
}

// A window whose reset time has passed no longer describes the account; its
// old utilization is withheld until the provider reports again.
export function presentLimitWindow(window, now) {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const observedAt = Date.parse(window.observedAt);
  if (Number.isFinite(resetsAt) && resetsAt <= now) return { ...window, utilization: null, status: null, state: "reset" };
  return { ...window, state: now - observedAt > LIMIT_STALE_AFTER_MS ? "stale" : "current" };
}

export function createProviderAccounts({ database, publish = () => {}, probe = defaultProbe, environment = process.env, adapters = EXECUTION_ADAPTERS, clock = Date.now }) {
  const identities = new Map();
  const pendingChecks = new Map();
  const switches = new Map();
  // Identity checks run one at a time, so opening Settings with many
  // accounts never starts a burst of CLI processes.
  let checkQueue = Promise.resolve();
  let notifyTimer = null;
  const closing = new AbortController();

  function notify() {
    if (notifyTimer || closing.signal.aborted) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; publish({ type: "provider-accounts.changed" }); }, NOTIFY_DELAY_MS);
    notifyTimer.unref?.();
  }

  function adapterFor(provider) {
    const adapter = adapters.find((candidate) => candidate.id === provider);
    if (!adapter) throw accountError(400, `Provider must be one of ${adapters.map((candidate) => candidate.id).join(", ")}`, "PROVIDER_UNKNOWN");
    return adapter;
  }

  function defaultAccount(adapter) {
    return { id: defaultProviderAccountId(adapter.id), provider: adapter.id, homePath: null, isDefault: true,
      label: adapter.kind === "harness" ? "Default login" : adapter.authority.variable };
  }

  function findAccount(accountId) {
    if (typeof accountId !== "string") return null;
    const adapter = adapters.find((candidate) => accountId === defaultProviderAccountId(candidate.id));
    if (adapter) return defaultAccount(adapter);
    const stored = database.getProviderAccount(accountId);
    return stored && adapters.some((candidate) => candidate.id === stored.provider) ? { ...stored, isDefault: false } : null;
  }

  async function probeIdentity(account, adapter) {
    if (adapter.kind !== "harness") {
      const detected = adapter.detect(environment);
      return detected.available ? { status: "configured", identity: null, error: null } : { status: "unavailable", identity: null, error: detected.reason };
    }
    if (!adapter.accounts) return { status: "unknown", identity: null, error: `${adapter.label} does not report its login` };
    const base = withoutDirectProviderCredentials(environment);
    const scoped = account.homePath ? withAccountHome(base, adapter.accounts.homeVariable, account.homePath) : base;
    try {
      // Both CLIs exit 1 for a signed-out login and still print its status.
      if (closing.signal.aborted) throw closing.signal.reason;
      const output = await probe(adapter.executable, { signal: closing.signal, args: [...adapter.accounts.identityArgs], environment: scoped, timeoutMs: IDENTITY_TIMEOUT_MS, exitCodes: [0, 1] });
      const identity = adapter.accounts.parseIdentity(output);
      if (!identity) return { status: "unknown", identity: null, error: `${adapter.label} printed a login status Outright does not recognize` };
      return { status: identity.signedIn ? "signed-in" : "signed-out", identity, error: null };
    } catch {
      // The probe's own message can quote CLI output; it is not repeated.
      return { status: "unknown", identity: null, error: `${adapter.label} login status could not be checked` };
    }
  }

  // Concurrent requests for one account share a single check.
  function checkIdentity(account) {
    const pending = pendingChecks.get(account.id);
    if (pending) return pending;
    const adapter = adapterFor(account.provider);
    const task = (checkQueue = checkQueue.then(async () => {
      const result = { ...await probeIdentity(account, adapter), checkedAt: new Date(clock()).toISOString() };
      // A removed account's late result is dropped.
      if (findAccount(account.id)) {
        if (JSON.stringify(identities.get(account.id)) !== JSON.stringify(result)) notify();
        identities.set(account.id, result);
      }
      return result;
    })).finally(() => { if (pendingChecks.get(account.id) === task) pendingChecks.delete(account.id); });
    pendingChecks.set(account.id, task);
    return task;
  }

  function identitySummary(account) {
    const identity = identities.get(account.id)?.identity;
    return identity?.email ?? identity?.method ?? null;
  }

  function presentAccount(account, adapter, activeId, now) {
    const checked = identities.get(account.id);
    if (!checked && !pendingChecks.has(account.id)) void checkIdentity(account).catch(() => {});
    return {
      id: account.id,
      label: account.label,
      isDefault: account.isDefault,
      homePath: account.homePath,
      active: account.id === activeId,
      login: checked ?? { status: "checking", identity: null, error: null, checkedAt: null },
      measured: MEASURED_PERIODS.map((period) => {
        const since = new Date(now - period.durationMs).toISOString();
        return { period: period.id, label: period.label, since, ...database.measuredAccountUsage(account.id, since) };
      }),
      // Only providers that report usage windows have any; for the others
      // the limits are unavailable, never zero.
      limits: adapter.capabilities.usageLimits ? database.listProviderLimits(account.id).map((window) => presentLimitWindow(window, now)) : null,
    };
  }

  function list() {
    const now = clock();
    const stored = database.listProviderAccounts();
    return {
      generatedAt: new Date(now).toISOString(),
      limitStaleAfterMs: LIMIT_STALE_AFTER_MS,
      providers: adapters.map((adapter) => {
        const activeAccountId = database.activeProviderAccountId(adapter.id);
        const accounts = [defaultAccount(adapter), ...stored.filter((account) => account.provider === adapter.id).map((account) => ({ ...account, isDefault: false }))];
        return {
          provider: adapter.id,
          label: adapter.label,
          kind: adapter.kind,
          homeVariable: adapter.accounts?.homeVariable ?? null,
          switchable: Boolean(adapter.accounts),
          usageLimits: Boolean(adapter.capabilities.usageLimits),
          activeAccountId,
          accounts: accounts.map((account) => presentAccount(account, adapter, activeAccountId, now)),
        };
      }),
    };
  }

  async function validatedHome(adapter, homePath) {
    if (typeof homePath !== "string" || !homePath || homePath.includes("\0") || Buffer.byteLength(homePath) > HOME_PATH_BYTES || !path.isAbsolute(homePath)) {
      throw accountError(400, `Enter the absolute path of a ${adapter.accounts.homeVariable} directory`, "PROVIDER_ACCOUNT_INVALID");
    }
    let resolved;
    let details;
    try {
      resolved = await realpath(homePath);
      details = await stat(resolved);
    } catch {
      throw accountError(400, "That directory does not exist or cannot be read", "PROVIDER_ACCOUNT_INVALID");
    }
    if (!details.isDirectory()) throw accountError(400, "The account home must be a directory", "PROVIDER_ACCOUNT_INVALID");
    // A login in another user's directory is not this user's to select.
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
      throw accountError(400, "The account home must be a directory you own", "PROVIDER_ACCOUNT_INVALID");
    }
    const inherited = Object.entries(environment).find(([key]) => key.toUpperCase() === adapter.accounts.homeVariable)?.[1];
    if (inherited && await realpath(inherited).catch(() => null) === resolved) {
      throw accountError(409, "That directory is already the default login", "PROVIDER_ACCOUNT_DUPLICATE");
    }
    return resolved;
  }

  async function add(input) {
    const adapter = adapterFor(input?.provider);
    if (!adapter.accounts) throw accountError(409, `${adapter.label} uses ${adapter.authority.variable}; it has no other accounts to add`, "PROVIDER_ACCOUNT_UNSUPPORTED");
    const label = typeof input.label === "string" ? input.label.trim() : "";
    if (!label || [...label].length > LABEL_CHARACTERS || /[\u0000-\u001f\u007f]/.test(label)) {
      throw accountError(400, `Account name must be 1 to ${LABEL_CHARACTERS} characters`, "PROVIDER_ACCOUNT_INVALID");
    }
    if (label.toLowerCase() === defaultAccount(adapter).label.toLowerCase()) throw accountError(409, "Another account for this provider has that name", "PROVIDER_ACCOUNT_DUPLICATE");
    const homePath = await validatedHome(adapter, input.homePath);
    const account = database.createProviderAccount({ provider: adapter.id, label, homePath });
    notify();
    await checkIdentity({ ...account, isDefault: false });
    return list();
  }

  function remove(accountId) {
    const account = findAccount(accountId);
    if (!account) throw accountError(404, "Account not found", "PROVIDER_ACCOUNT_NOT_FOUND");
    if (account.isDefault) throw accountError(409, "The default login cannot be removed", "PROVIDER_ACCOUNT_DEFAULT");
    if (!database.deleteProviderAccount(account.id)) throw accountError(404, "Account not found", "PROVIDER_ACCOUNT_NOT_FOUND");
    identities.delete(account.id);
    notify();
    return list();
  }

  async function refresh(accountId) {
    const account = findAccount(accountId);
    if (!account) throw accountError(404, "Account not found", "PROVIDER_ACCOUNT_NOT_FOUND");
    await checkIdentity(account);
    return list();
  }

  // Switching affects only launches that start a new session. A running
  // run keeps the environment it was spawned with, and a chat's existing
  // session keeps its own account.
  async function activate(input) {
    const adapter = adapterFor(input?.provider);
    if (!adapter.accounts) throw accountError(409, `${adapter.label} uses ${adapter.authority.variable}; it has no other accounts`, "PROVIDER_ACCOUNT_UNSUPPORTED");
    const account = findAccount(input.accountId);
    if (!account || account.provider !== adapter.id) throw accountError(404, "Account not found", "PROVIDER_ACCOUNT_NOT_FOUND");
    // Switches for one provider apply in request order.
    const previous = switches.get(adapter.id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const result = await checkIdentity(account);
      if (result.status === "signed-out") {
        const signIn = account.homePath ? ` Sign in with ${adapter.accounts.homeVariable} set to its directory, then switch again.` : " Sign in with the CLI, then switch again.";
        throw accountError(409, `${account.label} is signed out of ${adapter.label}.${signIn}`, "PROVIDER_ACCOUNT_SWITCH_FAILED");
      }
      if (result.status !== "signed-in") throw accountError(409, `Could not confirm that ${account.label} is signed in: ${result.error}`, "PROVIDER_ACCOUNT_SWITCH_FAILED");
      database.selectProviderAccount(adapter.id, account.id);
      notify();
    });
    switches.set(adapter.id, task);
    try { await task; }
    finally { if (switches.get(adapter.id) === task) switches.delete(adapter.id); }
    return list();
  }

  // The account a launch uses. `accountId` pins a recovery to the account
  // of the run it continues.
  function resolve({ provider, conversationId, sessionId = null, accountId }) {
    const adapter = adapterFor(provider);
    const owner = accountId ?? database.sessionAccountId(conversationId, provider, sessionId);
    const account = findAccount(owner ?? database.activeProviderAccountId(provider));
    if (!account || account.provider !== adapter.id) {
      throw accountError(409, owner
        ? `The ${adapter.label} account this chat's session belongs to was removed. Clear the session in chat settings to continue with the active account.`
        : `The active ${adapter.label} account was removed. Choose another account in Settings.`, "PROVIDER_ACCOUNT_UNAVAILABLE");
    }
    return { id: account.id, provider: account.provider, label: account.label, homePath: account.homePath, identity: identitySummary(account) };
  }

  // Before a message or run is written: the account must exist and must not
  // be known to be signed out. A cached sign-out is checked again first.
  async function assertLaunchable(target) {
    const account = resolve(target);
    if (identities.get(account.id)?.status !== "signed-out") return account;
    const result = await checkIdentity(account);
    if (result.status === "signed-out") {
      throw accountError(409, `${account.label} is signed out. Sign in, refresh it in Settings, then send again.`, "PROVIDER_ACCOUNT_SIGNED_OUT");
    }
    return resolve(target);
  }

  return {
    list,
    add,
    remove,
    refresh,
    activate,
    resolve,
    assertLaunchable,
    bindRun(runId, account) { database.bindRunAccount(runId, account); },
    recordLimits(accountId, provider, runId, windows) {
      if (!windows?.length) return;
      try { database.recordProviderLimits(accountId, provider, runId, windows, new Date(clock()).toISOString()); }
      catch (error) { if (error.statusCode !== 507) throw error; return; }
      notify();
    },
    // Stops queued and running identity checks and waits for their probes.
    async close() {
      closing.abort();
      if (notifyTimer) clearTimeout(notifyTimer);
      notifyTimer = null;
      await Promise.allSettled([...pendingChecks.values()]);
    },
  };
}
