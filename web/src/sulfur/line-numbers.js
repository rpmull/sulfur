// The gutter's numbers for lines first..last (exclusive), as VS Code's editor.lineNumbers:
// on, relative (each line's distance from the caret's, the caret's own absolute), interval
// (every tenth), or off
export const LINE_NUMBER_MODES = ['on', 'relative', 'interval', 'off'];

export function lineNumberLabels(first, last, caretLine = -1, mode = 'on') {
  if (mode === 'off') return '';
  const out = [];
  for (let l = first; l < last; l++) {
    const n = l + 1;
    if (mode === 'relative') out.push(l === caretLine ? String(n) : String(Math.abs(l - caretLine)));
    else if (mode === 'interval') out.push(n % 10 === 0 || l === caretLine ? String(n) : '');
    else out.push(String(n));
  }
  return out.join('\n');
}
