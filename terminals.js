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

// Whether a terminal still has a shell: a revive that failed leaves a tab with no pty, and text sent to it is lost.
// Its processId may never settle, so give up after `timeout` ms.
async function hasShell(terminal, { timeout = 1000, isAlive = alive } = {}) {
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, timeout)));
  try {
    const pid = await Promise.race([Promise.resolve(terminal.processId).catch(() => undefined), late]);
    return Boolean(pid) && isAlive(pid);
  } finally {
    clearTimeout(timer);
  }
}

const startExpired = (since, now = Date.now()) => since !== undefined && now - since > STARTING_MS;

module.exports = { STARTING_MS, alive, hasShell, startExpired };
