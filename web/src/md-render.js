// Markdown drawn in the page itself, for Sulfur's desktop app and its headless
// service (a Phosphorus server still renders its own /api/md): marked for the
// text, highlight.js for code, and the browser's own inert parser keeping only
// the tags and links the server's sanitizer allowed. Loaded on first use.
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';

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
  + 'caption col colgroup table tbody td tfoot th thead tr img input del').split(' '));
// removed with what's inside them, not just unwrapped
const DROP = new Set(['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'template', 'title']);
const ATTRS = { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height'], span: ['class', 'data-tex', 'data-display'], input: ['type', 'disabled', 'checked'] };
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

const cache = new Map();
export function markdown(text, breaks = true) {
  const key = `${breaks}\n${text}`;
  if (cache.has(key)) return cache.get(key);
  const renderer = new Renderer();
  renderer.code = ({ text: code, lang }) => `<pre><code${lang ? ` class="language-${esc(lang.split(/\s/)[0])}"` : ''}>${highlight(code, lang?.split(/\s/)[0] || '')}\n</code></pre>\n`;
  const held = [];
  const hold = (tex, display) => `SULFURMATHPLACEHOLDER${held.push(`<span class="math" data-tex="${esc(tex)}"${display ? ' data-display="1"' : ''}>${esc(tex)}</span>`) - 1}END`;
  // code spans and fences are set aside before math delimiters are looked for
  const code = [];
  let input = text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g, (s) => `SULFURCODEPLACEHOLDER${code.push(s) - 1}END`);
  input = input.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(\S(?:\\\$|[^$\n])*?\S|\S)\$(?!\d)/g, (_, a, b, c, d) => hold(a || b || c || d, !!(a || b)));
  input = input.replace(/SULFURCODEPLACEHOLDER(\d+)END/g, (_, i) => code[+i]);
  let html = sanitize(marked.parse(input, { gfm: true, breaks, renderer }));
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
    for (const t of marked.lexer(p.text || '')) {
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
