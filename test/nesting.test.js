const test = require('node:test');
const assert = require('node:assert/strict');
const nesting = require('../media/nesting');

// rank: 0 open in this window, 1 running elsewhere, 2 pinned, 3 by day
const s = (id, rank, parent = '') => ({ id, rank, parent });
const pairs = (items) => [...nesting.nest(items)];

test('nest: a child goes under its parent when both are shown', () => {
  assert.deepEqual(pairs([s('p', 3), s('c', 3, 'p'), s('d', 3, 'p')]), [
    ['c', 'p'],
    ['d', 'p'],
  ]);
});

test('nest: no parent shown (hidden, filtered out, unknown): the child stays at its own place', () => {
  assert.deepEqual(pairs([s('c', 3, 'p')]), []);
  assert.deepEqual(pairs([s('c', 1, 'nobody'), s('x', 3)]), []);
});

test('nest: never into a less prominent section', () => {
  // An active child running elsewhere stays there rather than going down to its finished parent in history.
  assert.deepEqual(pairs([s('p', 3), s('c', 1, 'p')]), []);
  // A finished child under a parent still running elsewhere: fine.
  assert.deepEqual(pairs([s('p', 1), s('c', 3, 'p')]), [['c', 'p']]);
  // Pinned child under a parent in history: stays pinned.
  assert.deepEqual(pairs([s('p', 3), s('c', 2, 'p')]), []);
});

test('nest: sessions open in this window are never nested; their children can be', () => {
  assert.deepEqual(pairs([s('p', 1), s('c', 0, 'p')]), []);
  assert.deepEqual(pairs([s('p', 0), s('c', 1, 'p')]), [['c', 'p']]);
});

test('nest: grandchildren nest under the nested child, judged by where the family sits', () => {
  // g is by day, c running elsewhere, p open: all under p.
  assert.deepEqual(pairs([s('g', 3, 'c'), s('c', 1, 'p'), s('p', 0)]), [
    ['g', 'c'],
    ['c', 'p'],
  ]);
  // c can't nest (its parent is in a lower section), so g sits under c where c is.
  assert.deepEqual(pairs([s('p', 3), s('c', 1, 'p'), s('g', 3, 'c')]), [['g', 'c']]);
});

test('nest: a loop in the links is cut, nothing nests under itself', () => {
  const out = nesting.nest([s('a', 3, 'b'), s('b', 3, 'a')]);
  assert.equal(out.size, 1);
  const out3 = nesting.nest([s('a', 3, 'c'), s('b', 3, 'a'), s('c', 3, 'b')]);
  assert.equal(out3.size, 2);
  for (const id of ['a', 'b', 'c']) {
    const seen = new Set();
    for (let x = id; x; x = out3.get(x)) {
      assert.ok(!seen.has(x), 'no cycle');
      seen.add(x);
    }
  }
  assert.deepEqual(pairs([s('a', 3, 'a')]), []);
});

test('children and family', () => {
  const items = [s('p', 3), s('c', 3, 'p'), s('d', 3, 'p'), s('g', 3, 'c'), s('x', 3)];
  const kids = nesting.children(nesting.nest(items), items);
  assert.deepEqual([...kids], [
    ['p', ['c', 'd']],
    ['c', ['g']],
  ]);
  assert.deepEqual(nesting.family('p', kids), ['p', 'c', 'g', 'd']);
  assert.deepEqual(nesting.family('x', kids), ['x']);
});

test('fold: older children wait behind "Show N older" only while one stays visible', () => {
  const recent = new Set(['b']);
  const isRecent = (id) => recent.has(id);
  assert.deepEqual(nesting.fold(['a', 'b', 'c'], isRecent), { shown: ['b'], older: 2, open: true });
  assert.deepEqual(nesting.fold(['a', 'b', 'c'], isRecent, true), { shown: ['a', 'b', 'c'], older: 2, open: true });
  // All older: all shown, no link, and the list starts collapsed.
  assert.deepEqual(nesting.fold(['a', 'c'], isRecent), { shown: ['a', 'c'], older: 0, open: false });
  assert.deepEqual(nesting.fold(['a', 'c'], isRecent, true), { shown: ['a', 'c'], older: 0, open: false });
  assert.deepEqual(nesting.fold([], isRecent), { shown: [], older: 0, open: false });
});
