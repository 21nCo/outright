// Presentation helpers for the runtime's provider snapshot. The runtime
// remains the authority: it rejects unsupported settings before queueing.
const POLICY_LABELS = { "read-only": "Read only", "workspace-write": "Workspace write", "danger-full-access": "Full access" };

export const APPROVAL_POLICY_OPTIONS = Object.entries(POLICY_LABELS).map(([value, label]) => ({ value, label }));

export function providerReady(provider) {
  return provider?.available === true && provider.compatible === true;
}

export function providerOptionLabel(provider) {
  if (providerReady(provider) || provider.checking) return provider.label;
  return `${provider.label} (${provider.available ? "unsupported version" : "unavailable"})`;
}

export function providerStatusText(provider) {
  if (!provider) return "This provider is not supported by this Outright runtime.";
  if (provider.checking) return `Checking ${provider.label}…`;
  if (!providerReady(provider)) return provider.reason || `${provider.label} is not available.`;
  const capabilities = provider.capabilities ?? {};
  const authority = provider.kind === "direct-provider" ? `Outright-managed via ${provider.authority?.variable}` : "uses its own CLI login";
  const policies = (capabilities.permissionModes ?? []).map((policy) => POLICY_LABELS[policy] ?? policy).join(", ");
  return `${provider.label} ${provider.version} · ${authority} · ${policies}${capabilities.resume ? " · resumable sessions" : " · no session resume"}`;
}

export function supportsPolicy(provider, policy) {
  return !provider?.capabilities || provider.capabilities.permissionModes.includes(policy);
}

export function reasoningOptions(provider) {
  return provider?.capabilities?.reasoningEfforts ?? ["low", "medium", "high", "xhigh"];
}

// A provider switch never changes another choice. Choices the selected
// provider cannot honour stay visible and block saving until the user picks
// supported ones; these explain why.
export function unsupportedChoices(provider, draft) {
  const choices = [];
  if (!supportsPolicy(provider, draft.approvalPolicy)) choices.push(`the ${POLICY_LABELS[draft.approvalPolicy] ?? draft.approvalPolicy} approval policy`);
  if (provider?.capabilities && !reasoningOptions(provider).includes(draft.reasoningEffort)) choices.push(`${draft.reasoningEffort} reasoning effort`);
  return choices.length ? `${provider.label} does not support ${choices.join(" or ")}; choose a supported value before saving.` : "";
}

// A model belongs to the adapter it was chosen for: a shared vendor does not
// make one adapter's names, such as Claude Code's aliases, valid for another.
// After a provider switch it is kept only when the new adapter lists it.
export function modelMismatch(providers, draft, opened) {
  if (!draft.model || draft.model !== opened.model || draft.provider === opened.provider) return "";
  const source = providers.find((item) => item.id === opened.provider);
  const target = providers.find((item) => item.id === draft.provider);
  if (!target || target.models?.includes(draft.model)) return "";
  return `The model “${draft.model}” was chosen for ${source?.label ?? opened.provider}; choose a ${target.label} model or clear it to use the provider default before saving.`;
}
