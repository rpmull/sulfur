// Bismuth (.bi, https://git.philab.io/ryan/bismuth) for highlight.js: nestable
// block comments, interpolated "…{expr:spec}…" strings, raw r"…" strings,
// attributes, and the language's keywords, primitive and math types.
export default function bismuth(hljs) {
  const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
  const KEYWORDS = {
    keyword: ['let', 'var', 'const', 'fn', 'struct', 'enum', 'impl', 'type', 'match', 'if', 'else', 'for', 'while', 'loop',
      'in', 'return', 'break', 'continue', 'defer', 'unsafe', 'async', 'await', 'spawn', 'import', 'new', 'comptime',
      'assert', 'ref', 'view', 'priv', 'packed', 'distinct', 'parallel', 'reduce', 'extern', 'export', 'from', 'as', 'link'],
    literal: ['true', 'false', 'null'],
    built_in: ['self', 'sizeof', 'offsetof', 'alignof', 'print', 'eprint'],
    type: ['void', 'bool', 'char', 'str', 'byte', 'int', 'uint', 'float', 'never', 'i8', 'i16', 'i32', 'i64', 'u8', 'u16',
      'u32', 'u64', 'f32', 'f64', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'mat3', 'mat4', 'quat'],
  };
  const BLOCK_COMMENT = hljs.COMMENT('/\\*', '\\*/', { contains: ['self'] });
  const SUBST = { className: 'subst', begin: /\{(?!\{)/, end: /\}/, keywords: KEYWORDS, contains: [] };
  const STRING = {
    className: 'string',
    variants: [
      { begin: /\br"/, end: /"/ },
      { begin: /"/, end: /"/, contains: [{ className: 'char.escape', begin: /\\(?:u\{[0-9A-Fa-f]+\}|x[0-9A-Fa-f]{2}|.)|\{\{|\}\}/ }, SUBST] },
    ],
  };
  const CHAR = { className: 'string', begin: /'(?:\\(?:u\{[0-9A-Fa-f]+\}|x[0-9A-Fa-f]{2}|.)|[^'\\])'/ };
  const NUMBER = {
    className: 'number',
    variants: [
      { begin: /\b0[xX][0-9A-Fa-f_]+(?:[iu](?:8|16|32|64))?/ },
      { begin: /\b0[bB][01_]+(?:[iu](?:8|16|32|64))?/ },
      { begin: /\b0o[0-7_]+(?:[iu](?:8|16|32|64))?/ },
      { begin: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:[iu](?:8|16|32|64)|f32|f64)?/ },
    ],
    relevance: 0,
  };
  SUBST.contains = [STRING, CHAR, NUMBER, BLOCK_COMMENT];
  return {
    name: 'Bismuth',
    aliases: ['bi'],
    keywords: KEYWORDS,
    illegal: '</',
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      BLOCK_COMMENT,
      STRING,
      CHAR,
      NUMBER,
      { className: 'meta', begin: '@' + IDENT + '(?:\\.' + IDENT + ')*' },
      { begin: [/\bfn/, /\s+/, IDENT], beginScope: { 1: 'keyword', 3: 'title.function' } },
      { begin: [/\b(?:struct|enum|type)/, /\s+/, IDENT], beginScope: { 1: 'keyword', 3: 'title.class' } },
      { className: 'variable.constant', begin: /\b[A-Z][A-Z0-9_]+\b/, relevance: 0 },
      { className: 'title.class', begin: /\b[A-Z][A-Za-z0-9_]*/, relevance: 0 },
      { className: 'title.function.invoke', begin: IDENT + '(?=\\s*\\()', relevance: 0 },
    ],
  };
}
