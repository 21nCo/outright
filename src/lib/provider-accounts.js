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
  if (login.status === "configured") return "Credential configured";
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

export function measuredText(period) {
  if (!period.runs) return "No runs";
  const tokens = Number(period.inputTokens ?? 0) + Number(period.outputTokens ?? 0);
  const runs = `${period.runs} run${period.runs === 1 ? "" : "s"}`;
  const without = period.runsWithoutCost ? ` (${period.runsWithoutCost} without reported cost)` : "";
  const cost = period.costUsd == null ? "cost not reported" : `$${Number(period.costUsd).toFixed(3)} reported${without}`;
  return `${runs} · ${tokens.toLocaleString()} tokens · ${cost}`;
}

// The account a run launched with, as recorded when it launched.
export function runAccountText(run) {
  if (!run?.accountLabel) return null;
  return run.accountIdentity ? `${run.accountLabel} (${run.accountIdentity})` : run.accountLabel;
}
