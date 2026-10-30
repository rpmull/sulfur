import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMatch, allMatches, replicateEdit, moveCursors, moveCursorsVertically, cursorBeside, cursorsAtLineEnds, normalizeCursors, rebaseCursors } from '../src/sulfur/multi-cursor.js';
import { opApply, opEdits } from '../src/text-operations.js';

const apply = (text, edits) => opApply(text, opEdits(text, edits));
// typing at the primary as the browser does it, then the replication
function type(text, primary, cursors, insert, removeBefore = 0, removeAfter = 0) {
  const [s, e] = primary;
  const from = s - removeBefore, to = e + removeAfter;
  const after = text.slice(0, from) + insert + text.slice(to);
  const caret = from + insert.length;
  const r = replicateEdit(text, after, primary, caret, cursors);
  return r ? { text: apply(after, r.edits), ...r } : { text: after, cursors: [], primary: [caret, caret] };
}

test('Ctrl+D selects the word at the caret, then the next whole-word match, wrapping round', () => {
  const text = 'foo food foo bar foo';
  let m = nextMatch(text, [1, 1], []);
  assert.deepEqual(m, { select: [0, 3], whole: true });
  m = nextMatch(text, [0, 3], [], true);
  assert.deepEqual(m.select, [9, 12]);
  m = nextMatch(text, [9, 12], [{ anchor: 0, head: 3 }], true);
  assert.deepEqual(m.select, [17, 20]);
  m = nextMatch(text, [17, 20], [{ anchor: 0, head: 3 }, { anchor: 9, head: 12 }], true);
  assert.equal(m, null);
  // a selection made by hand matches anywhere
  assert.deepEqual(nextMatch(text, [0, 2], []).select, [4, 6]);
  // wrapping round from the last match to the first
  assert.deepEqual(nextMatch(text, [17, 20], [{ anchor: 9, head: 12 }], true).select, [0, 3]);
});

test('Ctrl+Shift+L takes every occurrence, the primary kept last', () => {
  const text = 'a ab a\na';
  const all = allMatches(text, [5, 5]);
  assert.deepEqual(all, [{ anchor: 0, head: 1 }, { anchor: 7, head: 8 }, { anchor: 5, head: 6 }]);
  assert.deepEqual(allMatches(text, [2, 3]).length, 4);
});

test('typing, backspace, delete and paste at the primary happen at every cursor in one step', () => {
  let text = 'x = 1\ny = 2\nz = 3';
  let cursors = [{ anchor: 0, head: 0 }, { anchor: 6, head: 6 }];
  let r = type(text, [12, 12], cursors, 'const ');
  assert.equal(r.text, 'const x = 1\nconst y = 2\nconst z = 3');
  assert.deepEqual(r.cursors, [{ anchor: 6, head: 6 }, { anchor: 18, head: 18 }]);
  assert.deepEqual(r.primary, [30, 30]);
  r = type(r.text, r.primary, r.cursors, '', 1, 0);
  assert.equal(r.text, 'constx = 1\nconsty = 2\nconstz = 3');
  r = type(r.text, r.primary, r.cursors, '', 0, 1);
  assert.equal(r.text, 'const = 1\nconst = 2\nconst = 3');
  r = type(r.text, r.primary, r.cursors, ' let\n');
  assert.equal(r.text, 'const let\n = 1\nconst let\n = 2\nconst let\n = 3');
});

test('a repeated character typed before its twin is still typed at the other cursors', () => {
  // 'b' typed at 2 in 'abb': the diff could sit at 3, the caret says 2
  const r = type('ab b\nab b', [2, 2], [{ anchor: 7, head: 7 }], 'b');
  assert.equal(r.text, 'abb b\nabb b');
  // a backspace between two b's: a backspace at the others too, not a delete
  const b = type('abb|\nabb|', [2, 2], [{ anchor: 7, head: 7 }], '', 1, 0);
  assert.equal(b.text, 'ab|\nab|');
  assert.deepEqual(b.cursors, [{ anchor: 5, head: 5 }]);
});

