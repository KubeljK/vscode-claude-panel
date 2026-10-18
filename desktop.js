// Which session started which, from the Claude desktop app's own per-session metadata. Only what the app wrote down
// explicitly counts: a session another one spawned (spawnedFrom) or a fork made in the app (forkedFromSessionId).
// Read-only, best-effort (an undocumented internal format), and macOS only: elsewhere there's nothing to read.
//
// The app keeps one claude-code-sessions/<id>/<id>/local_<id>.json per session, with its own id (sessionId, the
// "local_…" one) and Claude Code's (cliSessionId, the transcript's).

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The app's metadata folder, or '' where there's none to look for. */
function metaDir(platform = process.platform, home = os.homedir()) {
  return platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions') : '';
}

const str = (v) => (typeof v === 'string' && v ? v : '');

/** One metadata file's links: { local, cli, from, fork }, or undefined when it doesn't have the two ids. */
function parse(d) {
  if (!d || typeof d !== 'object') return undefined;
  const local = str(d.sessionId);
  const cli = str(d.cliSessionId);
  if (!local || !cli) return undefined;
  const spawned = d.spawnedFrom && typeof d.spawnedFrom === 'object' ? d.spawnedFrom : undefined;
  const from = str(spawned?.sessionId) || str(d.forkedFromSessionId);
  const fork = !!from && (spawned?.userFork === true || (!str(spawned?.sessionId) && !!str(d.forkedFromSessionId)));
  return { local, cli, from, fork };
}

/** childCliId → { parentCliId, kind: 'spawned' | 'fork' }, for parsed records whose parent is among them too. */
function links(records) {
  const cliOf = new Map(records.map((r) => [r.local, r.cli]));
  const out = new Map();
  for (const r of records) {
    const parent = r.from && cliOf.get(r.from);
    if (parent && parent !== r.cli) out.set(r.cli, { parentCliId: parent, kind: r.fork ? 'fork' : 'spawned' });
  }
  return out;
}

async function readdir(dir) {
  return fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
}

/**
 * Reads the metadata folder as it changes: each refresh lists it (two levels of folders) and parses only files
 * that are new or whose mtime changed. `dir` '' (not macOS) or missing: always an empty map.
 */
function reader(dir = metaDir()) {
  const cache = new Map(); // file → { mtime, rec }
  let result = new Map();
  return async function refresh() {
    if (!dir) return result;
    const files = [];
    for (const a of await readdir(dir)) {
      if (!a.isDirectory()) continue;
      for (const b of await readdir(path.join(dir, a.name))) {
        if (!b.isDirectory()) continue;
        const sub = path.join(dir, a.name, b.name);
        for (const f of await readdir(sub)) {
          if (f.isFile() && /^local_.*\.json$/.test(f.name)) files.push(path.join(sub, f.name));
        }
      }
    }
    let changed = files.length !== cache.size;
    const seen = new Set(files);
    for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);
    for (const f of files) {
      const st = await fs.promises.stat(f).catch(() => undefined);
      if (!st) continue;
      if (cache.get(f)?.mtime === st.mtimeMs) continue;
      let rec;
      let mtime = st.mtimeMs;
      try {
        rec = parse(JSON.parse(await fs.promises.readFile(f, 'utf8')));
      } catch {
        mtime = -1; // caught mid-write, or not JSON: read again next time
      }
      cache.set(f, { mtime, rec });
      changed = true;
    }
    if (changed) result = links([...cache.values()].map((c) => c.rec).filter(Boolean));
    return result;
  };
}

module.exports = { metaDir, parse, links, reader };
