const SUBSET_URL = 'http://127.0.0.1:4174/api/status';
const VIEW_ID = 'subset.usage.dashboard@1';

export async function readSubsetUsage(fetcher = fetch) {
  let response;
  try { response = await fetcher(SUBSET_URL, { signal: AbortSignal.timeout(15000) }); }
  catch { return { available: false, error: 'Subset usage is not running on this computer.' }; }
  if (!response.ok) return { available: false, error: 'Subset usage could not read Codex status.' };
  let status;
  try { status = await response.json(); }
  catch { return { available: false, error: 'Subset usage returned invalid data.' }; }
  if (status?.schemaVersion !== 1 || status?.viewId !== VIEW_ID || !Array.isArray(status.accounts)
    || !status.accounts.every((account) => account && typeof account.id === 'string' && typeof account.label === 'string'
      && typeof account.state === 'string' && Array.isArray(account.windows)
      && account.windows.every((window) => window && typeof window.label === 'string'
        && (window.remainingPercent === null || typeof window.remainingPercent === 'number')))) {
    return { available: false, error: 'Subset usage returned an unsupported view contract.' };
  }
  const text = status.accounts.length
    ? status.accounts.map((account) => `${account.label}: ${account.state}; observed ${account.observedAt ?? 'never'}; ${account.windows?.map((window) => `${window.label} ${window.remainingPercent ?? 'unknown'}% remaining`).join(', ') || 'usage unavailable'}`).join('\n')
    : 'No Codex accounts are configured.';
  return { available: true, viewId: VIEW_ID, structuredContent: status, text };
}
