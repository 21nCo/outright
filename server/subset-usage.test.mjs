import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSubsetUsage } from './subset-usage.mjs';

const valid = { schemaVersion: 1, viewId: 'subset.usage.dashboard@1', generatedAt: '2026-09-29T00:00:00Z', accounts: [
  { id: 'personal', label: 'Personal', state: 'ok', observedAt: '2026-09-29T00:00:00Z', windows: [{ label: 'Codex', remainingPercent: 60 }] }
] };

test('returns a registered view and structured fallback from a valid Subset response', async () => {
  const result = await readSubsetUsage(async () => ({ ok: true, json: async () => valid }));
  assert.equal(result.available, true);
  assert.equal(result.viewId, valid.viewId);
  assert.equal(result.structuredContent, valid);
  assert.match(result.text, /Personal.*60% remaining/);
});

test('rejects an unregistered view and malformed account data', async () => {
  for (const status of [{ ...valid, viewId: 'model.generated.html' }, { ...valid, accounts: [{ label: '<script>' }] }]) {
    const result = await readSubsetUsage(async () => ({ ok: true, json: async () => status }));
    assert.equal(result.available, false);
    assert.equal(result.structuredContent, undefined);
  }
});

test('keeps local source failure as a usable error', async () => {
  const result = await readSubsetUsage(async () => { throw new Error('private server detail'); });
  assert.equal(result.available, false);
  assert.equal(JSON.stringify(result).includes('private server detail'), false);
});
