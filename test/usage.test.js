const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const usage = require('../usage');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const assistant = (u, extra = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', usage: u }, ...extra });

test('used tokens = input + cache read + cache creation of the last main-chain request', () => {
  const r = usage.scan(fixture('session-part1.jsonl'));
  assert.deepEqual(r, { ctx: 3 + 20000 + 1200, ctxModel: 'claude-opus-5-5' });
});

test('sidechain messages are skipped; requestedModel wins over message.model', () => {
  const r = usage.scan(fixture('session-part2.jsonl'));
  assert.deepEqual(r, { ctx: 5 + 40000 + 3000, ctxModel: 'claude-opus-5-5[1m]' });
});

test('a compact boundary gives the post-compaction size until the next real assistant message', () => {
  const text = fixture('session-compacted.jsonl');
  // The <synthetic> message after the boundary doesn't count.
  assert.deepEqual(usage.scan(text), { ctx: 12500 });
  const after = text + assistant({ input_tokens: 4, cache_read_input_tokens: 13000, cache_creation_input_tokens: 600 }) + '\n';
  assert.deepEqual(usage.scan(after), { ctx: 13604, ctxModel: 'claude-opus-5-5' });
});

test('nothing to say: no usage, zero usage, or broken lines', () => {
  assert.equal(usage.scan(''), undefined);
  assert.equal(usage.scan('{"type":"user","message":{"role":"user","content":"hi"}}\n'), undefined);
  assert.equal(usage.scan(assistant({ input_tokens: 0 }) + '\n'), undefined);
  assert.equal(usage.scan('{"type":"assistant","usage" broken\n'), undefined);
});

test('window rule: [1m] → 1M, Claude 3/4 → 200K, newer → 1M, never less than in use', () => {
  assert.equal(usage.contextWindow('claude-sonnet-4-5[1m]'), 1e6);
  assert.equal(usage.contextWindow('claude-opus-4-1'), 200000);
  assert.equal(usage.contextWindow('claude-sonnet-4-5'), 200000);
  assert.equal(usage.contextWindow('claude-3-5-haiku'), 200000);
  assert.equal(usage.contextWindow('claude-opus-5-5'), 1e6);
  assert.equal(usage.contextWindow(''), 1e6);
  assert.equal(usage.contextWindow('claude-sonnet-4-5', 250000), 1e6);
});

test('forPayload: [used, window], with an explicit override', () => {
  assert.equal(usage.forPayload({}), undefined);
  assert.equal(usage.forPayload(undefined), undefined);
  assert.deepEqual(usage.forPayload({ ctx: 50000, ctxModel: 'claude-sonnet-4-5' }, 0), [50000, 200000]);
  assert.deepEqual(usage.forPayload({ ctx: 50000, ctxModel: 'claude-sonnet-4-5' }, 400000), [50000, 400000]);
});

const at = (iso) => ({ timestamp: iso });
const created = (h1, m5) => ({ input_tokens: 3, cache_read_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } });

test('cacheScan: the latest main-chain reply sets the time; its cache_creation the TTL', () => {
  const text = [
    assistant(created(0, 500), at('2026-11-02T10:00:00Z')),
    assistant(created(800, 0), at('2026-11-02T10:05:00Z')),
    JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2026-11-02T10:06:00Z' }),
  ].join('\n') + '\n';
  assert.deepEqual(usage.cacheScan(text), { cacheAt: Date.parse('2026-11-02T10:05:00Z'), cacheTtl: '1h' });
});

test('cacheScan: a reply that created nothing takes its TTL from an earlier one, or from earlier chunks', () => {
  const text = [assistant(created(0, 900), at('2026-11-02T10:00:00Z')), assistant(created(0, 0), at('2026-11-02T10:03:00Z'))].join('\n');
  assert.deepEqual(usage.cacheScan(text), { cacheAt: Date.parse('2026-11-02T10:03:00Z'), cacheTtl: '5m' });
  const later = assistant({ input_tokens: 2, cache_read_input_tokens: 50 }, at('2026-11-02T11:00:00Z'));
  assert.deepEqual(usage.cacheScan(later, { cacheAt: 1, cacheTtl: '1h' }), { cacheAt: Date.parse('2026-11-02T11:00:00Z'), cacheTtl: '1h' });
  assert.deepEqual(usage.cacheScan(later), { cacheAt: Date.parse('2026-11-02T11:00:00Z'), cacheTtl: '' }); // unknown
});

test('cacheScan: subagent (sidechain) and synthetic replies, and lines without usage, do not count', () => {
  const text = [
    assistant(created(0, 400), at('2026-11-02T09:00:00Z')),
    assistant(created(700, 0), { isSidechain: true, timestamp: '2026-11-02T09:30:00Z' }),
    JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-11-02T09:40:00Z', message: { model: '<synthetic>', usage: created(9, 0) } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-11-02T09:50:00Z', message: { model: 'm' } }),
  ].join('\n');
  assert.deepEqual(usage.cacheScan(text), { cacheAt: Date.parse('2026-11-02T09:00:00Z'), cacheTtl: '5m' });
  assert.equal(usage.cacheScan(JSON.stringify({ type: 'user', timestamp: '2026-11-02T09:00:00Z' })), undefined);
  assert.equal(usage.cacheScan(''), undefined);
  assert.equal(usage.cacheScan('{not json "type":"assistant" "usage"'), undefined);
});

test('coldAt: the reply time plus 1 h or 5 min; unknown counts as 5 min; nothing without a time', () => {
  assert.equal(usage.coldAt({ cacheAt: 1000, cacheTtl: '1h' }), 1000 + 3600000);
  assert.equal(usage.coldAt({ cacheAt: 1000, cacheTtl: '5m' }), 1000 + 300000);
  assert.equal(usage.coldAt({ cacheAt: 1000, cacheTtl: '' }), 1000 + 300000);
  assert.equal(usage.coldAt({}), 0);
  assert.equal(usage.coldAt(undefined), 0);
});
