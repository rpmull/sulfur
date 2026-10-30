import test from 'node:test';
import assert from 'node:assert/strict';
import { parser as js } from '../.vendor/node_modules/@lezer/javascript/dist/index.js';
import { parser as python } from '../.vendor/node_modules/@lezer/python/dist/index.js';
import { parser as rust } from '../.vendor/node_modules/@lezer/rust/dist/index.js';
import { parser as css } from '../.vendor/node_modules/@lezer/css/dist/index.js';
import { parser as json } from '../.vendor/node_modules/@lezer/json/dist/index.js';
import { bracketRanges, scanBrackets, bracketStateIndex, skipSpansFromTree, skipSpansFromRanges, mergeRanges } from '../src/sulfur/bracket-colors.js';
import { stickyLines } from '../src/sulfur/sticky-scroll.js';
import { minimapLayout, minimapRuns, minimapScrollFor } from '../src/sulfur/minimap.js';
import { autoSaver } from '../src/sulfur/auto-save.js';
import { lineNumberLabels } from '../src/sulfur/line-numbers.js';
import { colorLiterals } from '../src/sulfur/color-decorators.js';

const starts = (text) => [0, ...Array.from(text.matchAll(/\n/g), (m) => m.index + 1)];
const levels = (text, ranges) => ranges.map((r) => `${text[r.from]}${r.cls.replace('bracket-', '')}`).join(' ');

test('brackets are colored by nesting, cycling through three levels, a stray closer marked', () => {
  const text = 'f(a[b{c(d)}])) {';
  assert.equal(levels(text, bracketRanges(text, 0, text.length)), '(1 [2 {3 (1 )1 }3 ]2 )1 )unexpected {1');
  // a window begins inside: the openers open there carried in
  assert.equal(levels(text, bracketRanges(text, 5, 11, '([')), '{3 (1 )1 }3');
  assert.equal(scanBrackets(text, 0, 8), '([{(');
  // a closer of another kind than the top opener closes down to its own opener
  assert.equal(levels('{(]}', bracketRanges('{(]}', 0, 4)), '{1 (2 ]unexpected }1');
  assert.equal(levels('[(]', bracketRanges('[(]', 0, 3)), '[1 (2 ]1');
});

test('brackets in strings and comments are looked past, from a tree or from colors', () => {
  const text = 'f("(", /* ) */ [1]) // {';
  const tree = js.parse(text);
  const skip = skipSpansFromTree(tree, 0, text.length);
  assert.deepEqual(skip, [[2, 5], [7, 14], [20, 24]]);
  assert.equal(levels(text, bracketRanges(text, 0, text.length, '', skip)), '(1 [2 ]2 )1');
  const colors = [{ from: 2, to: 5, cls: 'hljs-string' }, { from: 7, to: 14, cls: 'hljs-comment' }, { from: 20, to: 24, cls: 'hljs-comment' }];
  assert.deepEqual(skipSpansFromRanges(colors, 0, text.length), skip);
  assert.deepEqual(skipSpansFromRanges(colors, 10, 22), [[7, 14], [20, 24]]);
  // a window beginning inside a comment skips the rest of it
  assert.equal(levels(text, bracketRanges(text, 10, text.length, '(', skip)), '[2 ]2 )1');
});

test('the openers open at an offset come from marks kept across edits, scanned only past the last', () => {
  const line = 'if (a) { b[c(d)]; }\n';
  let text = line.repeat(1000) + '{ (';
  const scans = [];
  const index = bracketStateIndex(4096);
  const skipFor = (from, to) => { scans.push([from, to]); return []; };
  assert.equal(index.stateAt(text, text.length, skipFor), '{(');
  assert.equal(index.stateAt(text, text.length - 1, skipFor), '{');
  // a second ask near the end scans from the last mark, not the top
  assert.ok(scans.at(-1)[0] >= 16384, String(scans.at(-1)));
  // an edit near the end keeps the marks before it
  const edited = text.slice(0, text.length - 3) + '[ ( {';
  scans.length = 0;
  assert.equal(index.stateAt(edited, edited.length, skipFor), '[({');
  assert.ok(scans[0][0] >= 16384);
  // an edit at the top throws every mark away
  scans.length = 0;
  const top = '(' + edited;
  assert.equal(index.stateAt(top, top.length, skipFor), '([({');
  assert.equal(scans[0][0], 0);
});

test('bracket ranges merge into a token layer, the brackets winning', () => {
  const base = [{ from: 0, to: 3, cls: 'a' }, { from: 5, to: 9, cls: 'b' }];
  const over = [{ from: 3, to: 4, cls: 'x' }, { from: 6, to: 7, cls: 'y' }];
  assert.deepEqual(mergeRanges(base, over), [{ from: 0, to: 3, cls: 'a' }, { from: 3, to: 4, cls: 'x' }, { from: 5, to: 6, cls: 'b' }, { from: 6, to: 7, cls: 'y' }, { from: 7, to: 9, cls: 'b' }]);
  assert.equal(mergeRanges(base, []), base);
  assert.equal(mergeRanges([], over), over);
});

