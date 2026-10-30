// Sticky scroll, as VS Code's editor.stickyScroll: the lines that open the scopes the top of
// the view is inside (a class, a function, an if) held at the top as it scrolls away from
// them. Pure: the syntax tree gives the scopes, the editor draws the lines.

// grammar nodes that open a scope worth holding: declarations, definitions, statements and
// the like across the page's grammars; the bare bodies and blocks inside them are not (they
// begin on their opener's line, or on the line after it in Python)
export const SCOPE = /(Declaration|Definition|Decl|Item|Statement|Specifier|RuleSet|Element|Property|Pair|Clause|Arm|ArrowFunction|FunctionExpression|ClassExpression|CallExpression|NewExpression|MatchExpression|IfExpression|ForExpression|WhileExpression|LoopExpression|ClosureExpression|Lambda)$/;
export const STICKY_MAX = 5;

const lineOfIn = (lineStarts, p) => { let lo = 0, hi = lineStarts.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= p) lo = mid + 1; else hi = mid; } return Math.max(0, lo - 1); };

// the lines to hold at the top when topLine is the first line on screen: outermost first,
// at most max of them. Each row hides a line of the text; a scope opening on a hidden line
// is held too, and a scope whose last line a row would hide is let go, as VS Code pushes
// a header out as its scope's end comes up
export function stickyLines(tree, text, lineStarts, topLine, max = STICKY_MAX) {
  if (!tree || topLine <= 0) return [];
  const rows = [];
  for (let i = 0; i <= rows.length && i < max; i++) {
    const line = topLine + i;
    if (line >= lineStarts.length) break;
    const found = new Map();
    for (let node = tree.resolveInner(lineStarts[line], 1); node; node = node.parent) {
      if (node.type.isTop) break;
      if (!SCOPE.test(node.name) || node.to <= node.from) continue;
      const a = lineOfIn(lineStarts, node.from), b = lineOfIn(lineStarts, node.to - 1);
      if (a >= line || b <= a || b < line) continue;
      if (!found.has(a) || found.get(a) < b) found.set(a, b);
    }
    for (const [start, end] of [...found].sort((x, y) => x[0] - y[0])) {
      if (rows.length >= max) break;
      if (start <= (rows[rows.length - 1] ?? -1)) continue;
      if (end < topLine + rows.length) continue;
      rows.push(start);
    }
  }
  return rows;
}
