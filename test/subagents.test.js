const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const transcripts = require('../transcripts');
const subagents = require('../subagents');

const SID = '0f2c3d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const T = (hms) => Date.parse(`2026-03-02T${hms}.000Z`);
const NOW = T('10:21:00');

// When each agent's files were last written (the fixture's timestamps say when things were reported).
const MTIMES = {
  a01done: '10:05:00',
  a02fail: '10:06:00',
  a03fg: '10:07:00',
  a04run: '10:20:00', // still writing
  a05stop: '10:09:00',
  a06resumed: '10:30:00', // written long after its completion: resumed
  a07parent: '10:25:00',
  a08child: '10:15:00',
  a09child: '10:24:00',
  a10nested: '10:22:00', // nested, resumed after its parent finished: its last completion is in the session
  a11ended: '10:18:00', // ended on its final reply, no completion notice
  a12quiet: '10:05:00', // running, silent since
};

/** A copy of the fixture project with file times set, and the session read the way extension.js reads it. */
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-agents-'));
  dirs.push(dir);
  fs.cpSync(path.join(__dirname, 'fixtures', 'agents'), dir, { recursive: true });
  const sub = path.join(dir, SID, 'subagents');
  for (const [id, hms] of Object.entries(MTIMES)) {
    for (const f of [`agent-${id}.jsonl`, `agent-${id}.meta.json`]) fs.utimesSync(path.join(sub, f), T(hms) / 1000, T(hms) / 1000);
  }
  const file = path.join(dir, `${SID}.jsonl`);
  fs.utimesSync(file, T('10:11:01') / 1000, T('10:11:01') / 1000);
  const info = await transcripts.readSession(file, new Map());
  return { dir, sessions: new Map([[SID, info]]) };
}

async function agentsOf(sessions, live) {
  subagents.get(SID); // the panel asks for a session before update() reads it
  await subagents.update(sessions, live, NOW);
  return Object.fromEntries(subagents.get(SID).map((a) => [a.id, a]));
}

test('scanText collects notifications and foreground results, not "launched" results', () => {
  const info = {};
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'agents', `${SID}.jsonl`), 'utf8');
  // In two appended chunks, as readSession would see them.
  const mid = text.indexOf('\n', text.indexOf('toolu_03Fg')) + 1;
  subagents.scanText(info, text.slice(0, mid));
  assert.equal(info.toolDone, undefined); // the foreground call has no result yet
  subagents.scanText(info, text.slice(mid));
  assert.deepEqual([...info.agentDone.keys()].sort(), ['a01done', 'a02fail', 'a06resumed', 'a10nested']);
  assert.deepEqual(info.agentDone.get('a02fail'), { at: T('10:06:00'), status: 'failed' });
  assert.deepEqual([...info.toolDone.keys()], ['toolu_03Fg']);
  assert.equal(info.toolDone.get('toolu_03Fg'), T('10:07:00'));
  assert.ok(info.agentCalls.has('toolu_04Run')); // launched, still waiting for its notification
});

test('while the session runs: running, done, failed, stopped, resumed, nested', async () => {
  const { sessions } = await setup();
  const a = await agentsOf(sessions, new Map([[SID, { sessionId: SID, startedAt: T('10:00:00') }]]));
  const states = Object.fromEntries(Object.entries(a).map(([id, x]) => [id, x.state]));
  assert.deepEqual(states, {
    a01done: 'done', // <task-notification> completed
    a02fail: 'failed', // <task-notification> failed
    a03fg: 'done', // foreground: its Agent tool_result
    a04run: 'run', // launched, nothing reported, Claude still running
    a05stop: 'stopped', // meta says stoppedByUser
    a06resumed: 'run', // completed, then written again well after
    a07parent: 'run',
    a08child: 'done', // nested: completion is in the parent agent's transcript
    a09child: 'run',
    a10nested: 'done',
    a11ended: 'done',
    a12quiet: 'run',
  });
  assert.equal(a.a08child.depth, 2);
  assert.equal(a.a01done.depth, 1);
  assert.equal(a.a01done.desc, 'Map payment call sites');
  assert.equal(a.a01done.type, 'Explore');
  assert.equal(a.a01done.start, T('10:01:02')); // first timestamp of its transcript
  assert.equal(a.a01done.end, T('10:05:00'));
  assert.equal(a.a04run.end, 0);
  assert.equal(a.a04run.activity, 'Reading migrate.sql'); // from its own transcript, while it runs
  assert.equal(a.a09child.activity, 'Thinking…');
  assert.equal(a.a10nested.end, T('10:22:01'));
  assert.equal(a.a11ended.end, T('10:18:00'));
  assert.equal(a.a12quiet.activity, 'Quiet for 16m · Running npm run load-test');
  assert.equal(a.a01done.activity, undefined);
  // Running first, then most recently finished.
  const order = subagents.get(SID).map((x) => x.id);
  assert.deepEqual(order.slice(5), ['a10nested', 'a11ended', 'a08child', 'a05stop', 'a03fg', 'a02fail', 'a01done']);
  assert.equal(subagents.transcript(SID, 'a04run').endsWith(path.join('subagents', 'agent-a04run.jsonl')), true);
  assert.equal(subagents.transcript(SID, '../x'), undefined);
});

test('after the session exits: nothing is running any more', async () => {
  const { sessions } = await setup();
  const a = await agentsOf(sessions, new Map());
  assert.equal(a.a04run.state, 'stopped'); // its Claude process is gone without telling anyone
  assert.equal(a.a04run.end, T('10:20:00'));
  assert.equal(a.a07parent.state, 'stopped');
  assert.equal(a.a09child.state, 'stopped');
  assert.equal(a.a06resumed.state, 'done');
  assert.equal(a.a06resumed.end, T('10:30:00')); // resumed: its last write, not the old completion
  assert.equal(a.a01done.state, 'done');
  assert.equal(a.a02fail.state, 'failed');
  assert.equal(a.a08child.state, 'done');
});

test('agents written before this Claude process started are not running', async () => {
  const { sessions } = await setup();
  const a = await agentsOf(sessions, new Map([[SID, { sessionId: SID, startedAt: T('11:00:00') }]]));
  assert.equal(a.a04run.state, 'stopped');
  assert.equal(a.a09child.state, 'stopped');
});
