const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const viewer = require('../viewer');

const FIX = path.join(__dirname, 'fixtures');
const text = fs.readFileSync(path.join(FIX, 'viewer.jsonl'), 'utf8');
const dirs = [];
const tmp = () => dirs[dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-viewer-'))) - 1];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const kinds = (items) => items.map((it) => it.k);

function copy(content = text) {
  const file = path.join(tmp(), '7a1b2c3d-0000-4000-8000-000000000001.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

test('a transcript folds into timeline items; noise, meta lines and unknown types are left out', () => {
  const t = new viewer.Timeline();
  t.feed(Buffer.from(text), 0);
  assert.deepEqual(kinds(t.items), [
    'user', 'thinking', 'assistant', 'tool', 'thinking', 'tool', 'tool', 'tool',
    'agentDone', 'divider', 'assistant', 'turnEnd', 'command', 'user',
  ]);
  assert.equal(t.bad, 1); // the cut-off line
  const [prompt, hidden, , bash, thought, read, agent, edit, done, divider, , turn, cmd] = t.items;
  assert.equal(prompt.images, 1);
  assert.match(prompt.text, /^Add a dark mode toggle/);
  assert.equal(hidden.text, ''); // most thinking is written empty: shown as "Thinking…"
  assert.match(thought.text, /context provider/);
  assert.equal(bash.name, 'Bash');
  assert.equal(bash.summary, 'Find theme creation sites');
  assert.equal(bash.input, 'grep -rn "createTheme" src | head'); // a command as itself, not JSON
  assert.match(bash.result.text, /^src\/theme.ts:4/);
  assert.equal(bash.result.error, false);
  assert.equal(read.summary, '/home/dev/acme-web/src/App.tsx');
  assert.match(read.input, /"file_path"/);
  assert.equal(agent.agent, true);
  assert.equal(agent.agentId, 'a7f3c2e19d0b4a5c6');
  assert.equal(edit.result.error, true);
  assert.deepEqual([done.agentId, done.status], ['a7f3c2e19d0b4a5c6', 'completed']);
  assert.match(done.result, /MemoryRouter/);
  assert.deepEqual([divider.trigger, divider.pre, divider.post], ['auto', 812000, 38000]);
  assert.equal(turn.ms, 61234);
  assert.equal(cmd.text, '/model opus');
  assert.deepEqual(t.items.map((it) => it.seq), t.items.map((_, i) => i));
  assert.ok(t.items.every((it, i) => i === 0 || it.off > t.items[i - 1].off || it.off === t.items[i - 1].off));
  assert.equal(t.meta.model, 'claude-opus-5-5');
  assert.equal(t.meta.branch, 'feature/dark-mode');
  assert.equal(t.meta.aiTitle, 'Dark mode toggle for settings');
  assert.equal(t.meta.ctx, 3 + 41200 + 1800);
});

test('a tool result arriving later patches its call', () => {
  const t = new viewer.Timeline();
  const cut = text.indexOf('\n', text.indexOf('"id":"toolu_01"')) + 1; // just after the Bash call
  t.feed(Buffer.from(text.slice(0, cut)), 0);
  let { added, changed } = t.drain();
  assert.equal(added.at(-1).k, 'tool');
  assert.equal(added.at(-1).result, undefined);
  assert.deepEqual(changed, []);
  t.feed(Buffer.from(text.slice(cut)), Buffer.byteLength(text.slice(0, cut)));
  ({ added, changed } = t.drain());
  assert.deepEqual(changed.map((it) => it.id), ['toolu_01']);
  assert.match(changed[0].result.text, /createTheme/);
  assert.equal(added[0].k, 'thinking');
});

test('long text and tool output are clipped', () => {
  const t = new viewer.Timeline();
  const big = 'x'.repeat(10000);
  const l = (o) => JSON.stringify(o) + '\n';
  t.feed(
    Buffer.from(
      l({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } }) +
        l({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: big }, { type: 'image' }] }] } })
    ),
    0
  );
  const r = t.items[0].result;
  assert.ok(r.text.length < 4100);
  assert.match(r.text, /more characters$/);
  assert.equal(r.images, 1);
});

test('never throws on odd entries', () => {
  const t = new viewer.Timeline();
  const odd = [
    'null', '42', '"str"', '[]', '{}', '{"type":"user"}', '{"type":"user","message":{"content":[null,1,{"type":"tool_result"}]}}',
    '{"type":"assistant","message":{"content":"text"}}', '{"type":"assistant","message":{"content":[null,{"type":"tool_use"}]}}',
    '{"type":"system","subtype":"compact_boundary"}', '{"type":"user","message":{"content":"<task-notification><task-id>../../x</task-id></task-notification>"}}',
  ];
  t.feed(Buffer.from(odd.join('\n') + '\n'), 0);
  assert.deepEqual(kinds(t.items), ['divider', 'agentDone']);
  assert.equal(t.items[1].agentId, 'x'); // only id characters survive
});

