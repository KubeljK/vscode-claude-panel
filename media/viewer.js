// Read-only transcript view. Renders the items the extension posts; the only messages back are 'ready', 'earlier',
// 'openFile' and 'openAgent' with an agent id, which the extension checks and turns into a path itself.
//
// Transcript text is untrusted: the DOM is built with createElement and textContent only, nothing from a transcript
// becomes a link, a command or an attribute that does anything, and no style attributes (the CSP blocks them).
(function () {
  const vscode = acquireVsCodeApi();
  const ui = Object.assign({ follow: true }, vscode.getState() || {});
  const nodes = new Map(); // seq → element
  let header = {};
  let hasEarlier = false;
  let loading = false;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const tokens = (n) =>
    n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`;

  function clock(ts) {
    const d = new Date(ts);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function duration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  // ---------------------------------------------------------------- markdown

  // A small, safe subset: ``` fences, `code`, **bold** (code inside bold too), "- " and "1. " lists, # headings as
  // bold lines, paragraphs. Anything else (links, HTML) stays literal text.
  function inline(parent, s, bold = true) {
    const re = bold ? /`([^`\n]+)`|\*\*(.+?)\*\*/g : /`([^`\n]+)`/g;
    let i = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > i) parent.append(s.slice(i, m.index));
      if (m[1] !== undefined) parent.append(el('code', null, m[1]));
      else inline(parent.appendChild(el('strong')), m[2], false);
      i = m.index + m[0].length;
    }
    if (i < s.length) parent.append(s.slice(i));
  }

  function markdown(text) {
    const root = el('div', 'md');
    const lines = String(text).split('\n');
    let para = null;
    let list = null;
    let ordered = false;
    for (let i = 0; i < lines.length; ) {
      const line = lines[i++];
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        para = list = null;
        const body = [];
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
        i++; // the closing fence
        root.appendChild(el('pre', 'code')).appendChild(el('code', null, body.join('\n')));
        continue;
      }
      if (!line.trim()) {
        para = list = null;
        continue;
      }
      const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (h) {
        para = list = null;
        inline(root.appendChild(el('div', 'h')), h[1]);
        continue;
      }
      const li = /^\s*([-*+]|\d{1,4}[.)])\s+(.*)$/.exec(line);
      if (li) {
        const num = /\d/.test(li[1]);
        if (!list || ordered !== num) {
          para = null;
          ordered = num;
          list = root.appendChild(el(num ? 'ol' : 'ul'));
          if (num) list.start = parseInt(li[1], 10);
        }
        inline(list.appendChild(el('li')), li[2]);
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list.lastElementChild.append(' ');
        inline(list.lastElementChild, line.trim());
        continue;
      }
      list = null;
      if (para) para.appendChild(el('br'));
      else para = root.appendChild(el('p'));
      inline(para, line);
    }
    return root;
  }

  // ---------------------------------------------------------------- items

  function details(cls, summary, body, open) {
    const d = el('details', cls);
    d.open = !!open;
    const s = d.appendChild(el('summary'));
    s.append(...summary);
    if (body) d.appendChild(body);
    return d;
  }

  function agentButton(agentId) {
    const b = el('button', 'link open-agent', 'Open subagent view');
    b.dataset.agent = agentId; // an id only: the extension finds the file
    b.title = 'Open this subagent’s transcript in a read-only view';
    return b;
  }

  function pre(label, text, cls) {
    const f = document.createDocumentFragment();
    f.appendChild(el('div', 'label', label));
    f.appendChild(el('pre', `body${cls ? ` ${cls}` : ''}`, text || ' '));
    return f;
  }

  const chip = (n) => el('span', 'chip', `${plural(n, 'image')} attached`);

  const render = {
    user(it) {
      const d = el('div', 'msg user');
      d.appendChild(el('div', 'who', `You${it.ts ? ` · ${clock(it.ts)}` : ''}`));
      if (it.text.trim()) d.appendChild(markdown(it.text));
      if (it.images) d.appendChild(chip(it.images));
      return d;
    },
    assistant(it) {
      const d = el('div', `msg assistant${it.error ? ' error' : ''}`);
      d.appendChild(el('div', 'who', `Claude${it.ts ? ` · ${clock(it.ts)}` : ''}`));
      d.appendChild(markdown(it.text));
      return d;
    },
    thinking(it) {
      // Claude Code writes most thinking blocks empty: there's only the fact that it thought.
      if (!it.text.trim()) return el('div', 'thinking empty', 'Thinking…');
      return details('thinking', ['Thinking…'], el('pre', 'body', it.text));
    },
    tool(it) {
      const r = it.result;
      const state = !r ? 'running' : r.error ? 'error' : 'ok';
      const body = el('div', 'tool-body');
      body.appendChild(pre('Input', it.input));
      if (r) body.appendChild(pre(r.error ? 'Error' : 'Result', r.text, r.error ? 'error' : ''));
      if (r?.images) body.appendChild(chip(r.images));
      const summary = [el('span', `dot ${state}`), el('span', 'tname', it.name), el('span', 'tsum', it.summary)];
      if (it.agent && it.agentId) summary.push(agentButton(it.agentId));
      const d = details(`tool ${state}${it.agent ? ' agent' : ''}`, summary, body, state === 'error');
      d.title = !r ? 'No result yet' : r.error ? 'Failed' : '';
      return d;
    },
    agentDone(it) {
      const ok = it.status === 'completed';
      const summary = [el('span', `dot ${ok ? 'ok' : 'error'}`), el('span', 'tsum', it.summary || `Subagent ${it.status || 'finished'}`)];
      if (it.agentId) summary.push(agentButton(it.agentId));
      return details('agent-done', summary, it.result ? el('pre', 'body', it.result) : null, false);
    },
    command: (it) => el('div', 'command', it.text),
    divider: (it) =>
      el('div', 'divider', `Context compacted${it.trigger === 'manual' ? '' : ' automatically'}${it.pre ? ` · ${tokens(it.pre)} → ${tokens(it.post)} tokens` : ''}`),
    notice: (it) => el('div', `notice ${it.level === 'error' ? 'error' : ''}`, it.text),
    turnEnd: (it) => el('div', 'turn-end', `Turn took ${duration(it.ms)}`),
  };

  function node(it) {
    const f = render[it.k];
    if (!f) return null;
    const n = f(it);
    n.dataset.seq = it.seq;
    nodes.set(it.seq, n);
    return n;
  }

  // ---------------------------------------------------------------- shell

  const head = document.body.appendChild(el('header', 'head'));
  const row1 = head.appendChild(el('div', 'row'));
  const pill = row1.appendChild(el('span', 'pill'));
  const title = row1.appendChild(el('span', 'title'));
  row1.appendChild(el('span', 'badge', 'Read-only')).title = 'A view of the transcript file. Nothing here changes the session.';
  const openFile = row1.appendChild(el('button', 'icon-text', 'Raw file'));
  openFile.title = 'Open the transcript file (JSONL)';
  openFile.addEventListener('click', () => vscode.postMessage({ type: 'openFile' }));
  const row2 = head.appendChild(el('div', 'row meta'));
  const facts = row2.appendChild(el('span', 'facts'));
  const ctx = row2.appendChild(el('span', 'ctx'));
  const ctxBar = ctx.appendChild(el('span', 'ctx-bar'));
  const ctxFill = ctxBar.appendChild(el('span', 'ctx-fill u-0'));
  const ctxText = ctx.appendChild(el('span', 'ctx-text'));
  const follow = row2.appendChild(el('label', 'switch'));
  follow.title = 'Keep the newest entries in view. Scrolling up turns it off; scrolling to the bottom turns it on.';
  const followBox = follow.appendChild(el('input'));
  followBox.type = 'checkbox';
  followBox.setAttribute('role', 'switch');
  follow.appendChild(el('span', 'track')).appendChild(el('span', 'thumb'));
  follow.appendChild(el('span', 'switch-label', 'Follow'));
  const notice = head.appendChild(el('div', 'head-notice'));

  const main = document.body.appendChild(el('main', 'timeline'));
  const earlier = main.appendChild(el('button', 'btn earlier', 'Load earlier entries'));
  const list = main.appendChild(el('div', 'items'));
  const working = main.appendChild(el('div', 'working'));
  const empty = main.appendChild(el('div', 'empty', 'Nothing to show yet.'));

  earlier.addEventListener('click', () => {
    if (loading) return;
    loading = true;
    earlier.disabled = true;
    earlier.textContent = 'Loading…';
    vscode.postMessage({ type: 'earlier' });
  });

  list.addEventListener('click', (e) => {
    const b = e.target.closest('.open-agent');
    if (!b) return;
    e.preventDefault(); // inside a <summary>: don't toggle the card
    vscode.postMessage({ type: 'openAgent', agentId: b.dataset.agent });
  });

  const STATUS = {
    busy: ['busy', 'Working'],
    run: ['busy', 'Running'],
    waiting: ['waiting', 'Needs you'],
    starting: ['', 'Starting…'],
    idle: ['idle', 'Idle'],
    done: ['idle', 'Done'],
    failed: ['failed', 'Failed'],
    stopped: ['idle', 'Stopped'],
  };
  const live = () => ['busy', 'run', 'waiting', 'starting'].includes(header.status);

  function renderHeader() {
    const [cls, label] = STATUS[header.status] || ['idle', 'Not running'];
    pill.className = `pill ${cls}`;
    pill.replaceChildren();
    if (cls === 'busy') pill.appendChild(el('span', 'pulse'));
    pill.append(label);
    pill.title = header.status === 'waiting' && header.waitingFor ? `Waiting for you: ${header.waitingFor}` : '';
    title.textContent = header.title || 'Transcript';
    title.title = header.title || '';
    facts.textContent = [header.kind === 'agent' ? header.agentType || 'Subagent' : '', header.model, header.branch ? `⎇ ${header.branch}` : '']
      .filter(Boolean)
      .join(' · ');
    if (header.ctx) {
      const [used, size] = header.ctx;
      const pct = Math.min(100, (used / size) * 100);
      ctx.hidden = false;
      ctx.className = `ctx${pct >= 95 ? ' full' : pct >= 80 ? ' warn' : ''}`;
      ctxFill.className = `ctx-fill u-${Math.ceil(pct / 5) * 5}`;
      ctxText.textContent = `${tokens(used)} / ${tokens(size)}`;
      ctx.title = `Context: ${used.toLocaleString()} tokens used of ${size.toLocaleString()} (${Math.round(pct)}%)`;
    } else ctx.hidden = true;
    notice.hidden = !header.bad;
    notice.textContent = header.bad ? `${plural(header.bad, 'line')} of this transcript couldn’t be read and ${header.bad === 1 ? 'is' : 'are'} left out.` : '';
    document.body.classList.toggle('live', live());

    // Claude Code writes a block once it's done, so the one in progress is only known from the live status.
    working.replaceChildren();
    working.className = `working${header.status === 'waiting' ? ' waiting' : ''}`;
    working.hidden = !live();
    if (live()) {
      if (header.status !== 'waiting') working.appendChild(el('span', 'pulse'));
      working.append(header.status === 'waiting' ? `Waiting for you${header.waitingFor ? `: ${header.waitingFor}` : ''}` : header.activity || 'Working…');
    }
  }

  function renderEarlier() {
    earlier.hidden = !hasEarlier;
    earlier.disabled = loading;
    earlier.textContent = loading ? 'Loading…' : 'Load earlier entries';
  }

  // ---------------------------------------------------------------- following

  const doc = document.documentElement;
  const atBottom = () => window.innerHeight + window.scrollY >= doc.scrollHeight - 24;

  function setFollow(on) {
    if (ui.follow === on) return;
    ui.follow = on;
    followBox.checked = on;
    vscode.setState(ui);
  }

  function toBottom() {
    if (ui.follow) window.scrollTo(0, doc.scrollHeight);
  }

  followBox.checked = ui.follow;
  followBox.addEventListener('change', () => {
    setFollow(followBox.checked);
    toBottom();
  });
  // Scrolling up stops following; back at the bottom it picks up again.
  window.addEventListener('scroll', () => setFollow(atBottom()), { passive: true });

  // ---------------------------------------------------------------- messages

  function append(items) {
    const f = document.createDocumentFragment();
    for (const it of items) {
      const n = node(it);
      if (n) f.appendChild(n);
    }
    list.appendChild(f);
  }

  // A tool call that got its result: re-rendered in place, open if it was.
  function patch(items) {
    for (const it of items) {
      const old = nodes.get(it.seq);
      if (!old) continue;
      const n = node(it);
      if (!n) continue;
      if (old.open) n.open = true;
      old.replaceWith(n);
    }
  }

  // Beyond the cap the oldest go; "Load earlier" brings them back.
  function dropBefore(first) {
    if (first === undefined) return;
    for (const [seq, n] of nodes) {
      if (seq >= first) continue;
      n.remove();
      nodes.delete(seq);
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    switch (m.type) {
      case 'init':
        nodes.clear();
        list.replaceChildren();
        append(m.items || []);
        hasEarlier = !!m.hasEarlier;
        loading = false;
        if (m.header) header = m.header;
        renderHeader();
        renderEarlier();
        window.scrollTo(0, ui.follow ? doc.scrollHeight : 0);
        break;
      case 'append':
        patch(m.changed || []);
        append(m.items || []);
        dropBefore(m.first);
        hasEarlier = !!m.hasEarlier;
        renderEarlier();
        toBottom();
        break;
      case 'prepend': {
        const before = doc.scrollHeight;
        const f = document.createDocumentFragment();
        for (const it of m.items || []) {
          const n = node(it);
          if (n) f.appendChild(n);
        }
        list.prepend(f);
        window.scrollBy(0, doc.scrollHeight - before); // keep what you were reading where it was
        hasEarlier = !!m.hasEarlier;
        loading = false;
        renderEarlier();
        break;
      }
      case 'header':
        header = m.header || {};
        renderHeader();
        toBottom();
        break;
    }
    empty.hidden = nodes.size > 0;
  });

  renderHeader();
  renderEarlier();
  empty.hidden = true;
  vscode.postMessage({ type: 'ready' });
})();
