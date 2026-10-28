// Sulfur notes: markdown files linked by [[name]] and ![[embeds]], kept in a folder's
// .sulfur/.notes (images pasted into one go to .sulfur/.notes/images) or anywhere in the
// folder. Here: links and #tags found in a note, a link found as a file, the graph of
// which file links which, a pasted image's name, and notes-rng, the native notes plugin
// that rolls dice and picks from lists in inline `rng: …` code and ```rng fences.

export const NOTES_DIR = '.sulfur/.notes';
export const NOTES_IMAGES = `${NOTES_DIR}/images`;
export const isNote = (p) => /\.(?:md|markdown)$/i.test(p);
export const isImage = (p) => /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p);
const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const dir = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
export const noteTitle = (p) => base(p).replace(/\.(?:md|markdown)$/i, '');

// a path's . and .. walked, '' when it climbs out of the top
export function joinPath(from, rel) {
  const out = from ? from.split('/') : [];
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!out.length) return ''; out.pop(); } else out.push(part);
  }
  return out.join('/');
}

// the text with code fences, code spans, math and %%comments%% blanked to spaces, so what's
// in them isn't taken for links or tags; same length, so offsets still hold
export function prose(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return String(text || '')
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/, blank)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`|\$\$[\s\S]*?\$\$|%%[\s\S]*?(?:%%|$)/g, blank);
}

// what a note points at: [[target]], ![[target]] and [text](relative/path) links
export function noteLinks(text) {
  const t = prose(text);
  const out = [];
  for (const m of t.matchAll(/(!?)\[\[([^[\]\n|#^]*)(?:[#^][^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]/g)) {
    if (m[2].trim()) out.push({ target: m[2].trim(), embed: !!m[1], at: m.index });
  }
  for (const m of t.matchAll(/(!?)\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const u = m[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('#') || u.startsWith('/')) continue;
    let target = u.split('#')[0];
    try { target = decodeURI(target); } catch {}
    if (target) out.push({ target, embed: !!m[1], path: true, at: m.index });
  }
  return out;
}

// a note's #tags, in its text and its properties' tags
export function noteTags(text) {
  const tags = new Set();
  const src = String(text || '');
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (fm) {
    const m = /^tags?:[ \t]*(.*)$/m.exec(fm[1]);
    if (m) {
      const inline = m[1].replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^["'#]+|["']+$/g, '')).filter(Boolean);
      inline.forEach((x) => tags.add(x));
      for (const item of fm[1].slice(m.index + m[0].length).matchAll(/^\s+-\s+(.+)$/gm)) tags.add(item[1].trim().replace(/^["'#]+|["']+$/g, ''));
    }
  }
  for (const m of prose(src).matchAll(/(^|[ \t])#([A-Za-z_À-￿][\wÀ-￿/-]*)/gm)) tags.add(m[2]);
  return [...tags];
}

// the folder's files for finding links in: every path, and the paths by their names
export function linkIndex(paths) {
  const all = new Map();
  const byName = new Map();
  for (const p of paths) {
    const k = p.toLowerCase();
    all.set(k, p);
    const n = base(k);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(p);
  }
  return { all, byName };
}

// a link's file: from the note's own folder, then from the top of the folder open, then
// any file of that name, the nearest the note first, then the shortest path. A name
// without an extension is a note's (.md); null when nothing has it
export function resolveLink(target, from, index, root = '') {
  let t = String(target || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!t || t.endsWith('/')) return null;
  const tries = isNote(t) || /\.[A-Za-z0-9]{1,5}$/.test(t) ? [t, `${t}.md`] : [`${t}.md`, t];
  const here = dir(from || '');
  for (const c of tries) {
    for (const at of [joinPath(here, c), joinPath(root, c)]) {
      const hit = at && index.all.get(at.toLowerCase());
      if (hit) return hit;
    }
  }
  for (const c of tries) {
    const want = c.toLowerCase().replace(/^(\.\.\/)+/, '');
    const named = (index.byName.get(base(want)) || []).filter((p) => { const k = p.toLowerCase(); return k === want || k.endsWith(`/${want}`); });
    if (!named.length) continue;
    const near = (p) => (p.startsWith(`${here}/`) ? 0 : 1);
    return [...named].sort((a, b) => near(a) - near(b) || a.split('/').length - b.split('/').length || a.length - b.length || a.localeCompare(b))[0];
  }
  return null;
}

// the graph of what links what: a node per note (and per linked file, tag and missing note
// when asked for), a link per pair, both ways counted once
export function noteGraph(notes, index, { root = '', tags = false, files = false, missing = true } = {}) {
  const nodes = new Map();
  const links = new Map();
  const node = (id, label, kind) => { if (!nodes.has(id)) nodes.set(id, { id, label, kind, degree: 0 }); return nodes.get(id); };
  const link = (a, b) => {
    if (a === b) return;
    const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
    if (links.has(key)) return;
    links.set(key, { source: a, target: b });
    nodes.get(a).degree += 1;
    nodes.get(b).degree += 1;
  };
  for (const n of notes) node(n.path, noteTitle(n.path), 'note');
  for (const n of notes) {
    for (const l of noteLinks(n.text)) {
      const hit = resolveLink(l.target, n.path, index, root);
      if (hit) {
        if (nodes.has(hit)) link(n.path, hit);
        else if (files || isNote(hit)) { node(hit, isNote(hit) ? noteTitle(hit) : base(hit), isNote(hit) ? 'note' : 'file'); link(n.path, hit); }
      } else if (missing && !l.path && !isImage(l.target)) {
        const id = `missing:${l.target.toLowerCase()}`;
        node(id, l.target, 'missing');
        link(n.path, id);
      }
    }
    if (tags) for (const t of noteTags(n.text)) { node(`tag:${t.toLowerCase()}`, `#${t}`, 'tag'); link(n.path, `tag:${t.toLowerCase()}`); }
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}

