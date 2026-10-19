// Display text for provider accounts. Measured usage comes from Outright's
// own run records; limits are what a provider reported, with their age.
// An unknown value is said to be unknown, never shown as zero.

const WINDOW_LABELS = {
  five_hour: "5-hour limit",
  seven_day: "7-day limit",
  seven_day_opus: "7-day Opus limit",
  seven_day_sonnet: "7-day Sonnet limit",
};

const defaultTime = (value) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));

export function loginText(login) {
  if (!login || login.status === "checking") return "Checking login…";
  const identity = login.identity ?? {};
  const details = [identity.email, identity.organization, identity.plan, identity.method].filter(Boolean);
  if (login.status === "signed-in") return details.length ? `Signed in · ${details.join(" · ")}` : "Signed in";
  if (login.status === "signed-out") return "Signed out";
  if (login.status === "configured") return identity.variable ? `Uses ${identity.variable} from the environment` : "Credential configured";
  if (login.status === "unavailable") return login.error || "Credential not configured";
  return login.error || "Login could not be checked";
}

export function limitWindowLabel(window) {
  return WINDOW_LABELS[window] ?? `${String(window).replaceAll("_", " ")} limit`;
}

export function limitText(limit, formatTime = defaultTime) {
  const resets = limit.resetsAt ? `resets ${formatTime(limit.resetsAt)}` : "reset time not reported";
  if (limit.state === "reset") return `Reset ${formatTime(limit.resetsAt)}; no report since`;
  const used = limit.utilization == null ? "usage not reported" : `${Math.round(limit.utilization * 100)}% used`;
  const reached = limit.status === "rejected" ? "limit reached · " : "";
  const age = limit.state === "stale" ? ` as of ${formatTime(limit.observedAt)} (stale)` : "";
  return `${reached}${used}${age} · ${resets}`;
}

// A limit as of `now`. The listing was aged when the runtime sent it; an
// open Settings dialog ages it again as time passes, so a reset window's old
// usage is withheld and an old report is marked stale.
export function ageLimit(limit, now, staleAfterMs) {
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
  if (limit.state === "reset" || (Number.isFinite(resetsAt) && resetsAt <= now)) return { ...limit, utilization: null, status: null, state: "reset" };
  return { ...limit, state: now - Date.parse(limit.observedAt) > staleAfterMs ? "stale" : "current" };
}

// When a listing next changes with time alone, or null: a limit resets or
// turns stale, or a run leaves a measured window.
export function nextListingChange(listing, now) {
  let next = Number.POSITIVE_INFINITY;
  const consider = (at) => { if (Number.isFinite(at) && at > now) next = Math.min(next, at); };
  for (const provider of listing?.providers ?? []) {
    for (const account of provider.accounts ?? []) {
      for (const limit of account.limits ?? []) {
        consider(limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN);
        consider(Date.parse(limit.observedAt) + listing.limitStaleAfterMs + 1);
      }
      for (const period of account.measured ?? []) consider(period.changesAt ? Date.parse(period.changesAt) : Number.NaN);
    }
  }
  return Number.isFinite(next) ? next : null;
}

// The runtime's time for a listing received at `receivedAt`, so a client
// clock that differs from the runtime's ages nothing early or late.
export function listingTime(listing, receivedAt, now) {
  const generatedAt = Date.parse(listing?.generatedAt);
  return Number.isFinite(generatedAt) && Number.isFinite(receivedAt) ? generatedAt + (now - receivedAt) : now;
}

// A measured window changes when its oldest run leaves it. Past that time,
// until a listing is loaded again, its totals are out of date and say when
// they were measured.
export function measuredPeriodText(period, now, generatedAt, formatTime = defaultTime) {
  const changesAt = period.changesAt ? Date.parse(period.changesAt) : Number.NaN;
  if (!(changesAt <= now)) return measuredText(period);
  return `${measuredText(period)} as of ${formatTime(generatedAt)} (out of date: a run has left this window since; reloading)`;
}

// Whether any measured window in a listing has passed its change time, so
// the dialog keeps retrying until a reload succeeds.
export function listingOutOfDate(listing, now) {
  return (listing?.providers ?? []).some((provider) => (provider.accounts ?? []).some((account) => (account.measured ?? [])
    .some((period) => period.changesAt && Date.parse(period.changesAt) <= now)));
}

export function measuredText(period) {
  if (!period.runs) return "No runs";
  const runs = `${period.runs} run${period.runs === 1 ? "" : "s"}`;
  // A run that reported no tokens is not counted as zero tokens, and one
  // that reported only input or output makes the sum a lower bound.
  const missingTokens = Number(period.runsWithoutTokens ?? 0);
  const partialTokens = Number(period.runsWithPartialTokens ?? 0);
  const reported = Number(period.inputTokens ?? 0) + Number(period.outputTokens ?? 0);
  const incomplete = [missingTokens && `${missingTokens} without reported tokens`, partialTokens && `${partialTokens} with partial token counts`].filter(Boolean);
  let tokens = `${reported.toLocaleString()} tokens`;
  if (missingTokens >= period.runs) tokens = "tokens not reported";
  else if (incomplete.length) tokens = `at least ${reported.toLocaleString()} tokens (${incomplete.join(", ")})`;
  const without = period.runsWithoutCost ? ` (${period.runsWithoutCost} without reported cost)` : "";
  const cost = period.costUsd == null ? "cost not reported" : `$${Number(period.costUsd).toFixed(3)} reported${without}`;
  return `${runs} · ${tokens} · ${cost}`;
}

// The account a run launched with, as recorded when it launched.
export function runAccountText(run) {
  if (!run?.accountLabel) return null;
  return run.accountIdentity ? `${run.accountLabel} (${run.accountIdentity})` : run.accountLabel;
}

// An answer carries its run's account, so every page of history names it.
// A loaded run is the fallback for an answer written without one.
export function answerAccountText(message, runAccounts) {
  const account = message.payload?.account;
  if (typeof account?.label === "string" && account.label) return runAccountText({ accountLabel: account.label, accountIdentity: account.identity });
  return runAccounts.get(message.payload?.runId) ?? null;
}
