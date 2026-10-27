const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const accounts = require('../accounts');

const home = path.resolve('/home/u');
const opts = { command: 'claude', env: {}, home };

test('resolve: no accounts configured means the one Claude Code uses, unlabelled', () => {
  const only = [{ label: '', dir: path.join(home, '.claude'), command: 'claude', color: '' }];
  assert.deepEqual(accounts.resolve(undefined, opts), only);
  assert.deepEqual(accounts.resolve([], opts), only);
  assert.deepEqual(accounts.resolve([], { ...opts, env: { CLAUDE_CONFIG_DIR: '/opt/claude' } }), [
    { label: '', dir: path.resolve('/opt/claude'), command: 'claude', color: '' },
  ]);
});

test('resolve: labelled folders, ~ expanded, the command falling back to claudeSessions.command', () => {
  const list = accounts.resolve(
    [
      { label: 'Work', configDir: '~/.claude', command: 'aclaude', color: 'blue' },
      { label: ' Personal ', configDir: '~/.claude-personal/', color: 'green' },
    ],
    opts
  );
  assert.deepEqual(list, [
    { label: 'Work', dir: path.join(home, '.claude'), command: 'aclaude', color: 'blue' },
    { label: 'Personal', dir: path.join(home, '.claude-personal'), command: 'claude', color: 'green' },
  ]);
});

test('resolve: skips entries without a label or an absolute or ~ folder, and repeats of a folder', () => {
  const list = accounts.resolve(
    [
      null,
      { configDir: '~/.claude' },
      { label: 'Relative', configDir: 'claude-dir' },
      { label: 'Blank', configDir: '  ' },
      { label: 'Work', configDir: '/opt/work', color: 'magenta', command: '  ' },
      { label: 'Again', configDir: '/opt/work/' },
    ],
    opts
  );
  assert.deepEqual(list, [{ label: 'Work', dir: path.resolve('/opt/work'), command: 'claude', color: '' }]);
});

test('ofFile: the account whose folder holds a transcript, not one whose name it merely starts with', () => {
  const list = accounts.resolve(
    [
      { label: 'Work', configDir: '~/.claude' },
      { label: 'Personal', configDir: '~/.claude-personal' },
    ],
    opts
  );
  const file = (dir) => path.join(home, dir, 'projects', '-home-u-app', 'abc.jsonl');
  assert.equal(accounts.ofFile(list, file('.claude')).label, 'Work');
  assert.equal(accounts.ofFile(list, file('.claude-personal')).label, 'Personal');
  assert.equal(accounts.ofFile(list, path.join(home, 'elsewhere', 'abc.jsonl')), undefined);
  assert.equal(accounts.ofFile(list, undefined), undefined);
});

test('terminalEnv: the folder in CLAUDE_CONFIG_DIR, but ~/.claude only with the variable unset', () => {
  const [work, personal] = accounts.resolve(
    [
      { label: 'Work', configDir: '~/.claude' },
      { label: 'Personal', configDir: '~/.claude-personal' },
    ],
    opts
  );
  assert.deepEqual(accounts.terminalEnv(personal, { env: {}, home }), { CLAUDE_CONFIG_DIR: path.join(home, '.claude-personal') });
  assert.equal(accounts.terminalEnv(work, { env: {}, home }), undefined);
  assert.deepEqual(accounts.terminalEnv(work, { env: { CLAUDE_CONFIG_DIR: '/opt/x' }, home }), { CLAUDE_CONFIG_DIR: null });
  const [unlabelled] = accounts.resolve([], { ...opts, env: { CLAUDE_CONFIG_DIR: '/opt/x' } });
  assert.equal(accounts.terminalEnv(unlabelled, { env: { CLAUDE_CONFIG_DIR: '/opt/x' }, home }), undefined); // as before
});

test('sameEnv: an unset and a null CLAUDE_CONFIG_DIR are the same account', () => {
  assert.ok(accounts.sameEnv(undefined, undefined));
  assert.ok(accounts.sameEnv({}, { CLAUDE_CONFIG_DIR: null }));
  assert.ok(accounts.sameEnv({ CLAUDE_CONFIG_DIR: '/a' }, { CLAUDE_CONFIG_DIR: '/a' }));
  assert.ok(!accounts.sameEnv({ CLAUDE_CONFIG_DIR: '/a' }, undefined));
  assert.ok(!accounts.sameEnv(undefined, { CLAUDE_CONFIG_DIR: '/b' }));
});

test('display: ~ for the home directory', () => {
  assert.equal(accounts.display(path.join(home, '.claude'), home), path.join('~', '.claude'));
  assert.equal(accounts.display(home, home), '~');
  assert.equal(accounts.display(path.resolve('/home/user2/.claude'), home), path.resolve('/home/user2/.claude'));
});