test('typing over selections replaces each, and cursors before the primary shift it', () => {
  const text = 'one two one';
  const r = type(text, [8, 11], [{ anchor: 0, head: 3 }], 'three');
  assert.equal(r.text, 'three two three');
  assert.deepEqual(r.primary, [15, 15]);
  assert.deepEqual(r.cursors, [{ anchor: 5, head: 5 }]);
});

test('an edit away from the primary lets the others go, as does one that touches them', () => {
  const text = 'ab\nab';
  assert.equal(replicateEdit(text, 'xab\nab', [4, 4], 4, [{ anchor: 1, head: 1 }]), null);
  assert.equal(replicateEdit(text, text, [4, 4], 4, [{ anchor: 1, head: 1 }]), null);
  // the primary's edit swallowing the other cursor
  assert.equal(replicateEdit('abcd', 'd', [0, 3], 0, [{ anchor: 2, head: 2 }]), null);
});

test('cursors move together: left, right, words, home, end, lines up and down', () => {
  const text = '  foo bar\nbaz  qux';
  const cs = [{ anchor: 5, head: 5 }, { anchor: 13, head: 13 }];
  assert.deepEqual(moveCursors(text, cs, 'left'), [{ anchor: 4, head: 4 }, { anchor: 12, head: 12 }]);
  assert.deepEqual(moveCursors(text, cs, 'right', true), [{ anchor: 5, head: 6 }, { anchor: 13, head: 14 }]);
  assert.deepEqual(moveCursors(text, cs, 'wordLeft').map((c) => c.head), [2, 10]);
  assert.deepEqual(moveCursors(text, cs, 'wordRight').map((c) => c.head), [9, 18]);
  assert.deepEqual(moveCursors(text, cs, 'home').map((c) => c.head), [2, 10]);
  assert.deepEqual(moveCursors(text, [{ anchor: 2, head: 2 }], 'home').map((c) => c.head), [0]);
  assert.deepEqual(moveCursors(text, cs, 'end').map((c) => c.head), [9, 18]);
  assert.deepEqual(moveCursorsVertically(text, [{ anchor: 5, head: 5 }], 1).map((c) => c.head), [15]);
  assert.deepEqual(moveCursorsVertically(text, [{ anchor: 15, head: 15 }], -1).map((c) => c.head), [5]);
  assert.deepEqual(moveCursorsVertically(text, [{ anchor: 5, head: 5 }], -1).map((c) => c.head), [0]);
  // two cursors meeting become one
  assert.deepEqual(moveCursors('ab', [{ anchor: 0, head: 0 }, { anchor: 1, head: 1 }], 'left'), [{ anchor: 0, head: 0 }]);
});

test('cursors above, below and at line ends, with tabs to their stops', () => {
  const text = 'a\tb\n    cd\nef';
  assert.deepEqual(cursorBeside(text, 3, 1), { anchor: 9, head: 9 });
  assert.deepEqual(cursorBeside(text, 9, -1), { anchor: 3, head: 3 });
  assert.deepEqual(cursorBeside(text, 8, -1), { anchor: 2, head: 2 });
  assert.equal(cursorBeside(text, 0, -1), null);
  assert.equal(cursorBeside(text, 12, 1), null);
  assert.deepEqual(cursorsAtLineEnds(text, 0, text.length).map((c) => c.head), [3, 10, 13]);
  assert.deepEqual(cursorsAtLineEnds(text, 0, 2).map((c) => c.head), [3]);
});

test('overlapping cursors merge and a remote edit moves or drops them', () => {
  assert.deepEqual(normalizeCursors([{ anchor: 5, head: 2 }, { anchor: 3, head: 7 }, { anchor: 9, head: 9 }]), [{ anchor: 7, head: 2 }, { anchor: 9, head: 9 }]);
  const cs = [{ anchor: 1, head: 1 }, { anchor: 4, head: 6 }, { anchor: 9, head: 9 }];
  assert.deepEqual(rebaseCursors(cs, 'abcdefghij', 'abcXXXghij'), [{ anchor: 1, head: 1 }, { anchor: 9, head: 9 }]);
  assert.deepEqual(rebaseCursors(cs, 'abcdefghij', 'abZZcdefghij'), [{ anchor: 1, head: 1 }, { anchor: 6, head: 8 }, { anchor: 11, head: 11 }]);
});