// a pasted image's file name: its own when it came with one (a file copied), else
// image-<date>-<time>; a number after it when that's taken. Characters a [[link]] can't
// hold changed to -
export function pastedImageName(type, name = '', now = new Date(), taken = () => false) {
  const kinds = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif' };
  const own = name && !/^image\.\w+$/i.test(name) ? name.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim() : '';
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = (own && /\.([A-Za-z0-9]+)$/.exec(own)?.[1]) || kinds[type] || 'png';
  const stem = own ? own.replace(/\.[A-Za-z0-9]+$/, '') : `image-${stamp}`;
  let out = `${stem}.${ext}`;
  for (let i = 1; taken(out); i++) out = `${stem}-${i}.${ext}`;
  return out;
}

// --- notes-rng ------------------------------------------------------------------------
// `rng: 2d6+1`, `rng: 4d6kh3`, `rng: d%`, `rng: 1-100`, `rng: coin`, `rng: pick a | b | c`,
// `rng: pick 2 a, b, c`, `rng: shuffle a, b, c`; a ```rng fence is a table, a line an entry,
// `3: entry` weighting it three times

const cryptoRandom = (n) => {
  // an integer in [0, n), even across the range
  const max = 2 ** 32 - (2 ** 32 % n);
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= max);
  return buf[0] % n;
};
const items = (s) => (s.includes('|') ? s.split('|') : s.split(',')).map((x) => x.trim()).filter(Boolean);

