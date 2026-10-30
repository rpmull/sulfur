// The minimap, as VS Code's editor.minimap: the file's lines drawn tiny beside the text, a
// slider over the part on screen; a file taller than the minimap slides through it with
// the scroll. Pure: the editor draws what's worked out here onto its canvas.

// which lines the minimap shows and where the slider lies, for the scroll position now
export function minimapLayout({ lines, lineHeight, scrollTop, viewHeight, height, rowHeight }) {
  const rowsFit = Math.max(1, Math.floor(height / rowHeight));
  const viewLines = viewHeight / lineHeight;
  const viewFirst = scrollTop / lineHeight;
  let first = 0, sliding = false;
  if (lines > rowsFit) {
    sliding = true;
    const most = Math.max(1, (lines - viewLines) * lineHeight);
    const p = Math.max(0, Math.min(1, scrollTop / most));
    first = Math.round(p * (lines - rowsFit));
  }
  const count = Math.min(rowsFit, lines - first);
  return { first, count, sliding, sliderTop: (viewFirst - first) * rowHeight, sliderHeight: Math.min(height, viewLines * rowHeight) };
}

// the scroll position that puts the line under a click at y mid-view
export function minimapScrollFor(layout, y, { lineHeight, viewHeight, rowHeight }) {
  const line = layout.first + y / rowHeight;
  return Math.max(0, line * lineHeight - viewHeight / 2);
}

// cached rows moved onto an edited text: the lines above the edit kept, those below moved
// by the lines it added or took away, the edited lines made again by runsFor(from, to).
// change: the edit's common head and tail with the cached text. null when the edit lies
// outside the cached band (the band is made afresh then)
export function minimapRebaseRows(cache, text, lineStarts, change, runsFor) {
  const lineOf = (p) => { let lo = 0, hi = lineStarts.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= p) lo = mid + 1; else hi = mid; } return Math.max(0, lo - 1); };
  const { head, tail } = change;
  const headLine = lineOf(head);
  const endNew = lineOf(text.length - tail);
  let endOld = headLine;
  for (let i = cache.text.indexOf('\n', head), stop = cache.text.length - tail; i >= 0 && i < stop; i = cache.text.indexOf('\n', i + 1)) endOld++;
  const delta = endNew - endOld;
  if (headLine < cache.first || endOld >= cache.last) return null;
  const last = Math.min(lineStarts.length, cache.last + delta);
  const fresh = runsFor(headLine, Math.min(last, endNew + 1));
  const rows = cache.rows.slice(0, headLine - cache.first).concat(fresh, cache.rows.slice(endOld + 1 - cache.first));
  rows.length = Math.max(0, last - cache.first);
  return { ...cache, text, last, rows };
}

// the lines first..last (exclusive) as runs to draw: per line an array of [column, length,
// class] for each stretch of non-blank characters of one color; colors sorted ranges
export function minimapRuns(text, lineStarts, first, last, colors = [], maxCols = 120, tabSize = 4) {
  const rows = [];
  let k = 0;
  const from0 = lineStarts[first] ?? text.length;
  // the first range that may reach the window, by bisection; then walked forward
  { let lo = 0, hi = colors.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (colors[mid].to <= from0) lo = mid + 1; else hi = mid; } k = lo; }
  for (let l = first; l < last && l < lineStarts.length; l++) {
    const a = lineStarts[l], b = l + 1 < lineStarts.length ? lineStarts[l + 1] - 1 : text.length;
    const runs = [];
    let col = 0, run = null;
    for (let i = a; i < b && col < maxCols; i++) {
      const c = text.charCodeAt(i);
      if (c === 9) { col += tabSize - col % tabSize; run = null; continue; }
      if (c === 32 || c === 13) { col++; run = null; continue; }
      while (k < colors.length && colors[k].to <= i) k++;
      const cls = k < colors.length && colors[k].from <= i ? colors[k].cls : '';
      if (run && run[2] === cls) run[1]++;
      else { run = [col, 1, cls]; runs.push(run); }
      col++;
    }
    rows.push(runs);
  }
  return rows;
}
