// The read-only transcript view, host side and without the VS Code API (so this can be unit-tested): a transcript
// folded into timeline items for the webview, read from its tail and kept up to date as it grows.
//
// Claude Code 2.1 writes one content block per line, when the block completes; an API message spans several
// consecutive lines sharing message.id. A tool result is a user line holding a tool_result block; it patches the
// call it answers. Unknown entry types are ignored and a line that doesn't parse is counted, never fatal.
const fs = require('fs');
const path = require('path');
const usage = require('./usage');

const TOOL_CAP = 4000; // chars of a tool input or result sent to the webview
const TEXT_CAP = 20000; // chars of a message
const INITIAL = 4 * 1024 * 1024; // first read: the last 4MB
const EARLIER = 2 * 1024 * 1024; // each "Load earlier"
const ITEM_CAP = 1500; // items kept as the transcript grows

function clip(s, cap) {
  if (typeof s !== 'string') return '';
  return s.length > cap ? `${s.slice(0, cap)}\n… ${(s.length - cap).toLocaleString('en')} more characters` : s;
}

const resultText = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : b?.type ? `[${b.type}]` : '')).join('\n')
      : '';

const tag = (s, t) => {
  const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(s);
  return m ? m[1].trim() : undefined;
};

const SUMMARY_KEYS = ['description', 'command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'path', 'prompt'];

/** A tool call's one-line summary: its most telling input. */
function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of SUMMARY_KEYS) if (typeof input[k] === 'string' && input[k].trim()) return input[k].trim().split('\n')[0].slice(0, 200);
  return Object.keys(input).slice(0, 4).join(', ');
}

/** A tool call's input for its card: a shell command as itself, anything else as JSON. */
function inputText(name, input) {
  if ((name === 'Bash' || name === 'PowerShell') && typeof input?.command === 'string') return input.command;
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return '';
  }
}

const isAgent = (name) => name === 'Agent' || name === 'Task';
const AGENT_ID_RE = /agentId: ([\w-]+)/;

/**
 * Timeline items, folded from transcript lines. Items are plain JSON for postMessage, each with a `seq` (its order;
 * earlier pages get lower ones) and `off` (byte offset of its line, for trimming and "Load earlier"). Kinds:
 * user, assistant, thinking, tool, agentDone, command, divider, notice, turnEnd.
 */
class Timeline {
  constructor() {
    this.items = [];
    this.byTool = new Map(); // tool_use id → its item
    this.orphans = new Map(); // tool_use id → result whose call is before what has been read
    this.meta = {}; // model, branch, ctx, title fields: from the newest lines
    this.bad = 0; // lines that didn't parse
    this.next = 0;
    this.added = [];
    this.changed = new Set();
  }

  /** Folds a buffer of whole lines that starts at byte `base`, appending. */
  feed(buf, base) {
    for (const [d, off] of lines(buf, base, this)) {
      const before = this.items.length;
      this.fold(d, off, this.items, true);
      for (let i = before; i < this.items.length; i++) {
        this.items[i].seq = this.next++;
        this.added.push(this.items[i]);
      }
    }
  }

  /** Folds whole lines from before everything read so far; returns the new items, oldest first. */
  feedEarlier(buf, base) {
    const out = [];
    for (const [d, off] of lines(buf, base, this)) this.fold(d, off, out, false);
    let seq = this.items.length ? this.items[0].seq : 0;
    for (let i = out.length - 1; i >= 0; i--) out[i].seq = --seq;
    for (const it of out) this.changed.delete(it); // results within the page: already in the items sent
    this.items.unshift(...out);
    return out;
  }

  /** Items added and items changed (a tool call that got its result) since the last drain. */
  drain() {
    const added = this.added;
    const fresh = new Set(added);
    const changed = [...this.changed].filter((it) => !fresh.has(it) && this.items.includes(it));
    this.added = [];
    this.changed = new Set();
    return { added, changed };
  }

