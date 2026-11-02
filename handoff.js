// "Resume in Claude Desktop": after /desktop, the session's terminal closes once the desktop app runs the session,
// but only while that terminal is still the one the session left. A plain function, so the tests can run it.

const WINDOW = 60000; // how long after /desktop the app may take to pick the session up
const EMPTY = 15000; // how long the terminal may sit with no Claude in it meanwhile

/**
 * What to do with a hand-off ({ id, at, emptySince }, updated in place) on a poll: 'dispose' the terminal (the app
 * runs the session and nothing else runs in the terminal), 'drop' the hand-off (another session runs in the
 * terminal, it's been empty too long, or the window passed: /desktop failed or nothing came of it), or 'keep'
 * waiting. `running`: the session id running in the terminal now, if any; `inApp`: the app runs `id`.
 */
function step(entry, { now = Date.now(), running, inApp = false } = {}) {
  if (running && running !== entry.id) return 'drop';
  if (inApp && !running) return 'dispose';
  if (now - entry.at > WINDOW) return 'drop';
  if (running) entry.emptySince = 0;
  else if (!entry.emptySince) entry.emptySince = now;
  else if (now - entry.emptySince > EMPTY) return 'drop';
  return 'keep';
}

module.exports = { step, WINDOW, EMPTY };
