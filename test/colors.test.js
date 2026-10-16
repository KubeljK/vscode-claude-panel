const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../colors');

test('fromClaude: /color default and no colour are both none', () => {
  assert.equal(colors.fromClaude('red'), 'red');
  assert.equal(colors.fromClaude('default'), undefined);
  assert.equal(colors.fromClaude(undefined), undefined);
});

test("shown: Claude Code's colour, or the panel's pick until Claude Code reports a newer one", () => {
  assert.equal(colors.shown(undefined, 'orange'), 'orange');
  assert.equal(colors.shown({ color: 'red', colorWas: 'orange' }, 'orange'), 'red'); // /color not arrived yet
  assert.equal(colors.shown({ color: 'red', colorWas: 'orange' }, 'red'), 'red'); // it has
  assert.equal(colors.shown({ color: 'red', colorWas: 'orange' }, 'blue'), 'blue'); // /color blue typed since
  assert.equal(colors.shown({ color: 'red', colorWas: 'orange' }, 'default'), undefined); // /color default typed
  assert.equal(colors.shown({ color: 'default', colorWas: 'orange' }, 'orange'), undefined); // picked none
  assert.equal(colors.shown({ color: 'red' }, undefined), 'red');
  assert.equal(colors.shown({ color: 'red' }, 'orange'), 'orange'); // a pick from before colorWas was kept
});

test('superseded: Claude Code reported a colour since the pick', () => {
  assert.equal(colors.superseded({ color: 'red', colorWas: 'orange' }, 'orange'), false);
  assert.equal(colors.superseded({ color: 'red', colorWas: 'orange' }, 'red'), true);
  assert.equal(colors.superseded({ color: 'red' }, 'default'), false);
  assert.equal(colors.superseded({ color: 'red' }, 'orange'), true);
  assert.equal(colors.superseded({ alias: 'x' }, 'orange'), false);
  assert.equal(colors.superseded(undefined, 'orange'), false);
});

test('toSend: the pick to pass on as /color, unless Claude Code already has it or has moved on', () => {
  assert.equal(colors.toSend({ color: 'red', colorWas: 'orange' }, 'orange'), 'red');
  assert.equal(colors.toSend({ color: 'default', colorWas: 'orange' }, 'orange'), 'default');
  assert.equal(colors.toSend({ color: 'red', colorWas: 'red' }, 'red'), undefined);
  assert.equal(colors.toSend({ color: 'default' }, undefined), undefined);
  assert.equal(colors.toSend({ color: 'red', colorWas: 'orange' }, 'blue'), undefined);
  assert.equal(colors.toSend({ color: 'red' }, undefined), 'red');
  assert.equal(colors.toSend(undefined, 'orange'), undefined);
});