test('sticky scroll holds the lines opening the scopes the view is in, across grammars', () => {
  const jsText = 'class A {\n  m() {\n    if (x) {\n      a;\n      b;\n    }\n  }\n}\nfunction f() {\n  return 1;\n}\n';
  const ls = starts(jsText);
  const tree = js.parse(jsText);
  assert.deepEqual(stickyLines(tree, jsText, ls, 3), [0, 1, 2]);
  // the class line hides the method's, which sticks too, and so on down: VS Code's cascade
  assert.deepEqual(stickyLines(tree, jsText, ls, 1), [0, 1, 2]);
  assert.deepEqual(stickyLines(tree, jsText, ls, 4), [0, 1]);
  assert.deepEqual(stickyLines(tree, jsText, ls, 6), [0]);
  assert.deepEqual(stickyLines(tree, jsText, ls, 0), []);
  // past the class: nothing, then f's own line
  assert.deepEqual(stickyLines(tree, jsText, ls, 8), []);
  assert.deepEqual(stickyLines(tree, jsText, ls, 9), [8]);
  // at most max lines, the outermost kept
  assert.deepEqual(stickyLines(tree, jsText, ls, 3, 2), [0, 1]);
  const py = 'class A:\n    def m(self):\n        for x in y:\n            pass\n            pass\n\nz = 1\n';
  assert.deepEqual(stickyLines(python.parse(py), py, starts(py), 3), [0, 1]);
  assert.deepEqual(stickyLines(python.parse(py), py, starts(py), 2), [0, 1, 2]);
  assert.deepEqual(stickyLines(python.parse(py), py, starts(py), 6), []);
  const rs = 'impl A {\n    fn m(&self) {\n        match x {\n            1 => {\n                a();\n            }\n            _ => {}\n        }\n    }\n}\n';
  assert.deepEqual(stickyLines(rust.parse(rs), rs, starts(rs), 4), [0, 1, 2]);
  const sheet = '@media (min-width: 1px) {\n  .a {\n    color: red;\n    top: 0;\n  }\n}\n';
  assert.deepEqual(stickyLines(css.parse(sheet), sheet, starts(sheet), 2), [0, 1]);
  const doc = '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}\n';
  assert.deepEqual(stickyLines(json.parse(doc), doc, starts(doc), 3), [1, 2]);
});

test('the minimap slides through a long file and maps a click back to a scroll position', () => {
  const still = minimapLayout({ lines: 100, lineHeight: 20, scrollTop: 400, viewHeight: 600, height: 600, rowHeight: 2 });
  assert.deepEqual(still, { first: 0, count: 100, sliding: false, sliderTop: 40, sliderHeight: 60 });
  const top = minimapLayout({ lines: 10000, lineHeight: 20, scrollTop: 0, viewHeight: 600, height: 600, rowHeight: 2 });
  assert.equal(top.first, 0); assert.equal(top.count, 300); assert.equal(top.sliding, true);
  const end = minimapLayout({ lines: 10000, lineHeight: 20, scrollTop: (10000 - 30) * 20, viewHeight: 600, height: 600, rowHeight: 2 });
  assert.equal(end.first, 9700); assert.equal(end.count, 300); assert.equal(end.sliderTop, (9970 - 9700) * 2);
  const mid = minimapLayout({ lines: 10000, lineHeight: 20, scrollTop: 50000, viewHeight: 600, height: 600, rowHeight: 2 });
  assert.ok(mid.first > 2000 && mid.first < 3000);
  assert.ok(mid.sliderTop >= 0 && mid.sliderTop + mid.sliderHeight <= 600);
  assert.equal(minimapScrollFor(still, 100, { lineHeight: 20, viewHeight: 600, rowHeight: 2 }), 700);
  assert.equal(minimapScrollFor(end, 0, { lineHeight: 20, viewHeight: 600, rowHeight: 2 }), 9700 * 20 - 300);
});

test('minimap rows are runs of one color, blanks skipped and tabs to their stops', () => {
  const text = 'ab cd\n\tx  yz\n';
  const colors = [{ from: 0, to: 2, cls: 'hljs-keyword' }, { from: 7, to: 8, cls: 'hljs-string' }];
  assert.deepEqual(minimapRuns(text, starts(text), 0, 2, colors), [[[0, 2, 'hljs-keyword'], [3, 2, '']], [[4, 1, 'hljs-string'], [7, 2, '']]]);
  assert.deepEqual(minimapRuns(text, starts(text), 1, 2, colors, 5), [[[4, 1, 'hljs-string']]]);
  assert.deepEqual(minimapRuns(text, starts(text), 2, 3, colors), [[]]);
});

