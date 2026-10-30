// Several carets at once, as VS Code's: the textarea holds one selection (the primary, the
// last one made) and the editor keeps the others here, drawn under the text. Every edit
// typed into the primary is made again at each of the others, in the same undo step. Pure:
// offsets in and out, the editor's text never touched.
//
// A cursor is { anchor, head }: head its active end. The primary comes as [start, end].
import { commonEnds } from '../text-operations.js';
import { wordStart, wordEnd } from './completion.js';

export const CURSOR_MAX = 10000;

const lo = (c) => Math.min(c.anchor, c.head);
const hi = (c) => Math.max(c.anchor, c.head);
const same = (a, b) => a.anchor === b.anchor && a.head === b.head;

// cursors sorted by place, overlapping or equal ones merged into one
export function normalizeCursors(cursors) {
  const sorted = [...cursors].sort((a, b) => lo(a) - lo(b) || hi(a) - hi(b));
  const out = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && (same(last, c) || (hi(last) > lo(c)) || (hi(last) === lo(c) && lo(last) !== hi(last) && lo(c) !== hi(c)))) {
      const a = Math.min(lo(last), lo(c)), b = Math.max(hi(last), hi(c));
      out[out.length - 1] = last.head >= last.anchor ? { anchor: a, head: b } : { anchor: b, head: a };
    } else out.push(c);
  }
  return out;
}

// the next occurrence of what the primary holds, for Ctrl+D: a word under a bare caret
// first; then the next match after the last selection, wrapping round, that no cursor holds.
// whole: the search began from a word, so only whole words match (VS Code keeps that)
export function nextMatch(text, primary, cursors, whole = false) {
  const [s, e] = primary;
  if (s === e) {
    const ws = wordStart(text, s), we = wordEnd(text, s);
    return we > ws ? { select: [ws, we], whole: true } : null;
  }
  const needle = text.slice(s, e);
  if (!needle) return null;
  const all = normalizeCursors([...cursors, { anchor: s, head: e }]);
  const taken = (a, b) => all.some((c) => lo(c) < b && hi(c) > a);
  const wholeWord = (i) => !whole || (wordStart(text, i) === i && wordEnd(text, i + needle.length) === i + needle.length);
  const probe = (from, to) => {
    for (let i = text.indexOf(needle, from); i >= 0 && i < to; i = text.indexOf(needle, i + 1)) {
      if (!taken(i, i + needle.length) && wholeWord(i)) return { select: [i, i + needle.length], whole };
    }
    return null;
  };
  return probe(e, text.length) || probe(0, s);
}

// every occurrence of what the primary holds, for Ctrl+Shift+L; the primary's own kept last
export function allMatches(text, primary, whole = false) {
  const [s, e] = primary;
  let [a, b] = [s, e];
  let wholeWord = whole;
  if (s === e) { a = wordStart(text, s); b = wordEnd(text, s); wholeWord = true; }
  const needle = text.slice(a, b);
  if (!needle) return [];
  const out = [];
  for (let i = text.indexOf(needle); i >= 0 && out.length < CURSOR_MAX; i = text.indexOf(needle, i + 1)) {
    if (wholeWord && !(wordStart(text, i) === i && wordEnd(text, i + needle.length) === i + needle.length)) continue;
    if (i === a) continue;
    out.push({ anchor: i, head: i + needle.length });
  }
  out.push({ anchor: a, head: b });
  return out;
}

const lineStartOf = (text, p) => text.lastIndexOf('\n', p - 1) + 1;
const lineEndOf = (text, p) => { const e = text.indexOf('\n', p); return e < 0 ? text.length : e; };
// a line's offset at a column, tabs to their stops; the line's end when it's shorter
function offsetAtColumn(text, start, end, column, tabSize) {
  let col = 0;
  for (let i = start; i < end; i++) {
    if (col >= column) return i;
    col = text.charCodeAt(i) === 9 ? col + tabSize - col % tabSize : col + 1;
  }
  return end;
}
function columnOf(text, start, to, tabSize) {
  let col = 0;
  for (let i = start; i < to; i++) col = text.charCodeAt(i) === 9 ? col + tabSize - col % tabSize : col + 1;
  return col;
}

// a cursor a line above (d -1) or below (d 1) the primary's, at the same column: for
// Ctrl+Alt+Up and Down; null at the text's first or last line
export function cursorBeside(text, from, d, tabSize = 4) {
  const ls = lineStartOf(text, from);
  const col = columnOf(text, ls, from, tabSize);
  let start;
  if (d < 0) { if (ls === 0) return null; start = lineStartOf(text, ls - 1); }
  else { const le = lineEndOf(text, from); if (le >= text.length) return null; start = le + 1; }
  const at = offsetAtColumn(text, start, lineEndOf(text, start), col, tabSize);
  return { anchor: at, head: at };
}

// a cursor at the end of each line a selection spans (Shift+Alt+I)
export function cursorsAtLineEnds(text, from, to) {
  const out = [];
  for (let at = from; ;) {
    const le = lineEndOf(text, at);
    if (le > to && at > from) break;
    out.push({ anchor: le, head: le });
    if (le >= text.length || le >= to) break;
    at = le + 1;
  }
  return out;
}

