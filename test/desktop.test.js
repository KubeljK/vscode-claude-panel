const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const desktop = require('../desktop');

// Synthetic ids only.
const meta = (n, extra = {}) => ({ sessionId: `local_${n}`, cliSessionId: `cli-${n}`, title: `Session ${n}`, ...extra });

test('metaDir: macOS only', () => {
  assert.equal(desktop.metaDir('darwin', '/Users/someone'), '/Users/someone/Library/Application Support/Claude/claude-code-sessions');
  assert.equal(desktop.metaDir('linux', '/home/someone'), '');
  assert.equal(desktop.metaDir('win32', 'C:\\Users\\someone'), '');
});

test('parse: ids, the parent, and whether it is a fork', () => {
  assert.deepEqual(desktop.parse(meta('a')), { local: 'local_a', cli: 'cli-a', from: '', fork: false });
  assert.deepEqual(desktop.parse(meta('b', { spawnedFrom: { sessionId: 'local_a', taskId: 't1', sideSession: true } })), {
    local: 'local_b',
    cli: 'cli-b',
    from: 'local_a',
    fork: false,
  });
  assert.equal(desktop.parse(meta('c', { spawnedFrom: { sessionId: 'local_a', userFork: true } })).fork, true);
  assert.deepEqual(desktop.parse(meta('d', { forkedFromSessionId: 'local_a' })), { local: 'local_d', cli: 'cli-d', from: 'local_a', fork: true });
  // spawnedFrom wins over forkedFromSessionId, and says itself whether it's a fork
  assert.deepEqual(desktop.parse(meta('e', { spawnedFrom: { sessionId: 'local_b' }, forkedFromSessionId: 'local_a' })).from, 'local_b');
});

test('parse: tolerates missing and malformed fields', () => {
  assert.equal(desktop.parse(null), undefined);
  assert.equal(desktop.parse('x'), undefined);
  assert.equal(desktop.parse({ sessionId: 'local_a' }), undefined);
  assert.equal(desktop.parse({ cliSessionId: 'cli-a' }), undefined);
  assert.equal(desktop.parse({ sessionId: 5, cliSessionId: 'cli-a' }), undefined);
  assert.equal(desktop.parse(meta('a', { spawnedFrom: 'local_x' })).from, '');
  assert.equal(desktop.parse(meta('a', { spawnedFrom: { sessionId: 7 } })).from, '');
  assert.equal(desktop.parse(meta('a', { spawnedFrom: null, forkedFromSessionId: null })).from, '');
});

test('links: child cli id → parent cli id, only where the parent is known', () => {
  const recs = [
    meta('a'),
    meta('b', { spawnedFrom: { sessionId: 'local_a' } }),
    meta('c', { forkedFromSessionId: 'local_b' }),
    meta('d', { spawnedFrom: { sessionId: 'local_gone' } }),
    meta('e', { spawnedFrom: { sessionId: 'local_e' } }), // itself
  ].map(desktop.parse);
  assert.deepEqual(
    [...desktop.links(recs)],
    [
      ['cli-b', { parentCliId: 'cli-a', kind: 'spawned' }],
      ['cli-c', { parentCliId: 'cli-b', kind: 'fork' }],
    ]
  );
});

test('reader: reads <id>/<id>/local_*.json, only what changed, and nothing where the folder is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-meta-'));
  try {
    const put = (a, b, name, data) => {
      fs.mkdirSync(path.join(dir, a, b), { recursive: true });
      const f = path.join(dir, a, b, name);
      fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
      return f;
    };
    put('acct', 'org', 'local_a.json', meta('a'));
    const fb = put('acct', 'org', 'local_b.json', meta('b', { spawnedFrom: { sessionId: 'local_a' } }));
    const T = 1_700_000_000; // whole seconds, so the mtime set again below compares equal
    fs.utimesSync(fb, T, T);
    put('acct', 'org', 'scheduled-tasks.json', { sessionId: 'local_x', cliSessionId: 'cli-x' }); // not a session
    put('acct', 'org2', 'local_c.json', '{"sessionId": "local_c", "cliSess'); // mid-write
    fs.writeFileSync(path.join(dir, 'stray.json'), '{}');

    const read = desktop.reader(dir);
    assert.deepEqual([...(await read())], [['cli-b', { parentCliId: 'cli-a', kind: 'spawned' }]]);

    // The half-written file is read again once complete.
    put('acct', 'org2', 'local_c.json', meta('c', { forkedFromSessionId: 'local_b' }));
    assert.equal((await read()).get('cli-c')?.kind, 'fork');

    // An unchanged file isn't read again: same mtime, so new content goes unnoticed (as intended)...
    fs.writeFileSync(fb, JSON.stringify(meta('b')));
    fs.utimesSync(fb, T, T);
    assert.equal((await read()).has('cli-b'), true);
    // ...until its mtime moves.
    fs.utimesSync(fb, T, T + 5);
    assert.equal((await read()).has('cli-b'), false);

    // A removed file drops its links.
    fs.rmSync(path.join(dir, 'acct', 'org2'), { recursive: true });
    assert.equal((await read()).size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal((await desktop.reader(path.join(dir, 'missing'))()).size, 0);
  assert.equal((await desktop.reader('')()).size, 0);
});
