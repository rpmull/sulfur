// Markdown drawn in the page itself, for Sulfur's desktop app and its headless
// service (a Phosphorus server still renders its own /api/md): marked for the
// text, highlight.js for code, and the browser's own inert parser keeping only
// the tags and links the server's sanitizer allowed. Sulfur notes' syntax is
// read too: [[links]], ![[embeds]], > [!callouts], ==highlights==, #tags,
// %%comments%% and a note's --- properties ---. Loaded on first use.
import { marked, Renderer, Lexer } from 'marked';
// the common languages alone (highlight.js's own cut of ~40): a quarter of the whole, loaded
// the first time a note, a hover or a chat shows code
import hljs from 'highlight.js/lib/common';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' })[c]);

export function highlight(text, language) {
  try {
    return hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : esc(text);
  } catch {
    return esc(text);
  }
}

// sanitize-html's default tags and the few the server added
const TAGS = new Set(('address article aside footer header h1 h2 h3 h4 h5 h6 hgroup main nav section blockquote dd div dl dt figcaption figure hr li ol p pre ul '
  + 'a abbr b bdi bdo br cite code data dfn em i kbd mark q rb rp rt rtc ruby s samp small span strong sub sup time u var wbr '
  + 'caption col colgroup table tbody td tfoot th thead tr img input del details summary').split(' '));