test('Tail: the end first, then earlier pages, with results reattached to their calls', async () => {
  const file = copy();
  const size = Buffer.byteLength(text);
  // A small first read that starts between the Edit call and its error result.
  const callAt = Buffer.byteLength(text.slice(0, text.indexOf('"id":"toolu_04"')));
  const tail = new viewer.Tail(file, { initial: size - callAt, chunk: 3000 });
  const init = await tail.open();
  assert.equal(init.type, 'init');
  assert.equal(init.hasEarlier, true);
  assert.equal(init.items[0].k, 'agentDone'); // read from the next line start on
  const pages = [];
  for (let p; (p = await tail.earlier()).items.length || p.hasEarlier; ) pages.push(p);
  const all = tail.t.items;
  assert.deepEqual(kinds(all).slice(0, 3), ['user', 'thinking', 'assistant']);
  assert.equal(all.length, 14);
  const edit = all.find((it) => it.id === 'toolu_04');
  assert.equal(edit.result.error, true); // its result was read before the call
  assert.deepEqual(all.map((it) => it.seq), [...all.map((it) => it.seq)].sort((a, b) => a - b));
  assert.ok(pages[0].items.at(-1).seq < init.items[0].seq);
  assert.equal((await tail.earlier()).hasEarlier, false);
});

test('Tail: follows appends line by line, waits for half-written lines, restarts when the file shrinks', async () => {
  const lines = text.split('\n').filter(Boolean);
  const file = copy(lines.slice(0, 7).join('\n') + '\n'); // up to the Bash call
  const tail = new viewer.Tail(file);
  const init = await tail.open();
  assert.equal(init.hasEarlier, false);
  assert.equal(init.items.at(-1).id, 'toolu_01');
  assert.equal(await tail.poll(), undefined);

  const result = lines[7];
  fs.appendFileSync(file, result.slice(0, 50));
  assert.equal(await tail.poll(), undefined); // half a line: nothing yet
  fs.appendFileSync(file, result.slice(50) + '\n' + lines[8] + '\n');
  const m = await tail.poll();
  assert.equal(m.type, 'append');
  assert.deepEqual(m.changed.map((it) => it.id), ['toolu_01']);
  assert.deepEqual(kinds(m.items), ['thinking']);
  assert.equal(m.first, 0);

  fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n');
  const again = await tail.poll();
  assert.equal(again.type, 'init');
  assert.deepEqual(kinds(again.items), ['user']);
});

test('Tail: keeps at most `cap` items as it grows; earlier pages bring the rest back', async () => {
  const file = copy();
  const tail = new viewer.Tail(file, { cap: 5 });
  const init = await tail.open();
  assert.equal(init.items.length, 5);
  assert.equal(init.hasEarlier, true);
  fs.appendFileSync(file, '{"type":"user","message":{"role":"user","content":"one more"}}\n');
  const m = await tail.poll();
  assert.equal(m.items[0].text, 'one more');
  assert.equal(tail.t.items.length, 5);
  assert.equal(m.first, tail.t.items[0].seq);
  while ((await tail.earlier()).hasEarlier);
  assert.equal(tail.t.items.length, 15);
  assert.equal(tail.t.items[0].k, 'user');
});

test('readBack starts at a line start, reading past a line longer than the page', async () => {
  const long = JSON.stringify({ type: 'user', message: { content: 'y'.repeat(500) } });
  const file = copy(`{"a":1}\n${long}\n{"b":2}\n`);
  const size = fs.statSync(file).size;
  let r = await viewer.readBack(file, size, 10);
  assert.equal(r.buf.toString(), '{"b":2}\n');
  r = await viewer.readBack(file, r.start, 100); // inside the long line: read back until its start
  assert.ok(r.buf.toString() === long + '\n', 'the whole long line');
  assert.equal(r.start, 8);
  r = await viewer.readBack(file, r.start, 100);
  assert.deepEqual([r.buf.toString(), r.start], ['{"a":1}\n', 0]);
});

test('header: model, branch and context use from the newest lines', async () => {
  const tail = new viewer.Tail(copy());
  await tail.open();
  assert.deepEqual(tail.header(), { model: 'claude-opus-5-5', branch: 'feature/dark-mode', ctx: [43003, 1000000], bad: 1 });
});

test('subagent files: only plain ids, only files that exist, next to a session or another agent', async () => {
  const sid = '0f2c3d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const session = path.join(FIX, 'agents', `${sid}.jsonl`);
  const sub = path.join(FIX, 'agents', sid, 'subagents');
  assert.equal(viewer.agentFile(session, 'a01done'), path.join(sub, 'agent-a01done.jsonl'));
  assert.equal(viewer.agentFile(path.join(sub, 'agent-a07parent.jsonl'), 'a08child'), path.join(sub, 'agent-a08child.jsonl'));
  assert.equal(viewer.agentFile(session, '../a01done'), undefined);
  assert.equal(viewer.agentFile(session, 'a01done.jsonl'), undefined);
  assert.equal(viewer.agentFile(session, 'nope'), undefined);
  assert.equal(viewer.agentFile(session, { length: 1 }), undefined);
  const ids = await viewer.agentIds(session);
  assert.equal(ids.get('toolu_07Par'), 'a07parent');
});
