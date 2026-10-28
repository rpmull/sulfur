// markdown as the server renders it (marked, highlight.js, sanitize-html), the page
// adding only katex for math, fetched on first use

// Sulfur's own service leaves markdown to the page (md-render.js, loaded on first
// use, once bootLocal has set the flag from the service's info); a Phosphorus
// server renders it itself
let pageRender = null;
export async function mdRequest(body, signal) {
  if (globalThis.__sulfurMarkdownInPage) {
    pageRender ||= import('./md-render.js');
    return (await pageRender).markdownResponse(body);
  }
  const r = await fetch('/api/md', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`markdown: ${r.status}`);
  return r.json();
}

// the server's html for a text, by breaks and text
const cache = new Map();
const CACHE_MAX = 4000;
// asked of the server together, a tick after the first
let queue = [];
let queued = 0;

const keyOf = (src, breaks) => `${breaks ? 'b' : 'p'}\n${src}`;

function remember(key, html) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, html);
}

// el's text as markdown: html given (a chat line's own) used at once, a known
// text from the cache, anything else plain until the server's render lands
export function renderMd(el, src, breaks = true, html = null) {
  const key = keyOf(src, breaks);
  if (typeof html === 'string') remember(key, html);
  el.classList.add('md');
  el.dataset.md = key;
  const known = cache.get(key);
  if (known !== undefined) { paint(el, known); return; }
  el.textContent = src;
  queue.push({ el, src, breaks, key });
  queued ||= setTimeout(flush, 0);
}

// several texts in one round trip
async function flush() {
  const batch = queue;
  queue = [];
  queued = 0;
  const items = [];
  const seen = new Map();
  for (const q of batch) if (!seen.has(q.key)) { seen.set(q.key, items.length); items.push({ text: q.src, breaks: q.breaks }); }
  let out = [];
  try {
    out = (await mdRequest({ items })).html || [];
  } catch {}
  for (const q of batch) {
    const html = out[seen.get(q.key)];
    if (typeof html !== 'string') continue;
    remember(q.key, html);
    if (q.el.isConnected && q.el.dataset.md === q.key) paint(q.el, html);
  }
}

// a document's top-level blocks, each with where its source sits and its html
export async function mdBlocks(text) {
  try {
    return (await mdRequest({ text, blocks: true })).blocks || [];
  } catch {}
  return text ? [{ from: 0, raw: text, html: null }] : [];
}

function paint(el, html) {
  el.innerHTML = html;
  for (const a of el.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  for (const box of el.querySelectorAll('input')) box.setAttribute('disabled', '');
  if (el.querySelector('.math')) drawMath(el);
  el.dispatchEvent(new CustomEvent('md-painted', { bubbles: true }));
}

// --- math -------------------------------------------------------------------

let katexLoad = null;
const loadKatex = () => (katexLoad ||= (async () => {
  const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: __ASSETS__['katex.css'] });
  document.head.appendChild(css);
  const k = (await import('katex')).default;
  globalThis.katex = k;
  await import('katex/contrib/mhchem');
  return k;
})().catch((e) => { katexLoad = null; throw e; }));

async function drawMath(el) {
  let k;
  try { k = await loadKatex(); } catch { return; }
  for (const s of el.querySelectorAll('span.math[data-tex]')) {
    try {
      s.innerHTML = k.renderToString(s.dataset.tex, { displayMode: s.dataset.display === '1', throwOnError: false, output: 'html' });
      s.classList.add('math-done');
    } catch {}
  }
  fitMath(el);
}

// math wider than its line shrunk to fit, to half size at most, display math
// scrolling past that, inline math breaking only between its bases
const MATH_EM = 1.05;
export function fitMath(el) {
  const line = el.closest('.bubble') || el.closest('li') || el;
  if (!line.clientWidth) return;
  for (const k of el.querySelectorAll('.katex')) {
    k.style.fontSize = '';
    const disp = k.closest('.katex-display');
    const bases = [...k.querySelectorAll('.katex-html > *')].map((b) => b.getBoundingClientRect().width);
    const wide = disp ? bases.reduce((a, w) => a + w, 0) : Math.max(0, ...bases);
    const room = (disp || line).clientWidth - 2;
    if (wide > room) k.style.fontSize = `${MATH_EM * Math.max(0.5, room / wide)}em`;
  }
}
