const test = require('node:test');
const assert = require('node:assert/strict');
const terminals = require('../terminals');

test('alive: this process is, a pid that does not exist is not', () => {
  assert.equal(terminals.alive(process.pid), true);
  assert.equal(terminals.alive(2 ** 22 + 12345), false);
});

test('hasShell: a terminal whose shell is running', async () => {
  assert.equal(await terminals.hasShell({ processId: Promise.resolve(process.pid) }), true);
});

test('hasShell: a revived tab with no pty has no pid, or a dead one', async () => {
  assert.equal(await terminals.hasShell({ processId: Promise.resolve(undefined) }), false);
  assert.equal(await terminals.hasShell({ processId: Promise.resolve(4242) }, { isAlive: () => false }), false);
  assert.equal(
    await terminals.hasShell({
      processId: Promise.reject(new Error('disposed')),
    }),
    false,
  );
});

test('hasShell: gives up when processId never settles', async () => {
  const start = Date.now();
  assert.equal(await terminals.hasShell({ processId: new Promise(() => {}) }, { timeout: 50 }), false);
  assert.ok(Date.now() - start < 1000);
});

test('startExpired: only after STARTING_MS, never without a start time', () => {
  const now = 1_800_000_000_000;
  assert.equal(terminals.startExpired(now - 5000, now), false);
  assert.equal(terminals.startExpired(now - terminals.STARTING_MS - 1, now), true);
  assert.equal(terminals.startExpired(undefined, now), false);
});

test('pidOf: the shell pid, or undefined when processId fails or never settles', async () => {
  assert.equal(await terminals.pidOf({ processId: Promise.resolve(4242) }), 4242);
  assert.equal(await terminals.pidOf({ processId: Promise.reject(new Error('disposed')) }), undefined);
  const start = Date.now();
  assert.equal(await terminals.pidOf({ processId: new Promise(() => {}) }, 50), undefined);
  assert.ok(Date.now() - start < 1000);
});

test('pendingState: "Starting…" for 30 s, then held without a card until Claude runs or the terminal closes', () => {
  const now = 1_800_000_000_000;
  const since = now - 5000;
  assert.equal(terminals.pendingState({ open: true, running: false, since, now }), 'show');
  assert.equal(terminals.pendingState({ open: true, running: false, since: now - terminals.STARTING_MS - 1, now }), 'hold');
  assert.equal(terminals.pendingState({ open: true, running: false, since: undefined, now }), 'show');
  assert.equal(terminals.pendingState({ open: true, running: true, since, now }), 'drop');
  assert.equal(terminals.pendingState({ open: false, running: false, since: now - terminals.STARTING_MS - 1, now }), 'drop');
});
