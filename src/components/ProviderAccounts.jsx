import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { limitText, limitWindowLabel, loginText, measuredText } from "@/lib/provider-accounts";
import { api } from "@/lib/runtime-api";

const REFRESH_EVENTS = ["provider-accounts.changed", "runtime.connected", "run.event"];

// Account inventory in Settings. Each action applies immediately, like
// template and history actions; the settings draft is not involved.
export function ProviderAccounts({ open, runtimeEvent, onError }) {
  const [listing, setListing] = useState(null);
  const [busy, setBusy] = useState(null);
  const busyRef = useRef(false);
  const [message, setMessage] = useState({ status: "", alert: "" });
  const [draft, setDraft] = useState({ provider: "", label: "", homePath: "" });
  const [pendingRemove, setPendingRemove] = useState(null);
  const requestRef = useRef(0);
  const cancelRemoveRef = useRef(null);
  const removeTriggerRef = useRef(null);
  const nameInputRef = useRef(null);
  const sectionRef = useRef(null);
  // A switched account's Use button disappears; focus continues on its Check.
  const focusCheckRef = useRef(null);
  const restoreRemoveFocusRef = useRef(false);

  function load() {
    const request = ++requestRef.current;
    return api("/api/provider-accounts").then((value) => { if (request === requestRef.current) setListing(validListing(value)); });
  }
  useEffect(() => {
    if (!open) { requestRef.current += 1; return; }
    setMessage({ status: "", alert: "" });
    setPendingRemove(null);
    load().catch(onError);
  }, [open, onError]);
  useEffect(() => {
    if (open && runtimeEvent && REFRESH_EVENTS.includes(runtimeEvent.type)) load().catch(onError);
  }, [open, runtimeEvent, onError]);
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
  async function act(key, request, success, beforeUpdate) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(key);
    setMessage({ status: "", alert: "" });
    try {
      const value = await request();
      beforeUpdate?.();
      requestRef.current += 1;
      setListing(validListing(value));
      setMessage({ status: success, alert: "" });
      return true;
    } catch (error) {
      // The runtime's message names the account and the next step; the
      // active account is unchanged after a failed switch.
      setMessage({ status: "", alert: error.message });
      return false;
    } finally { busyRef.current = false; setBusy(null); }
  }

  async function activate(provider, account) {
    const focused = document.activeElement;
    await act(`activate:${account.id}`, () => api("/api/provider-accounts/active", { method: "PUT", body: { provider: provider.provider, accountId: account.id } }),
      `${provider.label} now starts new sessions with ${account.label}.`,
      () => { if (sectionRef.current?.contains(focused)) focusCheckRef.current = account.id; });
  }
  async function add(event) {
    event.preventDefault();
    const added = await act("add", () => api("/api/provider-accounts", { method: "POST", body: { provider: addProvider.provider, label: draft.label, homePath: draft.homePath } }),
      `Added ${draft.label.trim()} to ${addProvider.label}.`);
    if (added) setDraft({ provider: addProvider.provider, label: "", homePath: "" });
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
  return <section ref={sectionRef} className="template-settings provider-accounts" aria-labelledby="provider-accounts-heading" aria-busy={busy ? true : undefined}>
    <header><div><h3 id="provider-accounts-heading">Provider accounts</h3><small>New sessions launch with the active account. Running runs, and chats that already have a session, keep the account they started with. Outright stores each account's directory, never its credentials.</small></div></header>
    {!listing && <p className="capacity-status">Loading accounts…</p>}
    {listing?.providers.map((provider) => <div key={provider.provider} className="template-list account-list" role="group" aria-label={`${provider.label} accounts`}>
      {provider.accounts.map((account) => <div key={account.id}><span>
        <strong>{provider.label} · {account.label}{account.active ? " (active)" : ""}</strong>
        <small title={account.homePath ?? undefined}>{loginText(account.login)}{account.homePath ? ` · ${account.homePath}` : ""}</small>
        {account.measured.map((period) => <small key={period.period}>Measured by Outright, {period.label.toLowerCase()}: {measuredText(period)}</small>)}
        <small>{accountLimitsText(provider, account)}</small>
      </span><span className="account-actions">
        {provider.switchable && !account.active && <Button variant="outline" size="sm" aria-disabled={blocked} onClick={() => activate(provider, account)}
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
function validListing(value) {
  return Array.isArray(value?.providers) ? value : { providers: [] };
}

function accountLimitsText(provider, account) {
  if (!provider.usageLimits) return `Provider limits: unavailable, ${provider.label} does not report them`;
  if (!account.limits.length) return "Provider limits: not reported yet";
  return `Reported by ${provider.label}: ${account.limits.map((limit) => `${limitWindowLabel(limit.window)} ${limitText(limit)}`).join("; ")}`;
}
