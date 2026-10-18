// Sessions nested under the session that started them (from the Claude desktop app's metadata). Loaded by the panel
// webview, and by the tests through require: plain functions, no DOM.
(function (root) {
  // Sections, most prominent first: open in this window, running elsewhere, pinned, by day.
  const OPEN = 0;

  /**
   * Which sessions are shown under their parent: Map childId → parentId. `items` are the sessions the panel shows in
   * a section, as { id, parent, rank } with rank the section's place (0 open … 3 by day); hidden ones (the collapsed
   * Hidden section) or filtered-out ones aren't in it. A child nests when its parent is there and that doesn't move
   * it to a less prominent section than its own: an active child stays under "Running elsewhere" rather than going
   * down to a finished parent in "Today". Sessions open in this window are never nested (their order is ⌘1…⌘9).
   * Children of children nest too; a loop in the links is cut where it would close.
   */
  function nest(items) {
    const byId = new Map(items.map((s) => [s.id, s]));
    const memo = new Map(); // id → the parent it's nested under ('' for none)
    const busy = new Set(); // ids being resolved: a loop in the links
    function under(id) {
      if (memo.has(id)) return memo.get(id);
      if (busy.has(id)) return ''; // round a loop: taken as top-level while it's decided
      const s = byId.get(id);
      let p = '';
      if (s) {
        busy.add(id);
        const parent = s.parent && s.parent !== id && byId.get(s.parent);
        if (parent && s.rank !== OPEN && s.rank >= placed(parent.id) && !above(parent.id, id)) p = parent.id;
        busy.delete(id);
      }
      memo.set(id, p);
      return p;
    }
    // The section a session ends up in: its own, or the one its topmost ancestor is in.
    function placed(id) {
      const p = under(id);
      return p ? placed(p) : byId.get(id)?.rank ?? Infinity;
    }
    // Is `id` among `of`'s nested ancestors? Then `id` can't go under `of`: that would close a loop.
    function above(of, id) {
      for (let x = of, n = 0; x && n <= byId.size; x = memo.get(x) || '', n++) if (x === id) return true;
      return false;
    }
    const out = new Map();
    for (const s of items) {
      const p = under(s.id);
      if (p) out.set(s.id, p);
    }
    return out;
  }

  /** parentId → its nested children's ids, in `items`' order. */
  function children(nested, items) {
    const out = new Map();
    for (const s of items) {
      const p = nested.get(s.id);
      if (p) (out.get(p) || out.set(p, []).get(p)).push(s.id);
    }
    return out;
  }

  /** `id` and everything nested under it, depth first. */
  function family(id, kids) {
    const out = [];
    const walk = (x) => {
      if (out.includes(x)) return;
      out.push(x);
      for (const k of kids.get(x) || []) walk(k);
    };
    walk(id);
    return out;
  }

  /**
   * A parent's nested list: which children it shows, and how many wait behind "Show N older". `isRecent(id)` says
   * whether a child (or one nested under it) is active or recent. Older ones fold away only while at least one child
   * stays visible; when all are older the list shows them all, and starts collapsed (`open` false) instead.
   */
  function fold(ids, isRecent, all = false) {
    const recent = ids.filter(isRecent);
    if (!recent.length) return { shown: ids, older: 0, open: false };
    return { shown: all ? ids : recent, older: ids.length - recent.length, open: true };
  }

  const api = { nest, children, family, fold };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Nesting = api;
})(this);