// removed with what's inside them, not just unwrapped
const DROP = new Set(['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'template', 'title']);
const ATTRS = { a: ['href', 'title', 'target', 'rel', 'data-wiki'], img: ['src', 'alt', 'title', 'width', 'height', 'data-wiki'], span: ['class', 'data-tex', 'data-display', 'data-tag'], input: ['type', 'disabled', 'checked'], details: ['open'] };
const SCHEMES = /^(?:https?|mailto):/i;
const IMG_SCHEMES = /^(?:https?|data):/i;

function safeURL(value, img) {
  const v = value.replace(/[\u0000- ]+/g, '');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return true;
  return (img ? IMG_SCHEMES : SCHEMES).test(v);
}

// a parsed tree's elements kept, unwrapped or dropped by the allowlist
export function cleanTree(root) {
  for (const node of [...root.childNodes]) {
    if (node.nodeType === 3) continue;
    if (node.nodeType !== 1) { node.remove(); continue; }
    const tag = node.localName;
    if (DROP.has(tag)) { node.remove(); continue; }
    cleanTree(node);
    if (!TAGS.has(tag)) { node.replaceWith(...node.childNodes); continue; }
    const keep = ATTRS[tag] || [];
    for (const { name, value } of [...node.attributes]) {
      const ok = (keep.includes(name) || name === 'class') && ((name !== 'href' && name !== 'src') || safeURL(value, tag === 'img'));
      if (!ok) node.removeAttribute(name);
    }
    if (tag === 'a') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    if (tag === 'input') {
      const checked = node.hasAttribute('checked');
      for (const { name } of [...node.attributes]) node.removeAttribute(name);
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
      if (checked) node.setAttribute('checked', '');
    }
  }
  return root;
}

function domSanitize(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  cleanTree(t.content);
  return t.innerHTML;
}

let sanitize = domSanitize;
// tests without a DOM give their own
export function setSanitizer(fn) { sanitize = fn || domSanitize; }

// --- Sulfur notes' syntax --------------------------------------------------------

export const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const CALLOUT_ICONS = { note: '✎', abstract: '≡', summary: '≡', tldr: '≡', info: 'ℹ', todo: '☐', tip: '✦', hint: '✦', important: '✦', success: '✓', check: '✓', done: '✓',
  question: '?', help: '?', faq: '?', warning: '⚠', caution: '⚠', attention: '⚠', failure: '✗', fail: '✗', missing: '✗', danger: '⚡', error: '⚡', bug: '🐞', example: '▤', quote: '❝', cite: '❝' };
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// a note's properties (its YAML front matter) as a table: key: value, key: [a, b] and
// lists of - items; tags shown as tags
export function properties(yaml) {
  const rows = [];
  for (const line of yaml.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && rows.length) { rows.at(-1).values.push(item[1].trim()); continue; }
    const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].trim();
    const list = /^\[(.*)\]$/.exec(v);
    rows.push({ key: kv[1].trim(), values: list ? list[1].split(',').map((x) => x.trim()).filter(Boolean) : v ? [v] : [] });
  }
  const unquote = (s) => s.replace(/^(["'])(.*)\1$/, '$2');
  const cell = (r) => r.values.map((v) => (/^tags?$/i.test(r.key) ? `<span class="tag" data-tag="${esc(unquote(v).replace(/^#/, ''))}">#${esc(unquote(v).replace(/^#/, ''))}</span>` : esc(unquote(v)))).join(r.values.length > 1 ? ', ' : '');
  return `<div class="properties"><table><tbody>${rows.map((r) => `<tr><th>${esc(r.key)}</th><td>${cell(r)}</td></tr>`).join('')}</tbody></table></div>\n`;
}

// [[target#heading|alias]] as a link and ![[target|size]] as an image, or a note's link
// for the page to draw it into, both found again by data-wiki
function wikilink(embed, target, heading, alias) {
  const t = (target || '').trim();
  const h = (heading || '').trim();
  const a = (alias || '').trim();
  if (embed && IMAGE_EXT.test(t)) {
    const size = /^(\d+)(?:x(\d+))?$/.exec(a);
    return `<img class="wiki-embed" src="${esc(encodeURI(t))}" data-wiki="${esc(t)}" alt="${esc(size || !a ? t : a)}"${size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ''}` : ''}>`;
  }
  const label = a || (t ? `${t}${h ? ` > ${h.slice(1)}` : ''}` : h.slice(1));
  return `<a class="wikilink${embed ? ' wiki-embed' : ''}" href="#" data-wiki="${esc(t + h)}">${esc(label)}</a>`;
}

// > [!type]± title, then the quote as its body: a box of that kind, folded by - and open by +
function callout(renderer, tokens) {
  const first = tokens[0];
  const m = first?.type === 'paragraph' && /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/.exec(first.raw);
  if (!m) return `<blockquote>\n${renderer.parser.parse(tokens)}</blockquote>\n`;
  const kind = m[1].toLowerCase();
  const title = m[3].trim() ? renderer.parser.parseInline(Lexer.lexInline(m[3].trim())) : esc(kind[0].toUpperCase() + kind.slice(1));
  const body = first.raw.slice(m[0].length).replace(/^\r?\n/, '') + tokens.slice(1).map((t) => t.raw).join('');
  const inner = body.trim() ? renderer.parser.parse(marked.lexer(body)) : '';
  const head = `<span class="callout-icon">${CALLOUT_ICONS[kind] || '✎'}</span><span class="callout-title-text">${title}</span>`;
  const cls = `callout callout-${esc(kind)}`;
  if (m[2]) return `<details class="${cls}"${m[2] === '+' ? ' open' : ''}><summary class="callout-title">${head}</summary><div class="callout-content">${inner}</div></details>\n`;
  return `<div class="${cls}"><div class="callout-title">${head}</div>${inner ? `<div class="callout-content">${inner}</div>` : ''}</div>\n`;
}

const cache = new Map();
export function markdown(text, breaks = true) {
  const key = `${breaks}\n${text}`;
  if (cache.has(key)) return cache.get(key);
  const renderer = new Renderer();
  renderer.code = ({ text: code, lang }) => `<pre><code${lang ? ` class="language-${esc(lang.split(/\s/)[0])}"` : ''}>${highlight(code, lang?.split(/\s/)[0] || '')}\n</code></pre>\n`;
  renderer.blockquote = function ({ tokens }) { return callout(this, tokens); };
  const held = [];
  const keep = (html) => `SULFURMATHPLACEHOLDER${held.push(html) - 1}END`;
  const hold = (tex, display) => keep(`<span class="math" data-tex="${esc(tex)}"${display ? ' data-display="1"' : ''}>${esc(tex)}</span>`);
  // a note's properties first, drawn as a table rather than read as markdown
  let props = '';
  let body = text.replace(FRONTMATTER, (_, yaml) => { props = properties(yaml); return ''; });
  // code spans and fences are set aside before math delimiters and the notes' marks are looked for
  const code = [];
  let input = body.replace(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g, (s) => `SULFURCODEPLACEHOLDER${code.push(s) - 1}END`);
  input = input.replace(/%%[\s\S]*?(?:%%|$)/g, '');
  input = input.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(\S(?:\\\$|[^$\n])*?\S|\S)\$(?!\d)/g, (_, a, b, c, d) => hold(a || b || c || d, !!(a || b)));
  input = input.replace(/(!?)\[\[([^[\]\n|#^]*)((?:#|\^)[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]/g, (s, embed, target, heading, alias) => (target?.trim() || heading ? keep(wikilink(!!embed, target, heading, alias)) : s));
  input = input.replace(/==(?=\S)([^=\n]+?)==/g, '<mark>$1</mark>');
  input = input.replace(/(^|[ \t])#([A-Za-z_À-￿][\wÀ-￿/-]*)/gm, (_, pre, tag) => `${pre}${keep(`<span class="tag" data-tag="${esc(tag)}">#${esc(tag)}</span>`)}`);
  input = input.replace(/SULFURCODEPLACEHOLDER(\d+)END/g, (_, i) => code[+i]);
  let html = sanitize(props + marked.parse(input, { gfm: true, breaks, renderer }));
  html = html.replace(/<li>(\s*(?:<p>)?\s*<input)/g, '<li class="task">$1');
  html = html.replace(/SULFURMATHPLACEHOLDER(\d+)END/g, (_, i) => held[+i]);
  if (cache.size >= 4000) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}

// what /api/md answers, for the same request bodies
export function markdownResponse(p) {
  if (Array.isArray(p.items)) return { html: p.items.map((x) => markdown(x.text || '', x.breaks !== false)) };
  if (typeof p.highlight === 'string') return { html: highlight(p.text || '', p.highlight) };
  if (p.blocks) {
    let from = 0, prefix = '';
    const blocks = [];
    // a note's properties a block of their own, edited as one
    const text = p.text || '';
    const fm = FRONTMATTER.exec(text);
    if (fm) {
      const raw = fm[0] + (/^\s*/.exec(text.slice(fm[0].length))?.[0] || '');
      blocks.push({ from: 0, raw, html: markdown(fm[0], false) });
      from = raw.length;
    }
    for (const t of marked.lexer(text.slice(from))) {
      if (t.type === 'space') {
        if (blocks.length) blocks.at(-1).raw += t.raw; else prefix += t.raw;
        from += t.raw.length;
        continue;
      }
      const raw = prefix + t.raw;
      blocks.push({ from: from - prefix.length, raw, html: markdown(raw, false) });
      prefix = '';
      from += t.raw.length;
    }
    return { blocks };
  }
  return { html: markdown(p.text || '', p.breaks !== false) };
}