  /** Drops the oldest items beyond `cap`; returns the offset everything kept starts at. */
  trim(cap) {
    if (this.items.length <= cap) return undefined;
    const drop = this.items.splice(0, this.items.length - cap);
    for (const it of drop) if (it.k === 'tool') this.byTool.delete(it.id);
    return this.items[0].off;
  }

  fold(d, off, out, newest) {
    if (!d || typeof d !== 'object') return;
    const push = (it) => out.push(Object.assign(it, { off, ts: typeof d.timestamp === 'string' ? d.timestamp : '' }));
    if (newest) this.noteMeta(d);
    switch (d.type) {
      case 'system':
        if (d.subtype === 'compact_boundary') {
          const m = d.compactMetadata || {};
          push({ k: 'divider', trigger: m.trigger === 'manual' ? 'manual' : 'auto', pre: +m.preTokens || 0, post: +m.postTokens || 0 });
        } else if (d.subtype === 'turn_duration' && d.durationMs > 0) push({ k: 'turnEnd', ms: d.durationMs });
        else if (d.subtype === 'api_error') push({ k: 'notice', level: 'error', text: `API error${d.retryAttempt ? `, retrying (${d.retryAttempt}/${d.maxRetries || '?'})` : ''}` });
        return;
      case 'user':
        return this.foldUser(d, push);
      case 'assistant':
        return this.foldAssistant(d, push);
    }
    // attachment, queue-operation, permission-mode, file-history-*, api-request*, cost-state…: not shown
  }

  noteMeta(d) {
    const m = this.meta;
    if (typeof d.gitBranch === 'string' && d.gitBranch) m.branch = d.gitBranch;
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') m.aiTitle = d.aiTitle;
    if (d.type === 'custom-title' && typeof d.customTitle === 'string') m.customTitle = d.customTitle;
    if (d.type === 'agent-name' && typeof d.agentName === 'string') m.name = d.agentName;
    if (d.type === 'system' && d.subtype === 'compact_boundary' && d.compactMetadata?.postTokens > 0) m.ctx = d.compactMetadata.postTokens;
    const msg = d.type === 'assistant' && d.message;
    if (msg?.usage && msg.model !== '<synthetic>') {
      const u = msg.usage;
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx > 0) m.ctx = ctx;
      if (typeof (d.requestedModel || msg.model) === 'string') m.model = d.requestedModel || msg.model;
    }
  }

  foldUser(d, push) {
    if (d.isMeta || d.isCompactSummary) return;
    const c = d.message?.content;
    const blocks = Array.isArray(c) ? c : [];
    if (typeof c === 'string' || !blocks.some((b) => b?.type === 'tool_result')) {
      const text = typeof c === 'string' ? c : blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
      const images = blocks.filter((b) => b?.type === 'image').length;
      if (d.origin?.kind === 'task-notification' || text.trimStart().startsWith('<task-notification>')) {
        return push({
          k: 'agentDone',
          agentId: (tag(text, 'task-id') || '').replace(/[^\w-]/g, ''),
          status: tag(text, 'status') || '',
          summary: clip(tag(text, 'summary') || '', 400),
          result: clip(tag(text, 'result') || '', TOOL_CAP),
        });
      }
      const cmd = tag(text, 'command-name');
      if (cmd) return push({ k: 'command', text: clip(`${cmd} ${tag(text, 'command-args') || ''}`.trim(), 400) });
      if (/^\s*<(local-command-stdout|local-command-stderr|system-reminder|command-message)>/.test(text)) return;
      if (/^\[Request interrupted by user/.test(text)) return push({ k: 'notice', level: 'info', text: 'Interrupted' });
      if (!text.trim() && !images) return;
      return push({ k: 'user', text: clip(text, TEXT_CAP), images });
    }
    const tur = d.toolUseResult && typeof d.toolUseResult === 'object' ? d.toolUseResult : {};
    for (const b of blocks) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const text = resultText(b.content);
      const r = { text: clip(text, TOOL_CAP), error: !!b.is_error };
      const images = Array.isArray(b.content) ? b.content.filter((x) => x?.type === 'image').length : 0;
      if (images) r.images = images;
      const call = this.byTool.get(b.tool_use_id);
      const agentId = typeof tur.agentId === 'string' ? tur.agentId : (AGENT_ID_RE.exec(text) || [])[1];
      if (agentId && /^[\w-]+$/.test(agentId)) r.agentId = agentId;
      if (call) {
        call.result = r;
        if (r.agentId) call.agentId = r.agentId;
        this.changed.add(call);
      } else this.orphans.set(b.tool_use_id, r);
    }
  }

  foldAssistant(d, push) {
    const m = d.message;
    if (!m || !Array.isArray(m.content)) return;
    const error = !!d.isApiErrorMessage;
    for (const b of m.content) {
      if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
        const text = typeof b.thinking === 'string' ? b.thinking : '';
        push({ k: 'thinking', text: clip(text, TEXT_CAP) });
      } else if (b?.type === 'text' && typeof b.text === 'string') {
        if (m.model === '<synthetic>' && !error) continue; // "No response requested." and the like
        push({ k: 'assistant', text: clip(b.text, TEXT_CAP), error });
      } else if (b?.type === 'tool_use' && typeof b.id === 'string') {
        const name = typeof b.name === 'string' ? b.name : 'Tool';
        const it = { k: 'tool', id: b.id, name, summary: summarize(b.input), input: clip(inputText(name, b.input), TOOL_CAP), agent: isAgent(name) };
        const r = this.orphans.get(b.id);
        if (r) {
          it.result = r;
          if (r.agentId) it.agentId = r.agentId;
          this.orphans.delete(b.id);
        }
        this.byTool.set(b.id, it);
        push(it);
      }
    }
  }
}