// what an inline rng expression rolls: the result, and how it came about
export function rngRoll(src, random = cryptoRandom) {
  const s = String(src || '').trim();
  if (!s) throw new Error('nothing to roll');
  if (/^(?:coin|flip)$/i.test(s)) return { text: random(2) ? 'Heads' : 'Tails', detail: 'coin' };
  const range = /^(-?\d+)\s*(?:\.\.|to|-)\s*(-?\d+)$/i.exec(s);
  if (range) {
    const [a, b] = [+range[1], +range[2]].sort((x, y) => x - y);
    if (b - a > 1e9) throw new Error('range too large');
    return { text: String(a + random(b - a + 1)), detail: `${a} to ${b}` };
  }
  const pick = /^(?:pick|choose)(?:\s+(\d+))?\s+([\s\S]+)$/i.exec(s) || (/^\[([\s\S]+)\]$/.exec(s) && [null, null, s.slice(1, -1)]);
  if (pick) {
    const list = items(pick[2]);
    const n = Math.min(list.length, Math.max(1, +(pick[1] || 1)));
    if (!list.length) throw new Error('nothing to pick from');
    const left = [...list];
    const got = Array.from({ length: n }, () => left.splice(random(left.length), 1)[0]);
    return { text: got.join(', '), detail: `${n} of ${list.length}` };
  }
  const shuffle = /^shuffle\s+([\s\S]+)$/i.exec(s);
  if (shuffle) {
    const list = items(shuffle[1]);
    for (let i = list.length - 1; i > 0; i--) { const j = random(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    return { text: list.join(', '), detail: 'shuffled' };
  }
  return diceRoll(s, random);
}

// NdM, dM, d%, NdMkhK / klK (keep the highest or lowest K), plain numbers, + and -
export function diceRoll(src, random = cryptoRandom) {
  const s = src.replace(/\s+/g, '');
  const term = /([+-])?(?:(\d*)d(\d+|%)(?:(kh|kl|k)(\d+))?|(\d+))/giy;
  let total = 0, at = 0, dice = 0;
  const parts = [];
  while (at < s.length) {
    term.lastIndex = at;
    const m = term.exec(s);
    if (!m || !m[0] || (at > 0 && !m[1])) throw new Error(`not a roll: ${src}`);
    at = term.lastIndex;
    const sign = m[1] === '-' ? -1 : 1;
    if (m[6] !== undefined) { total += sign * +m[6]; parts.push(`${m[1] || ''}${m[6]}`); continue; }
    const n = m[2] ? +m[2] : 1, sides = m[3] === '%' ? 100 : +m[3];
    if (!n || !sides || n > 1000 || sides > 1e6 || (dice += n) > 1000) throw new Error('too many dice');
    const rolls = Array.from({ length: n }, () => 1 + random(sides));
    let kept = rolls;
    if (m[4]) {
      const k = Math.min(n, +m[5]);
      const order = [...rolls].sort((a, b) => (m[4] === 'kl' ? a - b : b - a));
      kept = order.slice(0, k);
    }
    total += sign * kept.reduce((a, b) => a + b, 0);
    parts.push(`${m[1] || ''}[${rolls.join(', ')}]${m[4] ? `${m[4]}${m[5]}` : ''}`);
  }
  if (!dice && !parts.length) throw new Error(`not a roll: ${src}`);
  return { text: String(total), detail: `${src.trim()}: ${parts.join(' ').replace(/^\+/, '')} = ${total}` };
}

// a fence's table: one entry by weight
export function rngTable(src, random = cryptoRandom) {
  const rows = [];
  for (const line of String(src || '').split(/\r?\n/)) {
    const l = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (!l || l.startsWith('#')) continue;
    const w = /^(\d+)\s*:\s*(.+)$/.exec(l);
    rows.push(w ? { weight: +w[1], text: w[2] } : { weight: 1, text: l });
  }
  const sum = rows.reduce((a, r) => a + r.weight, 0);
  if (!sum) throw new Error('an empty table');
  let pick = random(sum);
  const row = rows.find((r) => (pick -= r.weight) < 0);
  return { text: row.text, detail: `1 of ${rows.length} entries` };
}

// the plugin as the markdown view draws it: a result that rolls again when clicked
export const rngPlugin = {
  inline: true,
  fence: true,
  render(source, { kind }) {
    const roll = () => (kind === 'fence' ? rngTable(source) : rngRoll(source));
    const out = document.createElement(kind === 'fence' ? 'div' : 'span');
    out.className = `notes-rng notes-rng-${kind}`;
    const value = Object.assign(document.createElement('button'), { type: 'button', className: 'notes-rng-value' });
    const paint = () => {
      const r = roll();
      value.textContent = r.text;
      value.title = `${r.detail}\nClick to roll again`;
    };
    value.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); paint(); });
    if (kind === 'fence') out.append(Object.assign(document.createElement('span'), { className: 'notes-rng-label', textContent: '🎲' }));
    out.append(value);
    paint();
    return out;
  },
};
