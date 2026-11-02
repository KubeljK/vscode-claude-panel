// Context usage per session: how full the context window was after the last turn, like Claude Code's
// status line ("160.4K used / 839.6K left"). Read from the transcript chunk readSession has just read.

const M = 1000000;
const K200 = 200000;

/**
 * The context in use at the end of `text` (a run of whole JSONL lines), or undefined if the chunk has
 * nothing that says. Walks lines backwards and JSON-parses only the one it stops at:
 *  - a main-chain assistant message: input + cache_read + cache_creation tokens of its request
 *  - a compact boundary: the post-compaction size, until the next assistant message
 * Returns { ctx, ctxModel? }, ready to merge into the session info.
 */
function scan(text) {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end);
    end = start - 1;
    if (line.includes('"isSidechain":true')) continue;
    const assistant = line.includes('"type":"assistant"') && line.includes('"usage"');
    const compact = !assistant && line.includes('"subtype":"compact_boundary"');
    if (!assistant && !compact) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (compact && d.subtype === 'compact_boundary') {
      const post = d.compactMetadata?.postTokens;
      if (post > 0) return { ctx: post };
      continue;
    }
    const m = d.type === 'assistant' && d.message;
    const u = m?.usage;
    if (!u || m.model === '<synthetic>') continue;
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (ctx > 0) return { ctx, ctxModel: d.requestedModel || m.model };
  }
}

/**
 * When the prompt cache was last written and for how long it lasts, as Claude Code's cache works (like the
 * cache-clock status line): the latest main-chain assistant message with usage sets cacheAt (its timestamp); its
 * usage.cache_creation says the TTL, 1 h (ephemeral_1h_input_tokens) or 5 min (ephemeral_5m_input_tokens), and when it
 * created nothing, an earlier message's does. `prev` is what earlier chunks found: the TTL carries over from it.
 * Returns { cacheAt, cacheTtl: '1h' | '5m' | '' } to merge into the session info, or undefined when `text` has no
 * such message.
 */
function cacheScan(text, prev = {}) {
  let cacheAt = 0;
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end);
    end = start - 1;
    if (line.includes('"isSidechain":true') || !line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d.type === 'assistant' && !d.isSidechain && d.message;
    if (!m?.usage || m.model === '<synthetic>') continue;
    if (!cacheAt) {
      cacheAt = Date.parse(d.timestamp) || 0;
      if (!cacheAt) continue;
    }
    const c = m.usage.cache_creation || {};
    if (c.ephemeral_1h_input_tokens > 0) return { cacheAt, cacheTtl: '1h' };
    if (c.ephemeral_5m_input_tokens > 0) return { cacheAt, cacheTtl: '5m' };
  }
  return cacheAt ? { cacheAt, cacheTtl: prev.cacheTtl || '' } : undefined;
}

/** When a session's cache goes cold, in epoch ms, or 0 when nothing says; an unknown TTL counts as 5 min. */
const coldAt = (info) => (info?.cacheAt > 0 ? info.cacheAt + (info.cacheTtl === '1h' ? 3600000 : 300000) : 0);

/**
 * Context window for a model. Transcripts don't record it, so:
 *  - an explicit `[1m]` model suffix (Claude Code writes it to requestedModel) → 1M
 *  - Claude 3.x and 4.x models → 200K (their 1M variants carry `[1m]`)
 *  - anything newer (opus-5, opus-5-5, fable-5…) → 1M: these run past 200K routinely in real transcripts
 *  - and never less than what's in use: a session holding more than 200K must have the 1M window.
 */
function contextWindow(model = '', used = 0) {
  let w = /\[1m\]/i.test(model) ? M : /^claude-(3|(opus|sonnet|haiku)-4)\b/.test(model) ? K200 : M;
  if (used > w) w = M;
  return w;
}

/** Compact [used, window] for the panel payload, or undefined when the session has no usage yet. */
function forPayload(info, override) {
  if (!info?.ctx) return undefined;
  return [info.ctx, override > 0 ? override : contextWindow(info.ctxModel, info.ctx)];
}

module.exports = { scan, cacheScan, coldAt, contextWindow, forPayload };
