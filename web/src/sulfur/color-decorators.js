// Color decorators, as VS Code's editor.colorDecorators in stylesheets: each color written
// in the text (#rgb, #rrggbb, #rrggbbaa, rgb(), hsl()) shown in that color under itself.
// Pure: a window of text in, the literals and their colors out.
export const COLOR_LANGS = new Set(['css', 'scss', 'less', 'sass', 'stylus', 'html', 'svelte', 'vue', 'astro']);

const LITERAL = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)/gi;

// the colors written within from..to of text; code(i) false where i is in a comment
export function colorLiterals(text, from, to, code = () => true) {
  const out = [];
  const start = text.lastIndexOf('\n', from - 1) + 1;
  LITERAL.lastIndex = start;
  for (let m; (m = LITERAL.exec(text)) && m.index < to;) {
    if (m.index + m[0].length <= from || !code(m.index)) continue;
    out.push({ from: m.index, to: m.index + m[0].length, color: m[0] });
  }
  return out;
}
