import { marked, Renderer } from 'marked';
import sanitize from 'sanitize-html';
import hljs from 'highlight.js';
const cache = new Map();
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' })[c],
  );
export const highlight = (text, language) => {
  try {
    return hljs.getLanguage(language)
      ? hljs.highlight(text, { language, ignoreIllegals: true }).value
      : esc(text);
  } catch {
    return esc(text);
  }
};
export function markdown(text, breaks = true) {
  const key = `${breaks}\n${text}`;
  if (cache.has(key)) return cache.get(key);
  const renderer = new Renderer();
  renderer.code = ({ text, lang }) =>
    `<pre><code${lang ? ` class="language-${esc(lang.split(/\s/)[0])}"` : ''}>${highlight(text, lang?.split(/\s/)[0] || '')}\n</code></pre>\n`;
  const held = [];
  const hold = (tex, display) => {
    const id =
      held.push(
        `<span class="math" data-tex="${esc(tex)}"${display ? ' data-display="1"' : ''}>${esc(tex)}</span>`,
      ) - 1;
    return `SULFURMATHPLACEHOLDER${id}END`;
  };
  // Code spans/fences are excluded before scanning math delimiters.
  const code = [];
  let input = text.replace(
    /```[\s\S]*?(?:```|$)|`[^`\n]+`/g,
    (s) => `SULFURCODEPLACEHOLDER${code.push(s) - 1}END`,
  );
  input = input.replace(
    /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(\S(?:\\\$|[^$\n])*?\S|\S)\$(?!\d)/g,
    (_, a, b, c, d) => hold(a || b || c || d, !!(a || b)),
  );
  input = input.replace(/SULFURCODEPLACEHOLDER(\d+)END/g, (_, i) => code[+i]);
  const raw = marked.parse(input, { gfm: true, breaks, renderer });
  let html = sanitize(raw, {
    allowedTags: [...sanitize.defaults.allowedTags, 'img', 'input', 'span', 'del'],
    allowedAttributes: {
      ...sanitize.defaults.allowedAttributes,
      '*': ['class'],
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      span: ['class', 'data-tex', 'data-display'],
      input: ['type', 'disabled', 'checked'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    transformTags: {
      input: (_, attrs) => ({
        tagName: 'input',
        attribs: { type: 'checkbox', disabled: '', ...('checked' in attrs ? { checked: '' } : {}) },
      }),
      a: (_, attrs) => ({
        tagName: 'a',
        attribs: { ...attrs, target: '_blank', rel: 'noopener noreferrer' },
      }),
    },
  });
  html = html.replace(/<li>(\s*(?:<p>)?\s*<input)/g, '<li class="task">$1');
  html = html.replace(/SULFURMATHPLACEHOLDER(\d+)END/g, (_, i) => held[+i]);
  if (cache.size >= 4000) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}
export function markdownResponse(p) {
  if (Array.isArray(p.items))
    return { html: p.items.map((x) => markdown(x.text || '', x.breaks !== false)) };
  if (typeof p.highlight === 'string') return { html: highlight(p.text || '', p.highlight) };
  if (p.blocks) {
    let from = 0,
      prefix = '';
    const blocks = [];
    for (const t of marked.lexer(p.text || '')) {
      if (t.type === 'space') {
        if (blocks.length) blocks.at(-1).raw += t.raw;
        else prefix += t.raw;
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
