import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSubsetUsageMcpServer } from './subset-usage-mcp.mjs';

test('agent tool returns the registered view contract and a readable fallback', async () => {
  const status = { schemaVersion: 1, viewId: 'subset.usage.dashboard@1', accounts: [{ id: 'a', label: 'A' }] };
  const server = createSubsetUsageMcpServer(async () => ({ available: true, viewId: status.viewId, structuredContent: status, text: 'A: usage available' }));
  const result = await server.registry.callTool('subset_usage_status', {}, undefined, {});
  assert.deepEqual(result.structuredContent, { available: true, viewId: status.viewId, status });
  assert.equal(result.content[0].text, 'A: usage available');
  await server.close();
});

test('agent tool keeps service failures usable without inventing usage', async () => {
  const server = createSubsetUsageMcpServer(async () => ({ available: false, error: 'Subset usage is not running on this computer.' }));
  const result = await server.registry.callTool('subset_usage_status', {}, undefined, {});
  assert.deepEqual(result.structuredContent, { available: false, error: 'Subset usage is not running on this computer.' });
  assert.equal(result.content[0].text, result.structuredContent.error);
  await server.close();
});
