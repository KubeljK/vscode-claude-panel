const test = require('node:test');
const assert = require('node:assert/strict');
const names = require('../names');

test('clean: one line, no control or direction characters, trimmed', () => {
  assert.equal(names.clean('  Fix the parser  '), 'Fix the parser');
  assert.equal(names.clean('two\nlines\r\nhere'), 'two lines here');
  assert.equal(names.clean('tab\there\u0007bell\u001b[31m'), 'tab here bell [31m');
  assert.equal(names.clean('a\u202eb\u200bc\u2066d'), 'a b c d');
  assert.equal(names.clean('\n\t \u0000'), '');
  assert.equal(names.clean(undefined), '');
  assert.equal(names.clean(42), '42');
});

test("fromClaude: the transcript's name, then its custom title", () => {
  assert.equal(names.fromClaude({ name: 'n', customTitle: 'c', aiTitle: 'a' }), 'n');
  assert.equal(names.fromClaude({ customTitle: ' c ' }), 'c');
  assert.equal(names.fromClaude({ aiTitle: 'a' }), undefined); // Claude's own guess isn't a name
  assert.equal(names.fromClaude(undefined), undefined);
});

test("superseded: once Claude Code's name moves on from what it was at Rename…", () => {
  assert.equal(names.superseded(undefined, 'x'), false);
  assert.equal(names.superseded({ alias: 'mine', aliasWas: 'old' }, 'old'), false); // /rename not arrived yet
  assert.equal(names.superseded({ alias: 'mine', aliasWas: 'old' }, 'mine'), true); // it has
  assert.equal(names.superseded({ alias: 'mine', aliasWas: 'old' }, 'typed'), true); // /rename typed since
  assert.equal(names.superseded({ alias: 'mine', aliasWas: null }, undefined), false); // Claude had none, still none
  assert.equal(names.superseded({ alias: 'mine', aliasWas: null }, 'typed'), true);
});

test('superseded: an alias from before aliasWas gives way only to the same name', () => {
  assert.equal(names.superseded({ alias: 'mine' }, 'mine'), true);
  assert.equal(names.superseded({ alias: ' mine ' }, 'mine'), true);
  assert.equal(names.superseded({ alias: 'mine' }, 'other'), false);
  assert.equal(names.superseded({ alias: 'mine' }, undefined), false);
});

test('toSend: the cleaned name, unless Claude Code has it or has moved on', () => {
  assert.equal(names.toSend({ alias: 'mine', aliasWas: 'old' }, 'old'), 'mine');
  assert.equal(names.toSend({ alias: 'a\nb', aliasWas: null }, undefined), 'a b');
  assert.equal(names.toSend({ alias: 'mine', aliasWas: 'mine' }, 'mine'), undefined); // already has it
  assert.equal(names.toSend({ alias: 'mine', aliasWas: 'old' }, 'typed'), undefined); // moved on
  assert.equal(names.toSend({ alias: '\u0007', aliasWas: null }, undefined), undefined); // nothing left to send
  assert.equal(names.toSend({ alias: 'mine' }, 'other'), 'mine'); // an old alias, on resume
  assert.equal(names.toSend(undefined, 'x'), undefined);
});
