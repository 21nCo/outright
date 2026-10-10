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

// A provider switch keeps only choices the new provider can honour; the
// adjusted values stay visible in the form before anything is saved.
export function withProvider(draft, providers, id) {
  const provider = providers.find((item) => item.id === id);
  const next = { ...draft, provider: id };
  if (!supportsPolicy(provider, next.approvalPolicy)) next.approvalPolicy = provider.capabilities.permissionModes[0];
  const efforts = reasoningOptions(provider);
  if (!efforts.includes(next.reasoningEffort)) next.reasoningEffort = efforts.includes("medium") ? "medium" : efforts[0];
  return next;
}
