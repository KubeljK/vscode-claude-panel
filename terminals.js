// Terminals the panel starts Claude in: whether a revived one still has a shell, and how long "Starting…" lasts.
// Plain functions, no VS Code, so the tests can run them.

/** How long a card shows "Starting…" before we stop waiting for Claude to register. */
const STARTING_MS = 30000;

// Signal 0 only checks the pid exists; EPERM means it does, just not ours.
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A terminal's shell pid, or undefined: a revive that failed leaves a tab whose processId may never settle, so give
// up after `timeout` ms rather than wait on it.
async function pidOf(terminal, timeout = 1000) {
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, timeout)));
  try {
    return await Promise.race([Promise.resolve(terminal.processId).catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

// Whether a terminal still has a shell: a revive that failed leaves a tab with no pty, and text sent to it is lost.
async function hasShell(terminal, { timeout = 1000, isAlive = alive } = {}) {
  const pid = await pidOf(terminal, timeout);
  return Boolean(pid) && isAlive(pid);
}

const startExpired = (since, now = Date.now()) => since !== undefined && now - since > STARTING_MS;

/**
 * A terminal we started Claude in, before Claude has registered it: 'drop' it once it's closed or Claude runs in
 * it; else 'show' its card as "Starting…" for STARTING_MS, then 'hold' it without a card. Held, it stays out of
 * reuse, as Claude may still be starting or at a login prompt there.
 */
function pendingState({ open, running, since, now = Date.now() }) {
  if (!open || running) return 'drop';
  return startExpired(since, now) ? 'hold' : 'show';
}

module.exports = { STARTING_MS, alive, pidOf, hasShell, startExpired, pendingState };