/** [entry, byte offset] for each line of `buf` (whole lines) that parses; counts the ones that don't. */
function* lines(buf, base, t) {
  for (let i = 0; i < buf.length; ) {
    let end = buf.indexOf(10, i);
    if (end < 0) end = buf.length;
    if (end > i) {
      let d;
      try {
        d = JSON.parse(buf.toString('utf8', i, end));
      } catch {
        t.bad++;
      }
      if (d) yield [d, base + i];
    }
    i = end + 1;
  }
}

/**
 * One transcript file, read from its end and followed as it grows: whole lines only, from the start again if it
 * shrinks. poll() and earlier() return what the webview needs to hear, or undefined for nothing.
 */
class Tail {
  constructor(file, { initial = INITIAL, chunk = EARLIER, cap = ITEM_CAP } = {}) {
    Object.assign(this, { file, initial, chunk, cap });
    this.reset();
  }

  reset() {
    this.t = new Timeline();
    this.start = 0; // first byte read
    this.offset = 0; // end of the last whole line read
    this.size = -1;
    this.limit = this.cap;
  }

  /** Reads the last `initial` bytes, from a line start. */
  async open() {
    this.reset();
    const st = await fs.promises.stat(this.file);
    const { buf, start } = await readBack(this.file, st.size, this.initial);
    const end = buf.lastIndexOf(10) + 1;
    this.t.feed(buf.subarray(0, end), start);
    this.t.drain();
    Object.assign(this, { start, offset: start + end, size: st.size });
    this.trimmed();
    return { type: 'init', items: [...this.t.items], hasEarlier: this.start > 0 };
  }

  /** New lines since the last read: { type: 'append', items, changed, first } — or 'init' after a rewrite. */
  async poll() {
    let st;
    try {
      st = await fs.promises.stat(this.file);
    } catch {
      return undefined;
    }
    if (st.size < this.offset) return this.open();
    if (st.size === this.offset) return undefined;
    const fh = await fs.promises.open(this.file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(st.size - this.offset);
      await fh.read(buf, 0, buf.length, this.offset);
    } finally {
      await fh.close();
    }
    const end = buf.lastIndexOf(10) + 1; // a half-written line is read next time
    if (!end) return undefined;
    this.t.feed(buf.subarray(0, end), this.offset);
    this.offset += end;
    this.size = st.size;
    const { added, changed } = this.t.drain();
    const first = this.trimmed();
    if (!added.length && !changed.length && first === undefined) return undefined;
    return { type: 'append', items: added, changed, first: first ?? this.t.items[0]?.seq, hasEarlier: this.start > 0 };
  }

