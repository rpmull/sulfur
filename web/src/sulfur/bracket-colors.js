// Bracket pairs colored by their nesting, as VS Code's editor.bracketPairColorization: each
// level its own color, cycling through three, a closer with no opener red. Pure: the editor
// gives its text, the spans to look past (strings and comments) and the openers still open
// where a window begins; nothing here reads the whole file on a keystroke.
import { commonEnds } from '../text-operations.js';

// grammar node names whose brackets aren't code
export const STRINGY = /String|Comment|Regex|Template|Char|TextBlock|^Text$|Heredoc/;
export const LEVELS = 3;

// [from, to) spans of strings and comments within from..to, from a syntax tree
export function skipSpansFromTree(tree, from, to) {
  const out = [];
  tree.iterate({ from, to, enter(n) { if (STRINGY.test(n.name)) { out.push([n.from, n.to]); return false; } } });
  return out;
}
// the same from highlighted ranges ({ from, to, cls }, sorted)
export function skipSpansFromRanges(ranges, from, to) {
  const out = [];
  let lo = 0, hi = ranges.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ranges[mid].to <= from) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < ranges.length && ranges[i].from < to; i++) if (/hljs-(comment|string|regexp)/.test(ranges[i].cls)) out.push([ranges[i].from, ranges[i].to]);
  return out;
}

// text from..to walked for brackets, stack the openers open at from (a string of them),
// skip the spans to look past (sorted); visit(at, depth, unexpected) for each bracket.
// Returns the openers open at to.
export function scanBrackets(text, from, to, stack = '', skip = [], visit = null) {
  let k = 0;
  for (let i = from; i < to; i++) {
    while (k < skip.length && skip[k][1] <= i) k++;
    if (k < skip.length && skip[k][0] <= i) { i = skip[k][1] - 1; continue; }
    const c = text.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) { visit?.(i, stack.length, false); stack += String.fromCharCode(c); }
    else if (c === 41 || c === 93 || c === 125) {
      const open = c === 41 ? '(' : c === 93 ? '[' : '{';
      const at = stack.lastIndexOf(open);
      if (at < 0) visit?.(i, stack.length, true);
      else { visit?.(i, at, false); stack = stack.slice(0, at); }
    }
  }
  return stack;
}

// the brackets of from..to as highlight ranges, colored by level
export function bracketRanges(text, from, to, stack = '', skip = []) {
  const out = [];
  scanBrackets(text, from, to, stack, skip, (at, depth, unexpected) => out.push({ from: at, to: at + 1, cls: unexpected ? 'bracket-unexpected' : `bracket-${depth % LEVELS + 1}` }));
  return out;
}

// The openers open at any offset of a text, found once and kept: a mark every step
// characters, those before an edit kept across it, so a keystroke costs a scan from the
// nearest mark rather than from the top of the file.
export function bracketStateIndex(step = 8192) {
  let text = null, marks = [];
  return {
    text: () => text,
    // the openers open at offset at of now; skipFor(from, to) the spans to look past there;
    // change: what changed since the text last given, when the caller knows it
    stateAt(now, at, skipFor, change = null) {
      if (now !== text) {
        if (text !== null && marks.length) { const { head } = change || commonEnds(text, now); marks = marks.filter((m) => m.at <= head); }
        else marks = [];
        text = now;
      }
      let start = 0, stack = '';
      for (let i = marks.length - 1; i >= 0; i--) if (marks[i].at <= at) { start = marks[i].at; stack = marks[i].stack; break; }
      while (start < at) {
        const next = Math.min(at, start + step - start % step);
        stack = scanBrackets(text, start, next, stack, skipFor(start, next));
        start = next;
        if (next % step === 0 && next > (marks[marks.length - 1]?.at ?? -1)) marks.push({ at: next, stack });
      }
      return stack;
    },
    clear() { text = null; marks = []; },
  };
}

// two sorted, disjoint range lists as one, over's ranges winning where they overlap
export function mergeRanges(base, over) {
  if (!over.length) return base;
  if (!base.length) return over;
  const out = [];
  let i = 0, j = 0;
  while (i < base.length || j < over.length) {
    const a = base[i], b = over[j];
    if (!b || (a && a.to <= b.from)) { out.push(a); i++; continue; }
    if (!a || b.to <= a.from) { out.push(b); j++; continue; }
    // overlapping: the base range cut around the overlay's
    if (a.from < b.from) out.push({ ...a, to: b.from });
    out.push(b);
    if (a.to > b.to) base = [...base.slice(0, i), { ...a, from: b.to }, ...base.slice(i + 1)]; else i++;
    j++;
  }
  return out;
}
