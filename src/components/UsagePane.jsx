import { useEffect, useState } from 'react';
import { api } from '@/lib/runtime-api';

const VIEW_ID = 'subset.usage.dashboard@1';
const VIEW_ORIGIN = 'http://127.0.0.1:4174';

export function UsagePane() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try { setResult(await api('/api/subset/usage')); }
    catch { setResult({ available: false, error: 'Could not read Subset usage.' }); }
    finally { setLoading(false); }
  }

  useEffect(() => { refresh(); }, []);

  const registered = result?.available && result.viewId === VIEW_ID && result.structuredContent?.schemaVersion === 1;
  return <section className="subset-usage-pane" aria-label="Codex usage">
    <div className="subset-usage-toolbar"><h2>Codex usage</h2><button type="button" onClick={refresh} disabled={loading}>{loading ? 'Checking…' : 'Refresh'}</button></div>
    {loading && !result && <p role="status">Checking Codex usage…</p>}
    {!loading && !registered && <p role="status">{result?.error ?? 'Codex usage is unavailable.'}</p>}
    {registered && <><details className="subset-usage-fallback"><summary>Text status</summary><pre>{result.text}</pre></details><iframe key={result.structuredContent.generatedAt} title="Subset Codex usage dashboard" src={`${VIEW_ORIGIN}/?embedded=1`} onLoad={(event) => event.currentTarget.contentWindow?.postMessage({ viewId: VIEW_ID, status: result.structuredContent }, VIEW_ORIGIN)} /></>}
  </section>;
}
