const test = require('node:test');
const assert = require('node:assert/strict');
const handoff = require('../handoff');

const T = 1_800_000_000_000;
const h = (o = {}) => ({ id: 's1', at: T, emptySince: 0, ...o });

test('step: closes the terminal once the app runs the session and nothing else runs there', () => {
  assert.equal(handoff.step(h(), { now: T + 3000, inApp: true }), 'dispose');
  assert.equal(handoff.step(h(), { now: T + 3000, running: 's1', inApp: true }), 'keep'); // still running here
});

test('step: waits while the session still runs in the terminal, or briefly while it is empty', () => {
  const e = h();
  assert.equal(handoff.step(e, { now: T + 1000, running: 's1' }), 'keep');
  assert.equal(handoff.step(e, { now: T + 2000 }), 'keep');
  assert.equal(e.emptySince, T + 2000);
  assert.equal(handoff.step(e, { now: T + 2000 + handoff.EMPTY }), 'keep');
  assert.equal(handoff.step(e, { now: T + 3000 + handoff.EMPTY }), 'drop'); // /desktop came to nothing
  const back = h({ emptySince: T });
  assert.equal(handoff.step(back, { now: T + 5000, running: 's1' }), 'keep'); // Claude still there: /desktop failed
  assert.equal(back.emptySince, 0);
});

test('step: lapses once another session runs in the terminal, or after the window', () => {
  assert.equal(handoff.step(h(), { now: T + 1000, running: 's2' }), 'drop');
  assert.equal(handoff.step(h(), { now: T + 1000, running: 's2', inApp: true }), 'drop'); // never that terminal
  assert.equal(handoff.step(h(), { now: T + handoff.WINDOW + 1, running: 's1' }), 'drop');
  // the original session turning up in the app much later doesn't close anything: the hand-off is gone by then
});