// the others moved as a key moved the primary: left, right, wordLeft, wordRight, home, end,
// lineStart, lineEnd; extend keeps each anchor (Shift held)
export function moveCursors(text, cursors, kind, extend = false) {
  const moved = cursors.map((c) => {
    const { head } = c;
    let to = head;
    if (kind === 'left') to = !extend && c.anchor !== head ? lo(c) : Math.max(0, head - 1);
    else if (kind === 'right') to = !extend && c.anchor !== head ? hi(c) : Math.min(text.length, head + 1);
    else if (kind === 'wordLeft') { to = head; while (to > 0 && /\s/.test(text[to - 1])) to--; const w = wordStart(text, to); to = w < to ? w : Math.max(0, to - 1); }
    else if (kind === 'wordRight') { to = head; while (to < text.length && /\s/.test(text[to])) to++; const w = wordEnd(text, to); to = w > to ? w : Math.min(text.length, to + 1); }
    else if (kind === 'home') { const ls = lineStartOf(text, head); const ind = ls + (text.slice(ls, lineEndOf(text, ls)).match(/^[ \t]*/)[0].length); to = head === ind ? ls : ind; }
    else if (kind === 'end') to = lineEndOf(text, head);
    else if (kind === 'lineStart') to = lineStartOf(text, head);
    return { anchor: extend ? c.anchor : to, head: to };
  });
  return normalizeCursors(moved);
}
// the others a line up or down, at the column they set out from (goal columns kept by the
// caller as goals[i], when the primary's own goal column holds)
export function moveCursorsVertically(text, cursors, d, extend = false, tabSize = 4) {
  const moved = cursors.map((c) => {
    const next = cursorBeside(text, c.head, d, tabSize);
    const to = next ? next.head : d < 0 ? 0 : text.length;
    return { anchor: extend ? c.anchor : to, head: to };
  });
  return normalizeCursors(moved);
}

// An edit the browser made at the primary (before → after, the primary [ps, pe] before it,
// its caret at caret after it) made again at every other cursor: the edits to make on after,
// the cursors and the primary where they end up once those are made; null when the edit
// wasn't at the primary (a remote one, a line moved), so the others should be let go.
export function replicateEdit(before, after, primary, caret, cursors) {
  if (before === after || !cursors.length) return null;
  const [ps, pe] = primary;
  let { head, tail } = commonEnds(before, after);
  let endA = before.length - tail, endB = after.length - tail;
  let ins = after.slice(head, endB);
  // the diff's place is ambiguous where text repeats (typing b before a b): slid to where the
  // caret says the edit ended, so a backspace stays a backspace at the other cursors
  const slideLeft = () => (ins.length ? before[endA - 1] === ins[ins.length - 1] : before[head - 1] === before[endA - 1]);
  const slideRight = () => (ins.length ? before[head] === ins[0] : before[head] === before[endA]);
  while (head + ins.length > caret && head > 0 && slideLeft()) { if (ins.length) ins = before[head - 1] + ins.slice(0, -1); head--; endA--; endB--; }
  while (head + ins.length < caret && endA < before.length && slideRight()) { if (ins.length) ins = ins.slice(1) + before[endA]; head++; endA++; endB++; }
  // the edit must take in the whole primary selection: a common end the diff found inside
  // it (typing 'three' over 'one', the e shared) put back into the edit
  if (head > ps) { ins = before.slice(ps, head) + ins; head = ps; }
  if (endA < pe) { ins += before.slice(endA, pe); endB += pe - endA; endA = pe; }
  const cutBefore = ps - head, cutAfter = endA - pe;
  if (cutBefore < 0 || cutAfter < 0) return null;
  const delta = after.length - before.length;
  // the others' places on after: those the primary's edit touched are let go
  const edits = [];
  for (const c of cursors) {
    const a = lo(c), b = hi(c);
    if (b > head && a < endA) continue;
    if (a >= endA && b >= endA) { const from = a - cutBefore + delta, to = b + cutAfter + delta; if (from >= endB) edits.push({ from, to: Math.min(after.length, to), text: ins }); }
    else if (b <= head) { const from = a - cutBefore, to = b + cutAfter; if (from >= 0 && to <= head) edits.push({ from, to, text: ins }); }
  }
  if (!edits.length) return null;
  edits.sort((x, y) => x.from - y.from);
  for (let i = 1; i < edits.length; i++) if (edits[i].from < edits[i - 1].to) return null;
  // where everyone lands once the edits are made, from the top down
  const place = (p, upto = edits.length) => { let shift = 0; for (let i = 0; i < upto && edits[i].to <= p; i++) shift += edits[i].text.length - (edits[i].to - edits[i].from); return p + shift; };
  const next = edits.map((e, i) => { const at = place(e.from, i) + e.text.length; return { anchor: at, head: at }; });
  const primaryAt = place(caret);
  return { edits, cursors: next, primary: [primaryAt, primaryAt] };
}

// the others moved onto a text edited elsewhere (another person's edit): those inside the
// edit let go, those after it shifted
export function rebaseCursors(cursors, before, after, change = commonEnds(before, after)) {
  const { head, tail } = change;
  const endA = before.length - tail, delta = after.length - before.length;
  const out = [];
  for (const c of cursors) {
    const a = lo(c), b = hi(c);
    if (b <= head) out.push(c);
    else if (a >= endA) out.push({ anchor: c.anchor + delta, head: c.head + delta });
  }
  return out;
}