  /** The `chunk` bytes before what has been read: { type: 'prepend', items, hasEarlier }. */
  async earlier() {
    if (this.start <= 0) return { type: 'prepend', items: [], hasEarlier: false };
    let items = [];
    // A page may hold nothing to show (one huge tool result, say): keep going until it does or the file starts.
    while (this.start > 0 && !items.length) {
      const { buf, start } = await readBack(this.file, this.start, this.chunk);
      items = this.t.feedEarlier(buf, start);
      this.start = start;
    }
    this.limit = Math.max(this.limit, this.t.items.length); // asked for: not trimmed away again
    return { type: 'prepend', items, hasEarlier: this.start > 0 };
  }

  // Past the cap the oldest items go; "Load earlier" reads them back from where the kept ones start.
  trimmed() {
    const off = this.t.trim(this.limit);
    if (off === undefined) return undefined;
    this.start = off;
    return this.t.items[0].seq;
  }

  /** model, branch and context use, from the newest lines read. */
  header() {
    const m = this.t.meta;
    return {
      model: m.model || '',
      branch: m.branch && m.branch !== 'HEAD' ? m.branch : '',
      ctx: m.ctx ? [m.ctx, usage.contextWindow(m.model, m.ctx)] : undefined,
      bad: this.t.bad,
    };
  }
}

/** The bytes from the first line start at or after `end - size` up to `end`; if that's all one line, from its start. */
async function readBack(file, end, size) {
  const fh = await fs.promises.open(file, 'r');
  const read = async (from, to) => {
    const b = Buffer.alloc(Math.max(0, to - from));
    await fh.read(b, 0, b.length, from);
    return b;
  };
  try {
    let start = Math.max(0, end - size);
    if (start > 0) {
      const win = await read(start - 1, end); // from the byte before, in case it ends a line
      const nl = win.indexOf(10);
      if (nl >= 0 && nl < win.length - 1) start += nl;
      else {
        // One line longer than the page: back to where it starts.
        let to = start;
        start = 0;
        while (to > 0) {
          const from = Math.max(0, to - size);
          const i = (await read(from, to)).lastIndexOf(10);
          if (i >= 0) {
            start = from + i + 1;
            break;
          }
          to = from;
        }
      }
    }
    return { buf: await read(start, end), start };
  } finally {
    await fh.close();
  }
}

/** Where a transcript's subagents live: <session>/subagents/ next to a session, the same folder for an agent. */
function agentsDir(file) {
  const dir = path.dirname(file);
  return path.basename(dir) === 'subagents' ? dir : path.join(dir, path.basename(file, '.jsonl'), 'subagents');
}

/** A subagent's transcript, for an id the webview sent: only a plain id, only a file that exists. */
function agentFile(file, agentId) {
  if (typeof agentId !== 'string' || !/^[\w-]+$/.test(agentId)) return undefined;
  const f = path.join(agentsDir(file), `agent-${agentId}.jsonl`);
  return fs.existsSync(f) ? f : undefined;
}

/** toolUseId → agentId, from the subagents' meta files: names agents whose call hasn't returned yet. */
async function agentIds(file) {
  const dir = agentsDir(file);
  const out = new Map();
  for (const n of await fs.promises.readdir(dir).catch(() => [])) {
    const m = /^agent-([\w-]+)\.meta\.json$/.exec(n);
    if (!m) continue;
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8'));
      if (typeof meta.toolUseId === 'string') out.set(meta.toolUseId, m[1]);
    } catch {}
  }
  return out;
}

module.exports = { Timeline, Tail, readBack, summarize, agentsDir, agentFile, agentIds, ITEM_CAP };
