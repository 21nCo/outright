import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ageLimit, limitText, limitWindowLabel, listingOutOfDate, listingTime, loginText, measuredPeriodText, nextListingChange } from "@/lib/provider-accounts";
import { api } from "@/lib/runtime-api";

// Account changes arrive as `accountsVersion`, not through the shared
// runtime event, so they never displace another pane's event.
const REFRESH_EVENTS = ["runtime.connected", "run.event"];
// A time-driven reload waits at least this long, so it can never spin.
const MIN_RELOAD_MS = 1_000;
// An out-of-date listing whose reload failed is tried again this often.
const RETRY_RELOAD_MS = 15_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

// Account inventory in Settings. Each action applies immediately, like
// template and history actions; the settings draft is not involved.
export function ProviderAccounts({ open, runtimeEvent, accountsVersion = 0, onError }) {
  const [listing, setListing] = useState(null);
  const [busy, setBusy] = useState(null);
  const busyRef = useRef(false);
  const [message, setMessage] = useState({ status: "", alert: "" });
  const [draft, setDraft] = useState({ provider: "", label: "", homePath: "" });
  const [pendingRemove, setPendingRemove] = useState(null);
  // Closing Settings drops loads in flight; the shown listing's revision
  // keeps any response from replacing a listing computed after it.
  const generationRef = useRef(0);
  const shownRef = useRef(null);
  const cancelRemoveRef = useRef(null);
  const removeTriggerRef = useRef(null);
  const nameInputRef = useRef(null);
  const sectionRef = useRef(null);
  // A switched account's Use button disappears; focus continues on its Check.
  const focusCheckRef = useRef(null);
  const restoreRemoveFocusRef = useRef(false);
  // Every time-windowed value ages while Settings stays open: when a limit
  // resets or turns stale, or a run leaves a measured window, and on
  // returning to a hidden tab, the listing is loaded again.
  const [now, setNow] = useState(() => Date.now());

  function show(value, beforeShow) {
    const next = receivedListing(value);
    if (isOlderListing(next, shownRef.current)) return;
    beforeShow?.();
    shownRef.current = next;
    setListing(next);
  }
  function load() {
    const generation = generationRef.current;
    return api("/api/provider-accounts").then((value) => { if (generation === generationRef.current) show(value); });
  }
  useEffect(() => {
    if (!open) { generationRef.current += 1; return; }
    setMessage({ status: "", alert: "" });
    setPendingRemove(null);
    load().catch(onError);
  }, [open, onError]);
  useEffect(() => {
    if (open && runtimeEvent && REFRESH_EVENTS.includes(runtimeEvent.type)) load().catch(onError);
  }, [open, runtimeEvent, onError]);
  useEffect(() => {
    if (open && accountsVersion) load().catch(onError);
  }, [open, accountsVersion, onError]);
  useEffect(() => { if (open) setNow(Date.now()); }, [open, listing]);
  useEffect(() => {
    if (!open || !listing) return undefined;
    // Limits age in place if the reload fails, and the next change is still
    // scheduled. Measured totals need the runtime: past a window's change
    // they are marked out of date and the reload is retried until it
    // succeeds. A hidden tab reloads when it is shown again.
    const reload = () => {
      setNow(Date.now());
      if (document.visibilityState !== "hidden") load().catch(onError);
    };
    const runtimeNow = listingTime(listing, listing.receivedAt, Date.now());
    const changes = [nextListingChange(listing, runtimeNow), listingOutOfDate(listing, runtimeNow) ? runtimeNow + RETRY_RELOAD_MS : null].filter((at) => at !== null);
    const next = changes.length ? Math.min(...changes) : null;
    const timer = next === null ? null : setTimeout(reload, Math.min(Math.max(next - runtimeNow, MIN_RELOAD_MS), MAX_TIMEOUT_MS));
    const visible = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [open, listing, now, onError]);
  useLayoutEffect(() => {
    if (pendingRemove) cancelRemoveRef.current?.focus();
    else if (restoreRemoveFocusRef.current) {
      restoreRemoveFocusRef.current = false;
      // A removed account's row is gone; continue from the add form.
      (removeTriggerRef.current?.isConnected ? removeTriggerRef.current : nameInputRef.current)?.focus();
    }
  }, [pendingRemove]);

  useLayoutEffect(() => {
    const accountId = focusCheckRef.current;
    if (!accountId) return;
    focusCheckRef.current = null;
    [...(sectionRef.current?.querySelectorAll("[data-account-check]") ?? [])].find((button) => button.dataset.accountCheck === accountId)?.focus();
  }, [listing]);

  const switchable = listing?.providers.filter((provider) => provider.switchable) ?? [];
  const addProvider = switchable.find((provider) => provider.provider === draft.provider) ?? switchable[0];

  // Controls stay focusable while busy (aria-disabled) so keyboard focus is
  // never dropped; a second action is ignored until the first settles.
  // `beforeUpdate` runs only if the action's listing is shown, and a
  // `success` function words its message from the listing that is shown.
  async function act(key, request, success, beforeUpdate) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(key);
    setMessage({ status: "", alert: "" });
    try {
      const value = await request();
      // Loads still in flight are kept: one computed after this action is newer.
      show(value, beforeUpdate);
      setMessage({ status: typeof success === "function" ? success(shownRef.current) : success, alert: "" });
      return true;
    } catch (error) {
      // The runtime's message names the account and the next step; the
      // active account is unchanged after a failed switch.
      setMessage({ status: "", alert: error.message });
      return false;
    } finally { busyRef.current = false; setBusy(null); }
  }

  async function activate(provider, account, trigger) {
    await act(`activate:${account.id}`, () => api("/api/provider-accounts/active", { method: "PUT", body: { provider: provider.provider, accountId: account.id } }),
      (shown) => {
        // A change made after this switch may have made another account active.
        const active = shown?.providers.find((entry) => entry.provider === provider.provider)?.accounts.find((entry) => entry.active);
        return !active || active.id === account.id ? `${provider.label} now starts new sessions with ${account.label}.`
          : `Switched to ${account.label}, but a later change made ${active.label} active for new ${provider.label} sessions.`;
      },
      // Focus follows only if it is still on Use, or was lost when Use left.
      () => {
        const focused = document.activeElement;
        if (focused === trigger || (!trigger.isConnected && (!focused || focused === document.body))) focusCheckRef.current = account.id;
      });
  }
  async function add(event) {
    event.preventDefault();
    const submitted = { provider: addProvider.provider, label: draft.label, homePath: draft.homePath };
    const added = await act("add", () => api("/api/provider-accounts", { method: "POST", body: submitted }),
      `Added ${submitted.label.trim()} to ${addProvider.label}.`);
    // Only the submitted draft is cleared; one edited while it was added stays.
    if (added) setDraft((current) => current.label === submitted.label && current.homePath === submitted.homePath && (current.provider || submitted.provider) === submitted.provider
      ? { provider: submitted.provider, label: "", homePath: "" } : current);
  }
  async function remove() {
    if (busy) return;
    const { provider, account } = pendingRemove;
    restoreRemoveFocusRef.current = true;
    await act(`remove:${account.id}`, () => api(`/api/provider-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }),
      `Removed ${account.label} from ${provider.label}. Its directory and login are unchanged.`);
    setPendingRemove(null);
  }

  const blocked = Boolean(busy) || undefined;
  const runtimeNow = listing ? listingTime(listing, listing.receivedAt, now) : now;
  return <section ref={sectionRef} className="template-settings provider-accounts" aria-labelledby="provider-accounts-heading" aria-busy={busy ? true : undefined}>
    <header><div><h3 id="provider-accounts-heading">Provider accounts</h3><small>New sessions launch with the active account. Running runs, and chats that already have a session, keep the account they started with. Outright stores each account's directory, never its credentials.</small></div></header>
    {!listing && <p className="capacity-status">Loading accounts…</p>}
    {listing?.providers.map((provider) => <div key={provider.provider} className="template-list account-list" role="group" aria-label={`${provider.label} accounts`}>
      {provider.accounts.map((account) => <div key={account.id}><span>
        <strong>{provider.label} · {account.label}{account.active ? " (active)" : ""}</strong>
        <small title={account.homePath ?? undefined}>{loginText(account.login)}{account.homePath ? ` · ${account.homePath}` : ""}</small>
        {account.sameAsDefault && <small>This directory is now the default login's. Use Default login for new sessions; chats with a session on {account.label} keep it.</small>}
        {account.measured.map((period) => <small key={period.period}>Measured by Outright, {period.label.toLowerCase()}: {measuredPeriodText(period, runtimeNow, listing.generatedAt)}</small>)}
        <small>{accountLimitsText(provider, account, runtimeNow, listing.limitStaleAfterMs)}</small>
      </span><span className="account-actions">
        {provider.switchable && !account.active && !account.sameAsDefault && <Button variant="outline" size="sm" aria-disabled={blocked} onClick={(event) => activate(provider, account, event.currentTarget)}
          aria-label={`Use ${account.label} for new ${provider.label} sessions`}>Use</Button>}
        <Button variant="ghost" size="sm" aria-disabled={blocked} data-account-check={account.id} aria-label={`Check ${provider.label} account ${account.label}`}
          onClick={() => act(`refresh:${account.id}`, () => api(`/api/provider-accounts/${encodeURIComponent(account.id)}/refresh`, { method: "POST" }), `Checked ${account.label}.`)}>Check</Button>
        {!account.isDefault && <Button variant="ghost" size="sm" disabled={account.active} aria-disabled={blocked}
          aria-label={`Remove ${provider.label} account ${account.label}${account.active ? " (switch to another account first)" : ""}`}
          onClick={(event) => { if (busy) return; removeTriggerRef.current = event.currentTarget; setPendingRemove({ provider, account }); }}>Remove</Button>}
      </span></div>)}
    </div>)}
    {pendingRemove && <fieldset className="archive-delete-confirm"><legend className="sr-only">Confirm account removal</legend><p>Remove {pendingRemove.account.label} from {pendingRemove.provider.label}? Its directory and login stay on disk. Chats whose session belongs to it cannot continue that session.</p><div><Button ref={cancelRemoveRef} variant="outline" aria-disabled={blocked} onClick={() => { if (busy) return; restoreRemoveFocusRef.current = true; setPendingRemove(null); }}>Cancel</Button><Button variant="destructive" aria-disabled={blocked} onClick={remove}>Remove account</Button></div></fieldset>}
    {addProvider && <form className="new-template new-account" onSubmit={add}>
      <select aria-label="Account provider" value={addProvider.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })}>{switchable.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.label}</option>)}</select>
      <Input ref={nameInputRef} aria-label="Account name" value={draft.label} maxLength={80} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Account name" />
      <Input aria-label={`${addProvider.homeVariable} directory`} aria-describedby="provider-account-help" value={draft.homePath} onChange={(event) => setDraft({ ...draft, homePath: event.target.value })} placeholder={`${addProvider.homeVariable} directory`} />
      <Button type="submit" variant="outline" aria-disabled={blocked} disabled={!draft.label.trim() || !draft.homePath.trim()}>Add account</Button>
    </form>}
    {addProvider && <small id="provider-account-help" className="account-help">Sign in to the account from a terminal first, with {addProvider.homeVariable} set to its directory. Outright checks the login before switching.</small>}
    <p className="sr-only" role="status" aria-live="polite">{message.status}</p>
    {message.alert && <p className="account-error" role="alert">{message.alert}</p>}
  </section>;
}

// An older runtime has no account routes; show no accounts rather than fail.
// The receipt time maps the client's clock onto the runtime's.
function receivedListing(value) {
  return { ...(Array.isArray(value?.providers) ? value : { providers: [] }), receivedAt: Date.now() };
}

// Listings from one runtime are ordered by their revision; one without a
// revision, or from another runtime (a restart), is taken as it arrives.
function isOlderListing(next, shown) {
  const [a, b] = [next?.revision, shown?.revision];
  return Boolean(a && b && a.runtime === b.runtime && Number.isFinite(a.sequence) && Number.isFinite(b.sequence) && a.sequence < b.sequence);
}

function accountLimitsText(provider, account, now, staleAfterMs) {
  if (!provider.usageLimits) return `Provider limits: unavailable, ${provider.label} does not report them`;
  if (!account.limits.length) return "Provider limits: not reported yet";
  return `Reported by ${provider.label}: ${account.limits.map((limit) => `${limitWindowLabel(limit.window)} ${limitText(ageLimit(limit, now, staleAfterMs))}`).join("; ")}`;
}
