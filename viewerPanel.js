// Read-only transcript views: an editor tab per transcript file, following the file as Claude Code writes it.
// The folding and file reading are in viewer.js; this is the VS Code side.
const vscode = require('vscode');
const fs = require('fs');
const viewer = require('./viewer');

const DEBOUNCE_MS = 100; // Claude Code writes a burst of lines per block
const AGENT_LOOKUP_MS = 2000;

/** file → View */
const views = new Map();
let host; // { extensionUri, describe(target) → header fields, openAgent(target, agentId, file) }

function init(options) {
  host = options;
}

/** Opens a view of target.file ({ file, title, kind, sessionId, agentId }), or shows the one already open. */
function open(target) {
  const v = views.get(target.file);
  if (v) return v.panel.reveal();
  views.set(target.file, new View(target));
}

/** The extension's poll: catches up on anything fs.watch missed, and refreshes the live status. */
function poll() {
  for (const v of views.values()) v.update();
}

function disposeAll() {
  for (const v of [...views.values()]) v.panel.dispose();
}

class View {
  constructor(target) {
    this.target = target;
    this.tail = new viewer.Tail(target.file);
    this.queue = Promise.resolve();
    this.lastHeader = '';
    this.agentLookup = 0;
    const media = vscode.Uri.joinPath(host.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'claudeSessions.viewer',
      target.title || 'Transcript',
      { viewColumn: vscode.ViewColumn.Active },
      { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true }
    );
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.png');
    const wv = this.panel.webview;
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    wv.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${wv.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${wv.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css'))}">
</head><body>
<script nonce="${nonce}" src="${wv.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js'))}"></script>
</body></html>`;
    wv.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => console.error('[claude-sessions] viewer', e)));
    this.panel.onDidDispose(() => this.dispose());
    this.watch();
  }

  // fs.watch for prompt updates; the extension's poll covers platforms and file systems where it's unreliable.
  watch() {
    try {
      this.watcher = fs.watch(this.target.file, () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.update(), DEBOUNCE_MS);
      });
      this.watcher.on('error', () => this.unwatch());
    } catch {
      this.watcher = undefined;
    }
  }

  unwatch() {
    clearTimeout(this.timer);
    try {
      this.watcher?.close();
    } catch {}
    this.watcher = undefined;
  }

  post(m) {
    if (!this.disposed) this.panel.webview.postMessage(m);
  }

  // One read at a time, in order.
  run(fn) {
    this.queue = this.queue.then(fn).catch((e) => console.error('[claude-sessions] viewer', e));
    return this.queue;
  }

  async onMessage(m) {
    switch (m?.type) {
      case 'ready':
        return this.run(async () => {
          const init = await this.tail.open();
          await this.nameAgents(true);
          this.lastHeader = '';
          this.post({ ...init, header: this.header() });
        });
      case 'earlier':
        return this.run(async () => this.post(await this.tail.earlier()));
      case 'openFile':
        return vscode.window.showTextDocument(vscode.Uri.file(this.target.file), { preview: true });
      case 'openAgent': {
        const file = viewer.agentFile(this.target.file, m.agentId); // a plain id, a file that exists
        return file && host.openAgent(this.target, m.agentId, file);
      }
    }
  }

  update() {
    if (this.disposed || this.pending) return;
    this.pending = true;
    return this.run(async () => {
      this.pending = false;
      if (this.disposed) return;
      const m = await this.tail.poll();
      const named = await this.nameAgents();
      if (m?.type === 'init') this.lastHeader = '';
      if (m) this.post(m.type === 'append' ? { ...m, changed: [...m.changed, ...named.filter((it) => !m.changed.includes(it))] } : m);
      else if (named.length) this.post({ type: 'append', items: [], changed: named, first: undefined, hasEarlier: this.tail.start > 0 });
      this.sendHeader();
    });
  }

  // A foreground agent's call only returns when it's done; its meta file names it as soon as it starts.
  async nameAgents(now) {
    const open = this.tail.t.items.filter((it) => it.k === 'tool' && it.agent && !it.agentId);
    if (!open.length || (!now && Date.now() - this.agentLookup < AGENT_LOOKUP_MS)) return [];
    this.agentLookup = Date.now();
    const ids = await viewer.agentIds(this.target.file);
    return open.filter((it) => ids.has(it.id) && (it.agentId = ids.get(it.id)));
  }

  header() {
    return { ...this.tail.header(), ...host.describe(this.target) };
  }

  sendHeader() {
    const h = this.header();
    const json = JSON.stringify(h);
    if (json === this.lastHeader) return;
    this.lastHeader = json;
    if (h.title && this.panel.title !== h.title) this.panel.title = h.title;
    this.post({ type: 'header', header: h });
  }

  dispose() {
    this.disposed = true;
    this.unwatch();
    views.delete(this.target.file);
  }
}

module.exports = { init, open, poll, disposeAll };
