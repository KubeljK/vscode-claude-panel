// What a session is doing right now, as one short line for its card: "Editing extension.js", "Running npm test",
// "Thinking…". Read from the newest transcript entries, in the same incremental pass that reads the rest.
//
// Claude Code writes a content block when it completes, so the block in progress is never in the file. A tool call
// whose result hasn't arrived is running; once every call of the latest message has its result, the model is at
// work on the next block, which is all we can say about it ("Thinking…").

const TAIL = 256 * 1024; // of a large chunk (the first read of a long transcript), only the end can matter
const MAX = 72; // characters in the line

const short = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};
const base = (p) => short(String(p || '').split(/[\\/]/).filter(Boolean).pop() || '', 40);
const quoted = (s, n) => `'${short(s, n)}'`;

// Words that start something better left out of a panel: credentials, headers, tokens.
const SENSITIVE = /auth|token|secret|passw|bearer|api[-_]?key|cookie|credential|session/i;
const TOKENISH = /^(?=.*\d)(?=.*[A-Za-z])[\w+=-]{20,}$/;

/** The first few words of a shell command, stopping before anything that could be a secret. */
function command(cmd) {
  const words = String(cmd || '').split('\n')[0].trim().split(/\s+/);
  while (words.length && /^\w+=/.test(words[0])) words.shift(); // FOO=bar before the command
  const out = [];
  for (let w of words) {
    if (out.length === 4 || !w) break;
    w = w.replace(/^["']|["']$/g, '');
    if (SENSITIVE.test(w) || TOKENISH.test(w) || /^-(H|u|p)$|^--(header|user|password|token)\b/.test(w)) break;
    if (w.includes('://')) {
      try {
        w = new URL(w).host;
      } catch {
        break;
      }
    }
    out.push(w);
  }
  return short(out.join(' '), 48) + (out.length < words.length && out.length ? ' …' : '');
}

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function mcp(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return;
  const server = m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ');
  let tool = m[2];
  const prefix = server.toLowerCase().replace(/ /g, '_') + '_';
  if (tool.toLowerCase().startsWith(prefix)) tool = tool.slice(prefix.length);
  return `Using ${short(server, 24)} ${short(tool.replace(/_/g, ' '), 32)}`;
}

/** One tool call as a line: only file names, never whole paths or arguments. */
function label(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const str = (k) => (typeof i[k] === 'string' ? i[k] : '');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      if (str('description')) return short(str('description'), MAX);
      return str('command') ? `Running ${command(str('command'))}` : 'Running a command';
    case 'Read':
      return str('file_path') ? `Reading ${base(str('file_path'))}` : 'Reading a file';
    case 'Edit':
    case 'MultiEdit':
      return str('file_path') ? `Editing ${base(str('file_path'))}` : 'Editing a file';
    case 'Write':
      return str('file_path') ? `Writing ${base(str('file_path'))}` : 'Writing a file';
    case 'NotebookEdit':
      return str('notebook_path') ? `Editing ${base(str('notebook_path'))}` : 'Editing a notebook';
    case 'Grep':
      return str('pattern') ? `Searching for ${quoted(str('pattern'), 32)}` : 'Searching';
    case 'Glob':
      return str('pattern') ? `Finding ${short(str('pattern'), 40)}` : 'Finding files';
    case 'WebFetch':
      return host(str('url')) ? `Fetching ${host(str('url'))}` : 'Fetching a page';
    case 'WebSearch':
      return str('query') ? `Searching the web for ${quoted(str('query'), 36)}` : 'Searching the web';
    case 'Agent':
    case 'Task':
      return str('description') ? `Running agent: ${short(str('description'), 48)}` : 'Running an agent';
    case 'TodoWrite':
      return 'Updating the to-do list';
    case 'Skill':
      return str('skill') ? `Using skill ${short(str('skill'), 40)}` : 'Using a skill';
  }
  return mcp(name) || `Using ${short(name, 40) || 'a tool'}`;
}

const isAgent = (name) => name === 'Agent' || name === 'Task';

/**
 * Folds whole transcript lines, appended since the last call, into `act` (or a new state): { mid, calls, last }.
 * mid: the latest assistant message; calls: its tool calls still waiting for a result, as { id, label, agent };
 * last: the newest entry that says anything ('prompt', 'thinking', 'text', 'tool', 'result', 'end').
 * Sidechain lines are the old inline form of subagents: skipped, unless this is a subagent's own transcript.
 */
function scan(act, text, { sidechain = false } = {}) {
  act = act || { mid: '', calls: [], last: '' };
  let start = 0;
  if (text.length > TAIL) start = text.indexOf('\n', text.length - TAIL) + 1;
  for (let i = start; i < text.length; ) {
    let end = text.indexOf('\n', i);
    if (end < 0) end = text.length;
    const line = text.slice(i, end);
    i = end + 1;
    if (!sidechain && line.includes('"isSidechain":true')) continue;
    if (!/"type":"(user|assistant|system)"/.test(line)) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    fold(act, d);
  }
  return act;
}

function fold(act, d) {
  if (!d || typeof d !== 'object') return;
  if (d.type === 'system') {
    if (d.subtype === 'compact_boundary') Object.assign(act, { mid: '', calls: [], last: 'prompt' });
    else if (d.subtype === 'turn_duration') Object.assign(act, { calls: [], last: 'end' });
    return;
  }
  const c = d.message?.content;
  if (d.type === 'user') {
    if (d.isMeta || d.isCompactSummary) return;
    const blocks = Array.isArray(c) ? c : [];
    const results = blocks.filter((b) => b?.type === 'tool_result');
    if (!results.length) {
      if (typeof c === 'string' || blocks.length) Object.assign(act, { mid: '', calls: [], last: 'prompt' });
      return;
    }
    const done = new Set(results.map((b) => b.tool_use_id));
    act.calls = act.calls.filter((x) => !done.has(x.id));
    act.last = 'result';
    return;
  }
  if (d.type !== 'assistant' || !d.message || d.message.model === '<synthetic>') return;
  const mid = d.message.id || '';
  if (mid !== act.mid) {
    act.mid = mid;
    act.calls = []; // a new request is only sent once every call of the last one has its result
  }
  for (const b of Array.isArray(c) ? c : []) {
    if (b?.type === 'thinking' || b?.type === 'redacted_thinking') act.last = 'thinking';
    else if (b?.type === 'text') act.last = 'text';
    else if (b?.type === 'tool_use' && typeof b.id === 'string') {
      const name = typeof b.name === 'string' ? b.name : '';
      act.calls.push({ id: b.id, label: label(name, b.input), agent: isAgent(name) });
      act.last = 'tool';
    }
  }
  // The final reply of a turn: for a subagent, its result (a completion notice may still be missing).
  if (d.message.stop_reason === 'end_turn' && !act.calls.length) act.last = 'end';
}

/**
 * The line for a card: what a busy session is doing, what a waiting one waits for, '' otherwise. agents: how many
 * of its subagents are running; Claude Code reports a session busy while background agents run after its turn.
 */
function describe(act, status, waitingFor, { agents = 0 } = {}) {
  if (status === 'waiting') return `Waiting: ${short(waitingFor || 'for you', MAX - 9)}`;
  if (status !== 'busy') return '';
  const calls = act?.calls || [];
  if (calls.length > 1 && calls.every((x) => x.agent)) return `Running ${calls.length} agents`;
  if (calls.length > 1) return `${short(calls[calls.length - 1].label, MAX - 12)} (+${calls.length - 1} more)`;
  if (calls.length) return calls[0].label;
  if (act?.last === 'end') return agents > 0 ? `Waiting for ${agents} agent${agents > 1 ? 's' : ''}` : 'Finishing…';
  return act?.last === 'text' ? 'Writing a reply…' : 'Thinking…';
}

module.exports = { scan, describe, label, command };
