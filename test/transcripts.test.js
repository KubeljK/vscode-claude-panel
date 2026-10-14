const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const transcripts = require('../transcripts');

const FIX = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const dirs = [];
const tmp = () => dirs[dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-test-'))) - 1];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('claudeDir: ~/.claude unless CLAUDE_CONFIG_DIR is set', () => {
  assert.equal(transcripts.claudeDir({}, '/home/u'), path.join('/home/u', '.claude'));
  assert.equal(transcripts.claudeDir({ CLAUDE_CONFIG_DIR: '  ' }, '/home/u'), path.join('/home/u', '.claude'));
  assert.equal(transcripts.claudeDir({ CLAUDE_CONFIG_DIR: '/opt/claude-work' }, '/home/u'), path.resolve('/opt/claude-work'));
  assert.equal(transcripts.claudeDir({ CLAUDE_CONFIG_DIR: '~/.claude-work' }, '/home/u'), path.resolve('/home/u/.claude-work'));
});

test('encodeCwd replaces every non-alphanumeric character', () => {
  assert.equal(transcripts.encodeCwd('/home/dev/acme-web_2.0'), '-home-dev-acme-web-2-0');
});

test('readChunk: titles, colour, last prompt, branch, cwd, usage', () => {
  const info = {};
  transcripts.readChunk(info, fixture('session-part1.jsonl'));
  assert.equal(info.aiTitle, 'Dark mode toggle');
  assert.equal(info.lastPrompt, 'Add a dark mode toggle to the settings page');
  assert.equal(info.branch, 'main');
  assert.equal(info.cwd, '/home/dev/acme-web');
  assert.equal(info.hasMessages, true);
  assert.equal(info.lines, 5);
  assert.equal(info.ctx, 21203);
  assert.equal(info.name, undefined);
  assert.equal(info.color, undefined);

  transcripts.readChunk(info, fixture('session-part2.jsonl'));
  assert.equal(info.customTitle, 'settings: dark mode');
  assert.equal(info.name, 'dark-mode');
  assert.equal(info.color, 'cyan');
  assert.equal(info.lastPrompt, 'Use the "system" theme by default — and keep the café icon'); // JSON escapes undone
  assert.equal(info.branch, 'feature/dark-mode');
  assert.equal(info.cwd, '/home/dev/acme-web'); // the first cwd sticks
  assert.equal(info.lines, 12);
  assert.equal(info.ctxModel, 'claude-opus-5-5[1m]');
});

test('pickTitle: alias > agent name > user-named live session > custom title > AI title > last prompt > id', () => {
  const id = '7a1b2c3d-0000-4000-8000-000000000001';
  const s = { name: 'n', customTitle: 'c', aiTitle: 'a', lastPrompt: 'p' };
  const l = { name: 'live', nameSource: 'user' };
  assert.equal(transcripts.pickTitle(id, { alias: 'mine', session: s, live: l }), 'mine');
  assert.equal(transcripts.pickTitle(id, { session: s, live: l }), 'n');
  assert.equal(transcripts.pickTitle(id, { session: { ...s, name: undefined }, live: l }), 'live');
  assert.equal(transcripts.pickTitle(id, { session: { ...s, name: undefined }, live: { name: 'x', nameSource: 'auto' } }), 'c');
  assert.equal(transcripts.pickTitle(id, { session: { aiTitle: 'a', lastPrompt: 'p' } }), 'a');
  assert.equal(transcripts.pickTitle(id, { session: { lastPrompt: 'p' } }), 'p');
  assert.equal(transcripts.pickTitle(id, {}), '7a1b2c3d');
  assert.equal(transcripts.pickTitle(id), '7a1b2c3d');
});

test('readSession reads only appended bytes, and only whole lines', async () => {
  const dir = tmp();
  const file = path.join(dir, '7a1b2c3d-0000-4000-8000-000000000001.jsonl');
  const cache = new Map();
  const part1 = fixture('session-part1.jsonl');
  const part2 = fixture('session-part2.jsonl');
  fs.writeFileSync(file, part1);

  let info = await transcripts.readSession(file, cache);
  assert.equal(info.id, '7a1b2c3d-0000-4000-8000-000000000001');
  assert.equal(info.file, file);
  assert.equal(info.aiTitle, 'Dark mode toggle');
  assert.equal(cache.get(file).offset, Buffer.byteLength(part1));

  // Half of the next chunk, ending mid-line: the complete lines are read, the partial one waits.
  const cut = part2.indexOf('"agentColor"');
  fs.appendFileSync(file, part2.slice(0, cut));
  info = await transcripts.readSession(file, cache);
  assert.equal(info.name, 'dark-mode');
  assert.equal(info.color, undefined);
  assert.equal(cache.get(file).offset, Buffer.byteLength(part1 + part2.slice(0, part2.lastIndexOf('\n', cut) + 1)));

  fs.appendFileSync(file, part2.slice(cut));
  info = await transcripts.readSession(file, cache);
  assert.equal(info.color, 'cyan');
  assert.equal(info.lastPrompt, 'Use the "system" theme by default — and keep the café icon');
  assert.equal(info.lines, 12);
  assert.equal(cache.get(file).offset, Buffer.byteLength(part1 + part2));

  // Nothing new: same object, nothing re-read.
  assert.equal(await transcripts.readSession(file, cache), info);
  assert.equal(info.lines, 12);

  // A file that shrank (rewritten) is read from the start.
  fs.writeFileSync(file, part1);
  info = await transcripts.readSession(file, cache);
  assert.equal(info.color, undefined);
  assert.equal(info.lines, 5);
});

test('formatNotice: quiet for the expected shapes', () => {
  const ok = {};
  transcripts.readChunk(ok, fixture('session-part1.jsonl'));
  assert.equal(transcripts.formatNotice({ parsed: 2, ok: 2, version: '2.1.0' }, [ok]), '');
  assert.equal(transcripts.formatNotice({ parsed: 0, ok: 0 }, []), ''); // no Claude Code at all: nothing to say
  assert.equal(transcripts.formatNotice({}, [{ lines: 3, hasMessages: false }]), ''); // a session just started
  assert.equal(transcripts.formatNotice({ parsed: 2, ok: 1 }, []), ''); // one odd record among good ones
});

test('formatNotice: live records without sessionId/pid/status', () => {
  const records = [{ pid: 4242, id: 'x', state: 'busy', version: '9.0.0' }];
  const ok = records.filter(transcripts.isLiveRecord).length;
  assert.equal(ok, 0);
  const n = transcripts.formatNotice({ parsed: 1, ok, version: '9.0.0' }, []);
  assert.match(n, /isn't recognised \(Claude Code 9\.0\.0\)/);
  assert.match(n, /Some details may be missing/);
  assert.equal(transcripts.isLiveRecord({ pid: 4242, sessionId: 's', status: 'idle' }), true);
});

test('formatNotice: transcripts with lines but none of the expected entry types', () => {
  const odd = {};
  transcripts.readChunk(odd, fixture('unrecognised.jsonl'));
  assert.equal(odd.hasMessages, false);
  assert.equal(odd.lines, 10);
  const n = transcripts.formatNotice({ parsed: 0, ok: 0 }, [odd]);
  assert.match(n, /^This Claude Code version's session format isn't recognised\. /);
  const ok = {};
  transcripts.readChunk(ok, fixture('session-part1.jsonl'));
  assert.equal(transcripts.formatNotice({}, [odd, ok]), ''); // one readable transcript is enough
});
