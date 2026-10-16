// Session colours: Claude Code's /color is the session's colour, and one picked in the panel stands in for it only
// until Claude Code reports a newer one. Plain functions, no VS Code, so the tests can run them.

/** A colour from Claude Code's agent-color record, or undefined for none: /color default records 'default'. */
const fromClaude = (c) => (c && c !== 'default' ? c : undefined);

/** Has Claude Code reported a colour since the panel's pick (pref: { color, colorWas })? /color, typed or ours. */
const superseded = (pref, claude) => !!pref?.color && fromClaude(claude) !== pref.colorWas;

/** The colour to show: the panel's pick ('default' for none) until it's superseded, else Claude Code's. */
function shown(pref, claude) {
  return pref?.color && !superseded(pref, claude) ? fromClaude(pref.color) : fromClaude(claude);
}

/** The panel's pick, to pass on as /color, unless Claude Code already has it or has moved on since. */
function toSend(pref, claude) {
  if (!pref?.color || superseded(pref, claude)) return undefined;
  return fromClaude(pref.color) === fromClaude(claude) ? undefined : pref.color;
}

module.exports = { fromClaude, superseded, shown, toSend };
