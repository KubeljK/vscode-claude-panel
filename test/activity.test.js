const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const activity = require('../activity');
const transcripts = require('../transcripts');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
let n = 0;
const line = (o) => JSON.stringify({ isSidechain: false, uuid: `x-${++n}`, ...o }) + '\n';
const prompt = (text) => line({ type: 'user', message: { role: 'user', content: text } });
const block = (mid, b, extra = {}) =>
  line({ type: 'assistant', message: { model: 'claude-opus-5-5', id: mid, role: 'assistant', content: [b] }, ...extra });
const call = (mid, id, name, input) => block(mid, { type: 'tool_use', id, name, input });
const result = (id, content = 'ok') =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const busy = (text) => activity.describe(activity.scan(undefined, text), 'busy');

test('tool calls as one short line', () => {
  const l = activity.label;
  assert.equal(l('Read', { file_path: '/home/dev/acme-web/src/App.tsx' }), 'Reading App.tsx');
  assert.equal(l('Edit', { file_path: 'C:\\work\\acme\\extension.js' }), 'Editing extension.js');
  assert.equal(l('MultiEdit', { file_path: '/a/b.css' }), 'Editing b.css');
  assert.equal(l('Write', { file_path: '/a/README.md' }), 'Writing README.md');
  assert.equal(l('NotebookEdit', { notebook_path: '/a/eda.ipynb' }), 'Editing eda.ipynb');
  assert.equal(l('Bash', { command: 'npm test', description: 'Run the unit tests' }), 'Run the unit tests');
  assert.equal(l('Bash', { command: 'npm test' }), 'Running npm test');
  assert.equal(l('Grep', { pattern: 'createTheme', path: 'src' }), "Searching for 'createTheme'");
  assert.equal(l('Glob', { pattern: 'src/**/*.test.ts' }), 'Finding src/**/*.test.ts');
  assert.equal(l('WebFetch', { url: 'https://docs.example.com/api?key=abc123' }), 'Fetching docs.example.com');
  assert.equal(l('WebSearch', { query: 'vite offline mode' }), "Searching the web for 'vite offline mode'");
  assert.equal(l('Agent', { description: 'Survey settings page tests' }), 'Running agent: Survey settings page tests');
  assert.equal(l('Task', {}), 'Running an agent');
  assert.equal(l('TodoWrite', { todos: [] }), 'Updating the to-do list');
  assert.equal(l('Skill', { skill: 'release-notes' }), 'Using skill release-notes');
  assert.equal(l('mcp__github__create_issue', {}), 'Using github create issue');
  assert.equal(l('mcp__claude_ai_Slack__slack_send_message', {}), 'Using Slack send message');
  assert.equal(l('ToolSearch', { query: 'x' }), 'Using ToolSearch');
  assert.equal(l('Read', undefined), 'Reading a file');
  assert.equal(l(undefined, null), 'Using a tool');
});

test('shell commands: a few words, never what looks like a secret', () => {
  const c = activity.command;
  assert.equal(c('git status'), 'git status');
  assert.equal(c('API_TOKEN=s3cr3t-value npm run deploy'), 'npm run deploy');
  assert.equal(c('curl -H "Authorization: Bearer abc" https://api.example.com/v1'), 'curl …');
  assert.equal(c('curl https://user:pw@api.example.com/v1/items'), 'curl api.example.com');
  assert.equal(c('deploy --token ghp_4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'), 'deploy …');
  assert.equal(c('echo sk9f8e7d6c5b4a3f2e1d0c9b8a7'), 'echo …');
  assert.equal(c('node --test test/activity.test.js --watch extra'), 'node --test test/activity.test.js --watch …');
  assert.equal(c('cat a\nrm -rf /'), 'cat a'); // only the first line
  const long = activity.label('Bash', { command: 'x'.repeat(200) });
  assert.ok(long.length <= 60, long);
});

test('a running call, then the next thing once its result is in', () => {
  const t1 = prompt('Fix it') + block('m1', { type: 'thinking', thinking: '' });
  assert.equal(busy(t1), 'Thinking…');
  const t2 = t1 + call('m1', 'toolu_1', 'Bash', { command: 'npm test' });
  assert.equal(busy(t2), 'Running npm test');
  const t3 = t2 + result('toolu_1');
  assert.equal(busy(t3), 'Thinking…'); // finished: the next block is in progress, and not in the file yet
  const t4 = t3 + block('m2', { type: 'text', text: 'All green.' });
  assert.equal(busy(t4), 'Writing a reply…');
  assert.equal(busy(t4 + prompt('Thanks')), 'Thinking…');
});

test('parallel calls: agents counted, others as the newest plus a count', () => {
  const agents = call('m1', 't1', 'Agent', { description: 'a' }) + call('m1', 't2', 'Agent', { description: 'b' });
  assert.equal(busy(agents), 'Running 2 agents');
  assert.equal(busy(agents + result('t1')), 'Running agent: b');
  const mixed = call('m1', 't1', 'Read', { file_path: '/a/x.js' }) + call('m1', 't2', 'Grep', { pattern: 'foo' });
  assert.equal(busy(mixed), "Searching for 'foo' (+1 more)");
  // A new message means the old calls are settled, results seen or not.
  assert.equal(busy(mixed + call('m2', 't3', 'Write', { file_path: '/a/y.js' })), 'Writing y.js');
});

