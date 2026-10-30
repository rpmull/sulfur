// The lines of a text that differ from a base (the file as last committed), for the gutter's
// change marks, as VS Code's dirty diff: added lines, modified lines, and where lines were
// deleted. Myers' diff over the lines, the common head and tail of the two texts skipped
// first, so an edit to a long file costs the edit's size, not the file's. Pure.

// the most edit steps looked for: past this (a file rewritten) there's nothing worth marking
export const DIFF_MAX = 2000;

function linesOf(text) {
  if (!text) return [];
  const out = text.split('\n');
  if (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

// [{ from, count, kind }]: from the first line (0-based) in text of a run of added or
// modified lines, count their number; kind 'deleted' marks the line before which lines of
// the base are gone (count 0). null when the texts differ in more than max steps.
export function lineChanges(base, text, max = DIFF_MAX) {
  if (base === text) return [];
  const a = linesOf(base), b = linesOf(text);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail, m = b.length - head - tail;
  const ids = new Map();
  const id = (s) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
  const A = new Int32Array(n), B = new Int32Array(m);
  for (let i = 0; i < n; i++) A[i] = id(a[head + i]);
  for (let i = 0; i < m; i++) B[i] = id(b[head + i]);
  // Myers: the furthest reaching path for each diagonal, kept per step for the trace back
  const limit = Math.min(max, n + m);
  const offset = limit + 1, width = 2 * limit + 3;
  const trace = [];
  let v = new Int32Array(width);
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    const next = new Int32Array(v);
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      next[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    trace.push(next);
    v = next;
  }
  if (found < 0) return null;
  // the path walked back: which lines of the base went and which of the text came
  const gone = new Set(), came = new Set();
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1], k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = prev[offset + pk], py = px - pk;
    while (x > px && y > py) { x--; y--; }
    if (down) came.add(y - 1); else gone.add(x - 1);
    x = px; y = py;
  }
  // between two lines both texts share, the base's lines gone and the text's come are one
  // hunk: modified when there are both, added or deleted when one kind alone
  const out = [];
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && !gone.has(i) && !came.has(j)) { i++; j++; continue; }
    const at = j;
    let deleted = 0, added = 0;
    while (i < n && gone.has(i)) { i++; deleted++; }
    while (j < m && came.has(j)) { j++; added++; }
    if (!deleted && !added) { i++; j++; continue; }
    out.push({ from: head + at, count: added, kind: added && deleted ? 'modified' : added ? 'added' : 'deleted' });
  }
  return out;
}
