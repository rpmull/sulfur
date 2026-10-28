import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown, markdownResponse, cleanTree, setSanitizer } from '../src/md-render.js';

// just enough of a DOM for the allowlist walk
class El {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1;
    this.localName = tag;
    this.attrs = new Map(Object.entries(attrs));
    this.childNodes = [];
    for (const c of children) this.append(c);
  }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  append(c) { c.parent = this; this.childNodes.push(c); }
  remove() { const s = this.parent.childNodes; s.splice(s.indexOf(this), 1); }
  replaceWith(...nodes) { const s = this.parent.childNodes; const i = s.indexOf(this); for (const n of nodes) n.parent = this.parent; s.splice(i, 1, ...nodes); }
  removeAttribute(n) { this.attrs.delete(n); }
  setAttribute(n, v) { this.attrs.set(n, v); }
  hasAttribute(n) { return this.attrs.has(n); }
  toString() { return `<${this.localName}${[...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('')}>${this.childNodes.join('')}</${this.localName}>`; }
}
const text = (t) => ({ nodeType: 3, t, toString: () => t, remove() {}, replaceWith() {} });
const comment = () => ({ nodeType: 8, toString: () => '<!--x-->', remove() { const s = this.parent.childNodes; s.splice(s.indexOf(this), 1); } });

test('the page sanitizer keeps allowed tags and safe links only', () => {
  const c = comment();
  const root = new El('root', {}, [
    new El('p', { onclick: 'x()', class: 'k' }, [text('hi'), new El('script', {}, [text('alert(1)')])]),
    new El('a', { href: 'javascript:alert(1)', title: 't' }, [text('bad')]),
    new El('a', { href: 'https://x.y' }, [text('good')]),
    new El('img', { src: 'data:image/png;base64,AA', onerror: 'x()' }),
    new El('custom', {}, [text('kept text')]),
    new El('input', { type: 'text', checked: '', value: 'v' }),
  ]);
  root.append(c);
  const out = cleanTree(root).childNodes.join('');
  assert.equal(out.includes('script'), false);
  assert.equal(out.includes('onclick'), false);
  assert.equal(out.includes('javascript:'), false);
  assert.equal(out.includes('onerror'), false);
  assert.equal(out.includes('<!--'), false);
  assert.match(out, /<p class="k">hi<\/p>/);
  assert.match(out, /<a href="https:\/\/x.y" target="_blank" rel="noopener noreferrer">good<\/a>/);
  assert.match(out, /kept text/);
  assert.match(out, /<input type="checkbox" disabled="" checked="">/);
});

test('page markdown keeps math, code spans, task lists and source blocks', () => {
  setSanitizer((h) => h);
  try {
    const html = markdown('**hi** $x^2$ and `$y$`\n```go\nfunc main() {}\n```');
    for (const want of ['<strong>hi</strong>', 'data-tex="x^2"', '<code>$y$</code>', 'hljs-keyword']) assert.ok(html.includes(want), want);
    assert.ok(markdown('- [x] done').includes('class="task"'));
    assert.ok(!markdown('costs $5 and $6').includes('data-tex'));
    const src = '# T\n\npara one\nstill\n\n```js\nx\n```\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const { blocks } = markdownResponse({ text: src, blocks: true });
    assert.equal(blocks.length, 5);
    assert.equal(blocks.map((b) => b.raw).join(''), src);
    for (const b of blocks) assert.equal(src.slice(b.from, b.from + b.raw.length), b.raw);
    assert.equal(markdownResponse({ items: [{ text: 'a' }, { text: 'b' }] }).html.length, 2);
    assert.ok(markdownResponse({ highlight: 'python', text: 'def f(): pass' }).html.includes('hljs-keyword'));
  } finally {
    setSanitizer(null);
  }
});

test('notes syntax: links, embeds, callouts, highlights, tags, comments and properties', () => {
  setSanitizer((h) => h);
  try {
    const html = markdown('See [[Other Note|other]], [[Deep#Part]], ![[pic one.png|200]] ==lit== #tag/x %%gone%% `#code` `[[Code]]`', false);
    for (const want of ['<a class="wikilink" href="#" data-wiki="Other Note">other</a>', 'data-wiki="Deep#Part">Deep &gt; Part</a>', '<img class="wiki-embed" src="pic%20one.png" data-wiki="pic one.png" alt="pic one.png" width="200">', '<mark>lit</mark>', 'data-tag="tag/x">#tag/x</span>', '<code>#code</code>', '<code>[[Code]]</code>']) assert.ok(html.includes(want), want);
    assert.ok(!html.includes('gone'));
    const fold = markdown('> [!warning]- Careful **now**\n> body', false);
    assert.match(fold, /^<details class="callout callout-warning"><summary class="callout-title">.*Careful <strong>now<\/strong>.*<\/summary><div class="callout-content"><p>body<\/p>/s);
    assert.match(markdown('> [!tip]\n> x', false), /<div class="callout callout-tip"><div class="callout-title">.*Tip/s);
    assert.match(markdown('> just a quote', false), /^<blockquote>/);
    const src = '---\ntags: [a, b]\ntitle: Hi\n---\n# Note\n\nbody\n';
    assert.match(markdown(src), /^<div class="properties"><table><tbody><tr><th>tags<\/th><td><span class="tag" data-tag="a">#a<\/span>, <span class="tag" data-tag="b">#b<\/span><\/td><\/tr><tr><th>title<\/th><td>Hi<\/td><\/tr>/);
    const { blocks } = markdownResponse({ text: src, blocks: true });
    assert.equal(blocks.map((b) => b.raw).join(''), src);
    assert.equal(blocks[0].raw, '---\ntags: [a, b]\ntitle: Hi\n---\n');
    assert.ok(blocks[0].html.includes('class="properties"'));
  } finally {
    setSanitizer(null);
  }
});
