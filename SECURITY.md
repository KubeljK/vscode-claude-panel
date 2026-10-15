# Security

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/bkaluza/vscode-claude-panel/security/advisories/new),
not in a public issue.

The extension has no runtime dependencies and makes no network requests. It reads Claude Code's local session and
transcript files (`~/.claude`, or `CLAUDE_CONFIG_DIR`) and never writes to them, and it starts Claude Code in
VS Code terminals with the command and arguments from your settings.
