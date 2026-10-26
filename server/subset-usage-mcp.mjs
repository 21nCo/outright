import { McpFnRegistry, createMcpFnServer, structuredResult } from '@mcpfn/core';
import { pathToFileURL } from 'node:url';
import { readSubsetUsage } from './subset-usage.mjs';

export function createSubsetUsageMcpServer(read = readSubsetUsage) {
  const registry = new McpFnRegistry().register({
    name: 'subset_usage_status',
    description: 'Read Codex usage windows for locally configured ChatGPT accounts. Returns source, observation time, partial errors, structured status, and a text fallback. The registered Outright view is subset.usage.dashboard@1.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async () => {
      const result = await read();
      if (!result.available) return structuredResult({ available: false, error: result.error }, [{ type: 'text', text: result.error }]);
      return structuredResult({ available: true, viewId: result.viewId, status: result.structuredContent }, [{ type: 'text', text: result.text }]);
    },
  });
  return createMcpFnServer({
    info: { name: 'outright-subset-usage', version: '0.0.1', instructions: 'The subset_usage_status tool is read-only. Its percentages describe Codex ChatGPT-account usage; remaining is calculated from provider-reported used percentage. Show the account, source, observation time, and errors. The Outright Usage inspector renders the registered Subset view.' },
    registry,
    transports: ['stdio'],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createSubsetUsageMcpServer().serveStdio();
}
