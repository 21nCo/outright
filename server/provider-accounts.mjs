import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
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
// A run resolves its account once, at launch, and records it with the CLI
// home it used. Resuming a session keeps the account that created it, and a
// recovery keeps the account of the run it continues; any other launch uses
// the provider's active account. Nothing falls back to another account.
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

// The account a run continues with: the one it launched with, or the one a
// recovery run was pinned to before it launched. A run that launched before
// accounts used the default login in a home nobody recorded (`home`
// undefined). A run that never launched has none.
export function accountPin(run) {
  if (run?.accountId) return { accountId: run.accountId, home: run.accountHome ?? null, recovery: true };
  if (run?.accountPinId) return { accountId: run.accountPinId, home: run.accountPinHomeKnown === 0 ? undefined : run.accountPinHome ?? null, recovery: true };
  if (run?.startedAt) return { accountId: defaultProviderAccountId(run.provider), home: undefined, recovery: true };
  return null;
}

export function createProviderAccounts({ database, publish = () => {}, probe = defaultProbe, environment = process.env, adapters = EXECUTION_ADAPTERS, clock = Date.now,
  platform = process.platform, homeDirectory = os.homedir() }) {
  const identities = new Map();
  const pendingChecks = new Map();
  const switches = new Map();
  // A provider whose identity probe could not be proven stopped gets no
  // further probes; close() reports it, as provider discovery does.
  const cleanupErrors = new Map();
  // Identity checks run one at a time, so opening Settings with many
  // accounts never starts a burst of CLI processes. The chain never
  // rejects: one failed check affects only its own callers.
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

  // A variable as the CLI reads it: environment names are exact except on
  // Windows.
  function environmentValue(name) {
    if (platform !== "win32") return environment[name] || null;
    return Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1] || null;
  }

  function inheritedHome(adapter) {
    return environmentValue(adapter.accounts.homeVariable);
  }

  function standardHome(adapter) {
    return path.join(homeDirectory, adapter.accounts.standardHome);
  }

  // Where a home leads, through links. A part that does not exist yet keeps
  // its name under its nearest existing directory, so the key does not
  // change when it is created. Windows paths compare without case.
  function canonicalHome(home) {
    const missing = [];
    let existing = path.resolve(home);
    let resolved = null;
    while (resolved === null) {
      try { resolved = path.join(realpathSync(existing), ...missing); }
      catch {
        const parent = path.dirname(existing);
        if (parent === existing) resolved = path.resolve(home);
        else { missing.unshift(path.basename(existing)); existing = parent; }
      }
    }
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  // The one key a CLI home is recorded, compared and partitioned by: its
  // canonical directory, or null for the CLI's standard home. Runs, recovery
  // pins, measured usage, limit windows and duplicate checks all use it.
  function homeKey(adapter, home) {
    if (!adapter.accounts) return null;
    const standard = canonicalHome(standardHome(adapter));
    const canonical = home ? canonicalHome(home) : standard;
    return canonical === standard ? null : canonical;
  }

  // The default login's key: its home variable's directory, or null when
  // the variable is unset or names the standard home.
  function defaultHome(adapter) {
    return adapter.accounts ? homeKey(adapter, inheritedHome(adapter)) : null;
  }

  // Whether two recorded homes are one directory. Homes recorded before
  // keys were canonical are compared by their key too.
  function sameHome(adapter, recorded, home) {
    return (recorded ?? null) === (home ?? null) || homeKey(adapter, recorded) === homeKey(adapter, home);
  }

  // An added account whose directory the environment now selects for the
  // default login: one login under two ids. It is not activated and starts
  // no new session; sessions it already has keep it.
  function sameAsDefault(account, adapter) {
    return Boolean(account.homePath) && homeKey(adapter, account.homePath) === defaultHome(adapter);
  }

  // A credential variable the default login launches with overrides the
  // login in its home (adapter accounts.credentialVariables).
  function environmentCredential(adapter) {
    return adapter.accounts?.credentialVariables.find((name) => environmentValue(name)) ?? null;
  }

  function accountHome(account, adapter) {
    return account.homePath ? homeKey(adapter, account.homePath) : defaultHome(adapter);
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
    // The CLI's status command reports only the home's login, which such a
    // variable replaces; the variable is named, never its value.
    const variable = account.homePath ? null : environmentCredential(adapter);
    if (variable) return { status: "configured", identity: { signedIn: true, method: "environment", variable, email: null, organization: null, plan: null }, error: null };
    if (cleanupErrors.has(adapter.id)) return { status: "unknown", identity: null, error: `${adapter.label} login checks stopped: an earlier check could not be confirmed stopped` };
    const base = withoutDirectProviderCredentials(environment);
    const scoped = account.homePath ? withAccountHome(base, adapter.accounts, account.homePath) : base;
    try {
      // Both CLIs exit 1 for a signed-out login and still print its status.
      if (closing.signal.aborted) throw closing.signal.reason;
      const output = await probe(adapter.executable, { signal: closing.signal, args: [...adapter.accounts.identityArgs], environment: scoped, timeoutMs: IDENTITY_TIMEOUT_MS, exitCodes: [0, 1] });
      const identity = adapter.accounts.parseIdentity(output);
      if (!identity) return { status: "unknown", identity: null, error: `${adapter.label} printed a login status Outright does not recognize` };
      return { status: identity.signedIn ? "signed-in" : "signed-out", identity, error: null };
    } catch (error) {
      if (error?.code === "OUTRIGHT_PROBE_CLEANUP_UNCERTAIN") cleanupErrors.set(adapter.id, error);
      // The probe's own message can quote CLI output; it is not repeated.
      return { status: "unknown", identity: null, error: `${adapter.label} login status could not be checked` };
    }
  }

  // Concurrent requests for one account share a single check.
  function checkIdentity(account) {
    const pending = pendingChecks.get(account.id);
    if (pending) return pending;
    const adapter = adapterFor(account.provider);
    const task = checkQueue.then(async () => {
      const result = { ...await probeIdentity(account, adapter), checkedAt: new Date(clock()).toISOString() };
      // A removed account's late result is dropped.
      if (findAccount(account.id)) {
        if (JSON.stringify(identities.get(account.id)) !== JSON.stringify(result)) notify();
        identities.set(account.id, result);
      }
      return result;
    }).finally(() => { if (pendingChecks.get(account.id) === task) pendingChecks.delete(account.id); });
    checkQueue = task.catch(() => {});
    pendingChecks.set(account.id, task);
    return task;
  }

  function identitySummary(account) {
    const identity = identities.get(account.id)?.identity;
    return identity?.email ?? identity?.variable ?? identity?.method ?? null;
  }

  function presentAccount(account, adapter, activeId, now) {
    const checked = identities.get(account.id);
    const home = accountHome(account, adapter);
    if (!checked && !pendingChecks.has(account.id)) void checkIdentity(account).catch(() => {});
    return {
      id: account.id,
      label: account.label,
      isDefault: account.isDefault,
      homePath: account.homePath,
      active: account.id === activeId,
      sameAsDefault: sameAsDefault(account, adapter),
      login: checked ?? { status: "checking", identity: null, error: null, checkedAt: null },
      // A rolling window changes when its oldest run leaves it (`changesAt`),
      // with no event to announce it; the client lists again then.
      measured: MEASURED_PERIODS.map((period) => {
        const since = new Date(now - period.durationMs).toISOString();
        const { oldestBoundAt, ...usage } = database.measuredAccountUsage(account.id, since, home);
        const changesAt = oldestBoundAt ? new Date(Date.parse(oldestBoundAt) + period.durationMs + 1).toISOString() : null;
        return { period: period.id, label: period.label, since, changesAt, ...usage };
      }),
      // Only providers that report usage windows have any; for the others
      // the limits are unavailable, never zero.
      limits: adapter.capabilities.usageLimits ? database.listProviderLimits(account.id, home).map((window) => presentLimitWindow(window, now)) : null,
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
    // Windows reports no owner here; a home must be inside the user's profile.
    if (platform === "win32") {
      const profile = await realpath(homeDirectory).catch(() => null);
      const relative = profile ? path.relative(profile, resolved) : "..";
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw accountError(400, "The account home must be a directory inside your user profile", "PROVIDER_ACCOUNT_INVALID");
      }
    } else if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
      throw accountError(400, "The account home must be a directory you own", "PROVIDER_ACCOUNT_INVALID");
    }
    // With the variable unset, the CLI's standard home is the default login.
    const key = homeKey(adapter, resolved);
    if (key === defaultHome(adapter)) throw accountError(409, "That directory is already the default login", "PROVIDER_ACCOUNT_DUPLICATE");
    return { resolved, key };
  }

  async function add(input) {
    const adapter = adapterFor(input?.provider);
    if (!adapter.accounts) throw accountError(409, `${adapter.label} uses ${adapter.authority.variable}; it has no other accounts to add`, "PROVIDER_ACCOUNT_UNSUPPORTED");
    const label = typeof input.label === "string" ? input.label.trim() : "";
    if (!label || [...label].length > LABEL_CHARACTERS || /[\u0000-\u001f\u007f]/.test(label)) {
      throw accountError(400, `Account name must be 1 to ${LABEL_CHARACTERS} characters`, "PROVIDER_ACCOUNT_INVALID");
    }
    if (label.toLowerCase() === defaultAccount(adapter).label.toLowerCase()) throw accountError(409, "Another account for this provider has that name", "PROVIDER_ACCOUNT_DUPLICATE");
    const { resolved: homePath, key } = await validatedHome(adapter, input.homePath);
    // Checked with no await before the write, so two spellings of one
    // directory (Windows case) cannot both be added.
    if (database.listProviderAccounts().some((account) => account.provider === adapter.id && homeKey(adapter, account.homePath) === key)) {
      throw accountError(409, "That directory is already an account for this provider", "PROVIDER_ACCOUNT_DUPLICATE");
    }
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
      if (sameAsDefault(account, adapter)) throw duplicateOfDefault(account, adapter);
      const result = await checkIdentity(account);
      if (result.status === "signed-out") {
        const signIn = account.homePath ? ` Sign in with ${adapter.accounts.homeVariable} set to its directory, then switch again.` : " Sign in with the CLI, then switch again.";
        throw accountError(409, `${account.label} is signed out of ${adapter.label}.${signIn}`, "PROVIDER_ACCOUNT_SWITCH_FAILED");
      }
      // A default login that uses a credential variable launches with it.
      if (result.status !== "signed-in" && result.status !== "configured") throw accountError(409, `Could not confirm that ${account.label} is signed in: ${result.error}`, "PROVIDER_ACCOUNT_SWITCH_FAILED");
      database.selectProviderAccount(adapter.id, account.id);
      notify();
    });
    switches.set(adapter.id, task);
    try { await task; }
    finally { if (switches.get(adapter.id) === task) switches.delete(adapter.id); }
    return list();
  }

  function duplicateOfDefault(account, adapter) {
    return accountError(409, `${account.label} uses the directory the ${adapter.label} default login now uses. Use Default login for new sessions, or remove ${account.label}.`, "PROVIDER_ACCOUNT_DUPLICATE");
  }

  // The account a launch uses. `pin` (see accountPin) holds a recovery to
  // the account of the run it continues; otherwise a resumed session keeps
  // the account of the run that last launched in it. `home` is the key (homeKey)
  // of the CLI home the launch uses, recorded with the run.
  function resolve({ provider, conversationId, sessionId = null, pin = null }) {
    const adapter = adapterFor(provider);
    const owner = pin ?? database.sessionAccount(conversationId, provider, sessionId);
    const account = findAccount(owner?.accountId ?? database.activeProviderAccountId(provider));
    // A recovery's account cannot be changed from the chat, so its errors
    // name what does work.
    const remedy = owner?.recovery ? "or discard the interrupted run" : "or clear the session in chat settings";
    if (!account || account.provider !== adapter.id) {
      throw accountError(409, !owner
        ? `The active ${adapter.label} account was removed. Choose another account in Settings.`
        : owner.recovery
          ? `The ${adapter.label} account this interrupted run launched with was removed, so this run cannot continue. Discard the interrupted run.`
          : `The ${adapter.label} account this chat's session belongs to was removed. Clear the session in chat settings to continue with the active account.`, "PROVIDER_ACCOUNT_UNAVAILABLE");
    }
    if (!owner && sameAsDefault(account, adapter)) throw duplicateOfDefault(account, adapter);
    const home = accountHome(account, adapter);
    // The default login follows the environment. A session it created under
    // another home is not resumed under this one. A run from before accounts
    // recorded no home and is taken to have used the current default.
    if (owner && account.isDefault && owner.home !== undefined && !sameHome(adapter, owner.home, home)) {
      const where = (value) => value ?? "the CLI's standard directory";
      const subject = owner.recovery ? "This interrupted run" : "This chat's session";
      throw accountError(409, `${subject} used the ${adapter.label} default login in ${where(owner.home)}, but the default login now uses ${where(home)}. Restore ${adapter.accounts?.homeVariable ?? "it"} ${remedy}.`, "PROVIDER_ACCOUNT_UNAVAILABLE");
    }
    return { id: account.id, provider: account.provider, label: account.label, homePath: account.homePath, home, identity: identitySummary(account) };
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
    // Windows are filed under the account and home the run launched with.
    recordLimits(account, runId, windows) {
      if (!windows?.length) return;
      try { database.recordProviderLimits({ accountId: account.id, provider: account.provider, home: account.home ?? null }, runId, windows, new Date(clock()).toISOString()); }
      catch (error) { if (error.statusCode !== 507) throw error; return; }
      notify();
    },
    // Stops queued and running identity checks and waits for their probes.
    async close() {
      closing.abort();
      if (notifyTimer) clearTimeout(notifyTimer);
      notifyTimer = null;
      await Promise.allSettled([...pendingChecks.values()]);
      if (cleanupErrors.size) throw new AggregateError([...cleanupErrors.values()], "Account login check cleanup could not be verified");
    },
  };
}