test('auto save after a delay, on focus change and on window change', () => {
  const timers = [];
  const saved = [];
  const saver = autoSaver({ save: (t, mode) => saved.push([t, mode]), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { timers[id - 1].fn = null; } });
  saver.changed('a', true, 'afterDelay', 500);
  assert.equal(timers[0].ms, 500);
  saver.changed('a', true, 'afterDelay', 500);
  assert.equal(timers[0].fn, null);
  assert.ok(saver.pending('a'));
  timers[1].fn();
  assert.deepEqual(saved, [['a', 'afterDelay']]);
  assert.ok(!saver.pending('a'));
  saver.changed('b', true, 'afterDelay', 0);
  assert.equal(timers[2].ms, 1000);
  saver.changed('b', false, 'afterDelay', 500);
  assert.equal(timers[2].fn, null);
  saver.changed('c', true, 'off', 500);
  assert.equal(timers.length, 3);
  assert.deepEqual(saver.focusLost(['x', 'y'], 'onFocusChange'), ['x', 'y']);
  assert.deepEqual(saver.focusLost(['x'], 'onWindowChange', 'editor'), []);
  assert.deepEqual(saver.focusLost(['x'], 'onWindowChange', 'window'), ['x']);
  assert.deepEqual(saver.focusLost(['x'], 'afterDelay', 'window'), []);
});

test('line numbers can be relative to the caret, every tenth, or off', () => {
  assert.equal(lineNumberLabels(0, 3), '1\n2\n3');
  assert.equal(lineNumberLabels(3, 8, 5, 'relative'), '2\n1\n6\n1\n2');
  assert.equal(lineNumberLabels(7, 12, 8, 'interval'), '\n9\n10\n\n');
  assert.equal(lineNumberLabels(0, 3, 0, 'off'), '');
});

test('color literals are found in a window of text, outside comments', () => {
  const text = 'a { color: #fff; /* #000 */ background: rgb(1, 2, 3) }\nb { x: #12345678; y: #1234567 }';
  const inComment = (i) => !(i >= 17 && i < 27);
  assert.deepEqual(colorLiterals(text, 0, text.length, inComment).map((c) => c.color), ['#fff', 'rgb(1, 2, 3)', '#12345678']);
  // from the line the window begins in, so a literal cut by the window's start still shows
  assert.deepEqual(colorLiterals(text, 12, 13).map((c) => c.color), ['#fff']);
  assert.deepEqual(colorLiterals(text, 56, text.length).map((c) => c.from), [62]);
});

test('a format\'s edits are each run of whitespace, going on past a token the formatter changed', async () => {
  const { formattingEdits } = await import('../src/sulfur/formatting.js');
  const { opApply, opEdits } = await import('../src/text-operations.js');
  const before = 'a=1;\n  b = 0X1F;\nc=  3;\n';
  const after = 'a = 1;\nb = 0x1f;\nc = 3;\n';
  const edits = formattingEdits(before, after);
  assert.equal(opApply(before, opEdits(before, edits)), after);
  assert.ok(edits.length >= 5, String(edits.length));
  assert.ok(edits.every((e) => e.to - e.from < 8));
  // past the limit: one edit between the common ends
  const one = formattingEdits(before, after, 2);
  assert.equal(one.length, 1);
  assert.equal(opApply(before, opEdits(before, one)), after);
  // a tail dropped and a head added still end at both texts' ends
  for (const [x, y] of [['ab cd', 'ab'], ['ab', 'x ab'], ['', 'a b'], ['a b', '']]) assert.equal(opApply(x, opEdits(x, formattingEdits(x, y))), y);
});

test('a many-edit change parses again only around its edits, through the edits\' own places', async () => {
  const { createSyntaxCache, opChanges } = await import('../src/syntax-cache.js');
  const { TreeFragment } = await import('../.vendor/node_modules/@lezer/common/dist/index.js');
  const { opApply, opEdits } = await import('../src/text-operations.js');
  const before = 'function f(a){return a+1}\n'.repeat(2000);
  const cache = createSyntaxCache(TreeFragment);
  cache.parse(js, before);
  const edits = [];
  for (let at = before.indexOf('{'); at >= 0; at = before.indexOf('{', at + 1)) edits.push({ from: at, to: at, text: ' ' });
  const ops = opEdits(before, edits);
  const after = opApply(before, ops);
  assert.deepEqual(opChanges(ops).slice(0, 2), [{ fromA: 13, toA: 13, fromB: 13, toB: 14 }, { fromA: 39, toA: 39, fromB: 40, toB: 41 }]);
  assert.deepEqual(opChanges([3, -2, 'xy', 4]), [{ fromA: 3, toA: 5, fromB: 3, toB: 5 }]);
  cache.noteEdits(before, after, ops);
  const t0 = performance.now();
  const tree = cache.parse(js, after);
  const noted = performance.now() - t0;
  assert.equal(tree.toString(), js.parse(after).toString());
  // the same change parsed again as one span from the first edit to the last takes far longer
  const other = createSyntaxCache(TreeFragment);
  other.parse(js, before);
  const t1 = performance.now();
  other.parse(js, after);
  const whole = performance.now() - t1;
  assert.ok(noted < whole, `${noted.toFixed(1)}ms noted, ${whole.toFixed(1)}ms whole`);
});
