// Sessions running elsewhere (a live Claude process with no terminal in this window): which are active enough for
// the "Running elsewhere" section, and where they run. Plain functions on live records, so the tests can run them.
//
// The Claude desktop app keeps a session's process alive for as long as it's in the app's sidebar, so a live record
// alone says little: one idle for days is history, not something running.

const HOUR = 3600000;

/** When a live record's status last changed: statusUpdatedAt, else updatedAt, else `fallback` (transcript mtime). */
function since(rec, fallback) {
  for (const t of [rec?.statusUpdatedAt, rec?.updatedAt, fallback]) if (t > 0) return t;
  return 0;
}

/**
 * Does a session running elsewhere belong in that section? Yes while it's busy, waiting, starting (any status but
 * idle), has subagents running, or went idle less than `hours` ago. `hours` 0 (or not a number) keeps every one, as
 * before there was a cut-off; so does an idle record that doesn't say since when.
 */
function active(rec, { hours = 1, now = Date.now(), mtime = 0, agents = 0 } = {}) {
  if (!rec) return false;
  if (!(hours > 0) || rec.status !== 'idle' || agents > 0) return true;
  const t = since(rec, mtime);
  return !t || now - t < hours * HOUR;
}

/**
 * Is any session, running or not, recent by the same cut-off? Open in this window: always. Running elsewhere: as
 * active() says. Not running: last active (transcript mtime) less than `hours` ago, or subagents still running.
 * `hours` 0 makes every session recent. For listing a parent's older children behind "Show N older".
 */
function recent({ rec, open = false, hours = 1, now = Date.now(), mtime = 0, agents = 0 } = {}) {
  if (!(hours > 0) || open) return true;
  if (rec) return active(rec, { hours, now, mtime, agents });
  return agents > 0 || (mtime > 0 && now - mtime < hours * HOUR);
}

/** Where it runs, for a tag on its card: 'app' for the Claude desktop app; '' for a terminal or anything unknown. */
const where = (rec) => (rec?.entrypoint === 'claude-desktop' ? 'app' : '');

module.exports = { since, active, recent, where };
