// Session names: one given in the panel (Rename…) is passed on to Claude Code as /rename, and stands in for Claude
// Code's own name only until Claude Code reports a newer one, as colours do. Plain functions, no VS Code, so the
// tests can run them.

/** A name fit to type into Claude Code: one line, no control or direction-changing characters, trimmed. */
function clean(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Claude Code's own name for a session, from its transcript (/rename and -n write it there), or undefined. */
const fromClaude = (session) => clean(session?.name || session?.customTitle) || undefined;

/**
 * Has Claude Code's name moved on since the panel's (pref: { alias, aliasWas })? aliasWas is the name Claude Code had
 * when you renamed it in the panel (null for none); our own /rename moves it on too. An alias from before aliasWas
 * was kept only gives way once Claude Code has that same name.
 */
function superseded(pref, claude) {
  if (!pref?.alias) return false;
  if (pref.aliasWas === undefined) return claude !== undefined && claude === clean(pref.alias);
  return (claude ?? null) !== pref.aliasWas;
}

/** The panel's name, to pass on as /rename, unless Claude Code already has it or has moved on since. */
function toSend(pref, claude) {
  const name = clean(pref?.alias);
  if (!name || superseded(pref, claude)) return undefined;
  return name === claude ? undefined : name;
}

module.exports = { clean, fromClaude, superseded, toSend };