test('waiting and idle sessions', () => {
  const act = activity.scan(undefined, call('m1', 't1', 'Bash', { command: 'rm -rf build' }));
  assert.equal(activity.describe(act, 'waiting', 'permission prompt'), 'Waiting: permission prompt');
  assert.equal(activity.describe(act, 'waiting', ''), 'Waiting: for you');
  assert.equal(activity.describe(act, 'idle'), '');
  assert.equal(activity.describe(act, ''), '');
  assert.equal(activity.describe(undefined, 'busy'), 'Thinking…');
});

test('a turn that has ended: waiting for its background agents, or finishing', () => {
  const reply = (mid) =>
    line({
      type: 'assistant',
      message: { model: 'claude-opus-5-5', id: mid, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Started them.' }] },
    });
  const bg = call('m1', 't1', 'Agent', { description: 'Audit the docs', run_in_background: true }) + result('t1', 'Started');
  const act = activity.scan(undefined, prompt('Check the docs') + bg + reply('m2'));
  assert.equal(act.last, 'end');
  assert.equal(activity.describe(act, 'busy', '', { agents: 1 }), 'Waiting for 1 agent');
  assert.equal(activity.describe(act, 'busy', '', { agents: 3 }), 'Waiting for 3 agents');
  assert.equal(activity.describe(act, 'busy', '', { agents: 0 }), 'Finishing…');
  assert.equal(activity.describe(act, 'busy'), 'Finishing…');
  assert.equal(activity.describe(act, 'idle', '', { agents: 1 }), '');
  assert.equal(activity.describe(act, 'waiting', 'permission prompt', { agents: 1 }), 'Waiting: permission prompt');

  // turn_duration ends a turn too; a new prompt starts the next one.
  const timed = activity.scan(undefined, bg + line({ type: 'system', subtype: 'turn_duration', durationMs: 900 }));
  assert.equal(activity.describe(timed, 'busy', '', { agents: 2 }), 'Waiting for 2 agents');
  activity.scan(timed, prompt('And the tests'));
  assert.equal(activity.describe(timed, 'busy', '', { agents: 2 }), 'Thinking…');

  // Still mid-turn: running agents don't change what the session itself is doing.
  const mid = activity.scan(undefined, bg + block('m3', { type: 'text', text: 'Meanwhile…' }));
  assert.equal(activity.describe(mid, 'busy', '', { agents: 1 }), 'Writing a reply…');
  const calling = activity.scan(undefined, bg + call('m3', 't2', 'Read', { file_path: '/a/x.js' }));
  assert.equal(activity.describe(calling, 'busy', '', { agents: 1 }), 'Reading x.js');
});

test('noise, meta lines, sidechains, synthetic messages and bad lines are ignored', () => {
  const base = call('m1', 't1', 'Read', { file_path: '/a/x.js' });
  const noise =
    '{"type":"attachment","attachment":{"type":"environment"}}\n' +
    '{"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>x</system-reminder>"}}\n' +
    line({ type: 'assistant', isSidechain: true, message: { id: 'side', content: [{ type: 'tool_use', id: 's1', name: 'Write', input: {} }] } }) +
    line({ type: 'assistant', message: { model: '<synthetic>', id: 'syn', content: [{ type: 'text', text: 'x' }] } }) +
    '{"type":"user","message":{"content":[{"type":"tool_r\n' +
    '\n';
  assert.equal(busy(base + noise), 'Reading x.js');
  // In a subagent's own transcript every line is a sidechain line.
  const side = line({ type: 'assistant', isSidechain: true, message: { id: 'm', content: [{ type: 'tool_use', id: 'a', name: 'Glob', input: { pattern: '*.md' } }] } });
  assert.equal(activity.describe(activity.scan(undefined, side, { sidechain: true }), 'busy'), 'Finding *.md');
});

test('turn end and compaction settle running calls', () => {
  const c = call('m1', 't1', 'Bash', { command: 'sleep 100' });
  assert.equal(busy(c + '{"type":"system","subtype":"turn_duration","durationMs":5}\n'), 'Finishing…');
  assert.equal(busy(c + '{"type":"system","subtype":"compact_boundary","compactMetadata":{}}\n'), 'Thinking…');
});

test('only the tail of a huge chunk is read', () => {
  const filler = prompt('x'.repeat(1000)).repeat(400); // ~400KB
  assert.equal(busy(call('m0', 't0', 'Write', { file_path: '/a/old.js' }) + filler), 'Thinking…');
  assert.equal(busy(filler + call('m1', 't1', 'Read', { file_path: '/a/new.js' })), 'Reading new.js');
});

test('readChunk keeps the activity across appended chunks', () => {
  const info = {};
  transcripts.readChunk(info, fixture('activity.jsonl'));
  // Read finished, Grep still running.
  assert.equal(activity.describe(info.act, 'busy'), "Searching for 'navigator.onLine'");
  transcripts.readChunk(info, fixture('activity-part2.jsonl'));
  assert.equal(activity.describe(info.act, 'busy'), 'Editing ExportButton.tsx');
  assert.equal(activity.describe(info.act, 'idle'), '');
});
