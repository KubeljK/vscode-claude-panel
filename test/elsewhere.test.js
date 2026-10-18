const test = require('node:test');
const assert = require('node:assert/strict');
const elsewhere = require('../elsewhere');

const NOW = 1_800_000_000_000;
const MIN = 60000;
const rec = (status, ago, extra = {}) => ({ sessionId: 's1', pid: 4242, status, statusUpdatedAt: NOW - ago, ...extra });

test('since: statusUpdatedAt, then updatedAt, then the fallback', () => {
  assert.equal(elsewhere.since({ statusUpdatedAt: 5, updatedAt: 9 }, 7), 5);
  assert.equal(elsewhere.since({ updatedAt: 9 }, 7), 9);
  assert.equal(elsewhere.since({}, 7), 7);
  assert.equal(elsewhere.since({ statusUpdatedAt: 'x' }, 0), 0);
  assert.equal(elsewhere.since(undefined, 3), 3);
});

test('active: busy, waiting and starting stay, however long ago their status changed', () => {
  for (const status of ['busy', 'waiting', 'starting', 'something new']) {
    assert.equal(elsewhere.active(rec(status, 48 * 60 * MIN), { now: NOW }), true, status);
  }
});

test('active: idle counts only for the cut-off, measured from when it went idle', () => {
  assert.equal(elsewhere.active(rec('idle', 59 * MIN), { now: NOW }), true);
  assert.equal(elsewhere.active(rec('idle', 61 * MIN), { now: NOW }), false);
  assert.equal(elsewhere.active(rec('idle', 3 * 60 * MIN), { now: NOW, hours: 4 }), true);
  assert.equal(elsewhere.active(rec('idle', 30 * MIN), { now: NOW, hours: 0.25 }), false);
});

test('active: falls back to updatedAt, then the transcript time', () => {
  const r = { sessionId: 's1', pid: 4242, status: 'idle', updatedAt: NOW - 2 * 60 * MIN };
  assert.equal(elsewhere.active(r, { now: NOW }), false);
  const bare = { sessionId: 's1', pid: 4242, status: 'idle' };
  assert.equal(elsewhere.active(bare, { now: NOW, mtime: NOW - 5 * MIN }), true);
  assert.equal(elsewhere.active(bare, { now: NOW, mtime: NOW - 5 * 60 * MIN }), false);
  assert.equal(elsewhere.active(bare, { now: NOW }), true, 'no time at all: kept, as before');
});

test('active: hours 0 or not a number keeps every one', () => {
  assert.equal(elsewhere.active(rec('idle', 30 * 24 * 60 * MIN), { now: NOW, hours: 0 }), true);
  assert.equal(elsewhere.active(rec('idle', 30 * 24 * 60 * MIN), { now: NOW, hours: undefined }), false, 'default 1h');
  assert.equal(elsewhere.active(rec('idle', 30 * 24 * 60 * MIN), { now: NOW, hours: 'x' }), true);
  assert.equal(elsewhere.active(rec('idle', 30 * 24 * 60 * MIN), { now: NOW, hours: -1 }), true);
});

test('active: an idle session with subagents still running stays', () => {
  assert.equal(elsewhere.active(rec('idle', 5 * 60 * MIN), { now: NOW, agents: 2 }), true);
});

test('active: no record, not running', () => {
  assert.equal(elsewhere.active(undefined, { now: NOW }), false);
});

test('where: the Claude desktop app, nothing for the CLI or unknown entrypoints', () => {
  assert.equal(elsewhere.where(rec('idle', 0, { entrypoint: 'claude-desktop' })), 'app');
  assert.equal(elsewhere.where(rec('idle', 0, { entrypoint: 'cli' })), '');
  assert.equal(elsewhere.where(rec('idle', 0, { entrypoint: 'sdk-ts' })), '');
  assert.equal(elsewhere.where(rec('idle', 0)), '');
  assert.equal(elsewhere.where(undefined), '');
});

test('recent: open here always; running elsewhere as active(); otherwise by last activity', () => {
  const old = NOW - 3 * 60 * MIN;
  assert.equal(elsewhere.recent({ open: true, mtime: old, now: NOW }), true);
  assert.equal(elsewhere.recent({ rec: rec('busy', 5 * 60 * MIN), mtime: old, now: NOW }), true);
  assert.equal(elsewhere.recent({ rec: rec('idle', 2 * 60 * MIN), mtime: old, now: NOW }), false);
  assert.equal(elsewhere.recent({ rec: rec('idle', 10 * MIN), mtime: old, now: NOW }), true);
  assert.equal(elsewhere.recent({ mtime: NOW - 20 * MIN, now: NOW }), true);
  assert.equal(elsewhere.recent({ mtime: old, now: NOW }), false);
  assert.equal(elsewhere.recent({ mtime: old, now: NOW, hours: 4 }), true);
  assert.equal(elsewhere.recent({ mtime: old, now: NOW, agents: 1 }), true, 'subagents still running');
  assert.equal(elsewhere.recent({ now: NOW }), false, 'no time at all: older');
});

test('recent: hours 0 makes everything recent', () => {
  assert.equal(elsewhere.recent({ mtime: NOW - 30 * 24 * 60 * MIN, now: NOW, hours: 0 }), true);
  assert.equal(elsewhere.recent({ rec: rec('idle', 30 * 24 * 60 * MIN), now: NOW, hours: 0 }), true);
});
