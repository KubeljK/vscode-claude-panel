// Accounts: one Claude Code config directory each, the one CLAUDE_CONFIG_DIR selects, from claudeSessions.accounts.
// Plain functions, no VS Code, so the tests can run them.
const os = require('os');
const path = require('path');
const { claudeDir } = require('./transcripts');

const COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];

/**
 * The accounts to read: the setting's entries with a label and an absolute or ~ configDir, the first one for a
 * folder winning. With none, the one account Claude Code uses here: ~/.claude or $CLAUDE_CONFIG_DIR, unlabelled.
 */
function resolve(entries, { command = 'claude', env = process.env, home = os.homedir() } = {}) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const label = typeof e?.label === 'string' ? e.label.trim() : '';
    const raw = typeof e?.configDir === 'string' ? e.configDir.trim() : '';
    if (!label || !(raw === '~' || raw.startsWith('~/') || path.isAbsolute(raw))) continue;
    const dir = claudeDir({ CLAUDE_CONFIG_DIR: raw }, home);
    if (out.some((a) => a.dir === dir)) continue;
    out.push({
      label,
      dir,
      command: (typeof e.command === 'string' && e.command.trim()) || command,
      color: COLOR_NAMES.includes(e.color) ? e.color : '',
    });
  }
  return out.length ? out : [{ label: '', dir: claudeDir(env, home), command, color: '' }];
}

/** The account whose config directory holds `file` (a transcript), if any. */
function ofFile(accounts, file) {
  return typeof file === 'string' ? accounts.find((a) => file.startsWith(a.dir + path.sep)) : undefined;
}

/**
 * The environment a session terminal for `account` needs: its folder in CLAUDE_CONFIG_DIR, except ~/.claude, which
 * works only with the variable unset (set to ~/.claude, Claude Code looks for its login elsewhere and starts logged
 * out); null unsets it. undefined: nothing to add, as when no accounts are configured.
 */
function terminalEnv(account, { env = process.env, home = os.homedir() } = {}) {
  if (!account?.label) return undefined;
  if (account.dir !== path.join(home, '.claude')) return { CLAUDE_CONFIG_DIR: account.dir };
  return (env.CLAUDE_CONFIG_DIR || '').trim() ? { CLAUDE_CONFIG_DIR: null } : undefined;
}

/** Whether a terminal created with `env` runs the account whose terminalEnv() is `want`: so it can be reused. */
const sameEnv = (env, want) => (env?.CLAUDE_CONFIG_DIR || '') === (want?.CLAUDE_CONFIG_DIR || '');

/** A folder as you'd type it: ~ for your home directory. */
function display(dir, home = os.homedir()) {
  return dir === home ? '~' : dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

module.exports = { resolve, ofFile, terminalEnv, sameEnv, display };
