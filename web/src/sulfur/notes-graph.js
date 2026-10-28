// The notes' graph: a node per note (and per linked file, tag or missing note when shown),
// a line per link, laid out by a small force simulation on a canvas. Drag the background
// to pan, the wheel to zoom, a node to move it; a click opens it, hovering shows what it
// links. o: { scopes: [{id, label}], scope, load(scope, show) → {nodes, links}, open(node) }

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const MAX_NODES = 2500;

export function mountNoteGraph(root, o) {
  root.classList.add('notes-graph');
  const bar = el('div', 'notes-graph-bar');
  const scope = el('select', 'ide-select');
  scope.setAttribute('aria-label', 'Graph of');
  for (const s of o.scopes) scope.append(Object.assign(el('option', '', s.label), { value: s.id }));
  scope.value = o.scope || o.scopes[0].id;
  const find = Object.assign(el('input', 'ide-input notes-graph-find'), { placeholder: 'Find a note', spellcheck: false });
  find.setAttribute('aria-label', 'Find a note in the graph');
  const show = { tags: false, files: false, missing: true, orphans: true, ...(o.show || {}) };
  const toggles = [['tags', 'Tags'], ['files', 'Attachments'], ['missing', 'Missing notes'], ['orphans', 'Orphans']].map(([k, label]) => {
    const l = el('label', 'notes-graph-toggle');
    const box = Object.assign(el('input'), { type: 'checkbox', checked: show[k] });
    box.addEventListener('change', () => { show[k] = box.checked; o.onShow?.(show); reload(); });
    l.append(box, document.createTextNode(label));
    return l;
  });
  const again = Object.assign(el('button', 'ide-button secondary', 'Refresh'), { type: 'button' });
  const count = el('span', 'notes-graph-count');
  bar.append(scope, find, ...toggles, again, count);
  const canvas = el('canvas', 'notes-graph-canvas');
  canvas.tabIndex = 0;
  const note = el('div', 'notes-graph-note');
  root.append(bar, canvas, note);
  const ctx = canvas.getContext('2d');

  let nodes = [], links = [], byId = new Map();
  let view = { x: 0, y: 0, k: 1 };
  let alpha = 0, frame = 0, hover = null, drag = null, closed = false, seq = 0;
  let w = 0, h = 0;

  const colors = () => {
    const cs = getComputedStyle(root);
    const v = (n, f) => cs.getPropertyValue(n).trim() || f;
    return { fg: v('--ide-fg', '#ccc'), muted: v('--ide-muted', '#888'), accent: v('--ide-accent', '#4af'), border: v('--ide-border', '#444'), bg: v('--ide-bg', '#1e1e1e'), tag: v('--ide-ok', '#6c6'), warn: v('--ide-warn', '#ca0') };
  };
  let C = colors();

  async function reload() {
    const mine = (seq += 1);
    note.textContent = 'Reading the notes…';
    note.hidden = false;
    let g;
    try { g = await o.load(scope.value, show); } catch (err) { if (mine === seq) note.textContent = `The graph couldn't be read: ${err.message}`; return; }
    if (closed || mine !== seq) return;
    const keep = new Map(nodes.map((n) => [n.id, n]));
    let list = g.nodes;
    if (!show.orphans) list = list.filter((n) => n.degree > 0);
    const truncated = list.length > MAX_NODES;
    if (truncated) list = [...list].sort((a, b) => b.degree - a.degree).slice(0, MAX_NODES);
    nodes = list.map((n, i) => {
      const was = keep.get(n.id);
      const a = i * 2.39996, r = 12 * Math.sqrt(i + 1);
      return { ...n, x: was?.x ?? Math.cos(a) * r, y: was?.y ?? Math.sin(a) * r, vx: 0, vy: 0 };
    });
    byId = new Map(nodes.map((n) => [n.id, n]));
    links = g.links.map((l) => ({ a: byId.get(l.source), b: byId.get(l.target) })).filter((l) => l.a && l.b);
    for (const n of nodes) n.near = new Set();
    for (const l of links) { l.a.near.add(l.b); l.b.near.add(l.a); }
    const notes = nodes.filter((n) => n.kind === 'note').length;
    count.textContent = `${notes} note${notes === 1 ? '' : 's'} · ${links.length} link${links.length === 1 ? '' : 's'}${truncated ? ` · the ${MAX_NODES} most linked shown` : ''}`;
    note.hidden = !!nodes.length;
    note.textContent = nodes.length ? '' : 'No notes here yet. Markdown files and their [[links]] show up as they are written.';
    heat(1);
  }

  const heat = (a = 0.6) => { alpha = Math.max(alpha, a); if (!frame) frame = requestAnimationFrame(step); };

  function step() {
    frame = 0;
    if (closed) return;
    if (alpha > 0.004) {
      tick();
      alpha *= drag?.node ? 1 : 0.985;
    }
    draw();
    if (alpha > 0.004 || drag) frame = requestAnimationFrame(step);
  }

  function tick() {
    const n = nodes.length;
    // apart: every pair pushes off, nearer harder; in a big graph a sample of the others
    const stride = n > 900 ? Math.ceil(n / 900) : 1;
    for (let i = 0; i < n; i++) {
      const p = nodes[i];
      for (let j = (i % stride) + i + 1; j < n; j += stride) {
        const q = nodes[j];
        let dx = p.x - q.x, dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        if (d2 > 250000) continue;
        const f = (1400 * stride * alpha) / d2;
        const d = Math.sqrt(d2);
        p.vx += (dx / d) * f; p.vy += (dy / d) * f;
        q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
      }
    }
    // together: each link a spring to its length
    for (const l of links) {
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 70) / d) * 0.06 * alpha;
      l.a.vx += dx * f; l.a.vy += dy * f;
      l.b.vx -= dx * f; l.b.vy -= dy * f;
    }
    for (const p of nodes) {
      // and toward the middle, lightly
      p.vx -= p.x * 0.012 * alpha;
      p.vy -= p.y * 0.012 * alpha;
      if (drag?.node === p) { p.vx = p.vy = 0; continue; }
      p.vx *= 0.6; p.vy *= 0.6;
      p.x += Math.max(-40, Math.min(40, p.vx));
      p.y += Math.max(-40, Math.min(40, p.vy));
    }
  }

  const radius = (n) => (n.kind === 'tag' ? 3.5 : 3 + Math.sqrt(n.degree) * 1.7);
  const toScreen = (n) => [w / 2 + (n.x + view.x) * view.k, h / 2 + (n.y + view.y) * view.k];
  const toWorld = (sx, sy) => [(sx - w / 2) / view.k - view.x, (sy - h / 2) / view.k - view.y];

  function draw() {
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const q = find.value.trim().toLowerCase();
    const lit = hover ? new Set([hover, ...hover.near]) : null;
    const match = (n) => !q || n.label.toLowerCase().includes(q);
    ctx.lineWidth = 1;
    for (const l of links) {
      const on = lit && (l.a === hover || l.b === hover);
      ctx.strokeStyle = on ? C.accent : C.border;
      ctx.globalAlpha = lit && !on ? 0.25 : q && !(match(l.a) && match(l.b)) ? 0.25 : 0.8;
      const [ax, ay] = toScreen(l.a), [bx, by] = toScreen(l.b);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const n of nodes) {
      const [x, y] = toScreen(n);
      if (x < -50 || y < -50 || x > w + 50 || y > h + 50) continue;
      const r = radius(n) * Math.max(0.6, Math.min(1.6, view.k));
      const dim = (lit && !lit.has(n)) || (q && !match(n));
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = n === hover ? C.accent : n.kind === 'tag' ? C.tag : n.kind === 'file' ? C.muted : n.kind === 'missing' ? C.bg : C.fg;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (n.kind === 'missing') { ctx.strokeStyle = C.muted; ctx.stroke(); }
      if (view.k > 0.65 || (lit && lit.has(n)) || (q && match(n))) {
        ctx.fillStyle = n === hover ? C.fg : C.muted;
        ctx.fillText(n.label.length > 40 ? `${n.label.slice(0, 39)}…` : n.label, x, y + r + 3);
      }
    }
    ctx.globalAlpha = 1;
  }

  function nodeAt(sx, sy) {
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const [x, y] = toScreen(n);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      const r = radius(n) * Math.max(0.6, Math.min(1.6, view.k)) + 4;
      if (d < r * r && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }
  const at = (e) => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

  canvas.addEventListener('pointerdown', (e) => {
    const [sx, sy] = at(e);
    const node = nodeAt(sx, sy);
    drag = { node, sx, sy, vx: view.x, vy: view.y, moved: false };
    canvas.setPointerCapture(e.pointerId);
    if (node) heat(0.3);
  });
  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = at(e);
    if (!drag) {
      const n = nodeAt(sx, sy);
      if (n !== hover) { hover = n; canvas.style.cursor = n ? 'pointer' : 'grab'; canvas.title = n ? (n.kind === 'missing' ? `${n.label} (not written yet: click to write it)` : n.id.replace(/^(tag|missing):/, '')) : ''; draw(); }
      return;
    }
    if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 3) drag.moved = true;
    if (drag.node) { [drag.node.x, drag.node.y] = toWorld(sx, sy); heat(0.3); }
    else { view.x = drag.vx + (sx - drag.sx) / view.k; view.y = drag.vy + (sy - drag.sy) / view.k; draw(); }
  });
  const up = () => {
    const d = drag;
    drag = null;
    if (d?.node && !d.moved) o.open(d.node);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; draw(); } });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = at(e);
    const [wx, wy] = toWorld(sx, sy);
    view.k = Math.max(0.1, Math.min(6, view.k * Math.exp(-e.deltaY * 0.0015)));
    // the point under the mouse kept there
    view.x = (sx - w / 2) / view.k - wx;
    view.y = (sy - h / 2) / view.k - wy;
    draw();
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') { view.k = Math.min(6, view.k * 1.2); draw(); }
    else if (e.key === '-') { view.k = Math.max(0.1, view.k / 1.2); draw(); }
    else if (e.key === '0') { view = { x: 0, y: 0, k: 1 }; draw(); }
  });
  find.addEventListener('input', () => {
    // the first match brought to the middle
    const q = find.value.trim().toLowerCase();
    const hit = q && nodes.find((n) => n.label.toLowerCase().includes(q));
    if (hit) { view.x = -hit.x; view.y = -hit.y; }
    draw();
  });
  find.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = find.value.trim().toLowerCase();
    const hit = q && nodes.find((n) => n.label.toLowerCase().includes(q));
    if (hit) o.open(hit);
  });
  scope.addEventListener('change', () => { o.onScope?.(scope.value); view = { x: 0, y: 0, k: 1 }; reload(); });
  again.addEventListener('click', () => reload());

  const fit = () => {
    const b = canvas.getBoundingClientRect();
    if (!b.width || !b.height) return;
    const dpr = devicePixelRatio || 1;
    w = b.width; h = b.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    C = colors();
    draw();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(canvas);
  reload();

  return {
    refresh: () => reload(),
    repaint: () => { C = colors(); draw(); },
    dispose() { closed = true; ro.disconnect(); cancelAnimationFrame(frame); },
  };
}
