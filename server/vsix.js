import { unzipSync, strFromU8 } from 'fflate';
import { parse as parseJSONC } from 'jsonc-parser';
import { XMLParser } from 'fast-xml-parser';
import path from 'node:path';
import tables from '../assets/vsx-tables.json';
import { fail } from './util.js';
const list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => (typeof x === 'string' ? x : '');
const cleanID = (x) =>
  String(x)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
const stringify = (x) => JSON.stringify(x, null, 2) + '\n';
export function cleanRel(base, rel) {
  rel = String(rel || '').replaceAll('\\', '/');
  if (rel.startsWith('/') || /[:\0]/.test(rel)) throw fail(`unsafe package path: ${rel}`);
  const name = path.posix.normalize(path.posix.join(base, rel));
  if (name === '.' || name === '..' || name.startsWith('../'))
    throw fail(`unsafe package path: ${rel}`);
  return name;
}
export function parseData(name, data) {
  const raw = Buffer.from(data)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  if (!raw.trimStart().startsWith('<')) {
    const errors = [];
    const value = parseJSONC(raw, errors, { allowTrailingComma: true });
    if (errors.length) throw fail(`${name}: invalid JSON`);
    return value;
  }
  const xml = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    processEntities: true,
    trimValues: false,
    parseTagValue: false,
  }).parse(raw);
  const element = (node) => Object.keys(node).some((key) => ![':', '#', '?', '!'].includes(key[0]));
  const value = (node) => {
    const key = Object.keys(node).find((k) => ![':', '#', '?', '!'].includes(k[0]));
    const children = node[key];
    if (key === 'plist') return value(children.find(element));
    if (key === 'dict') {
      const out = {},
        nodes = children.filter(element);
      for (let i = 0; i < nodes.length; i++)
        if (nodes[i].key) {
          const name = (nodes[i].key[0]?.['#text'] ?? '').toString();
          out[name] = value(nodes[++i]);
        }
      return out;
    }
    if (key === 'array') return children.filter(element).map(value);
    if (key === 'true') return true;
    if (key === 'false') return false;
    const content = children.map((c) => c['#text'] ?? '').join('');
    return ['integer', 'real'].includes(key) ? Number(content) : content;
  };
  return value(xml.find((n) => n.plist) || xml.find((n) => !Object.keys(n)[0].startsWith('?')));
}
export function openVSIX(data) {
  const names = new Set();
  let total = 0;
  const files = unzipSync(data, {
    filter(file) {
      const name = file.name.replaceAll('\\', '/');
      if (!name.startsWith('extension/') || name.endsWith('/')) return false;
      const rel = cleanRel('', name.slice(10)),
        key = rel.toLowerCase();
      if (names.has(key)) throw fail(`duplicate package path: ${rel}`);
      names.add(key);
      if (file.originalSize > 32 << 20 || (total += file.originalSize) > 256 << 20)
        throw fail('extension package exceeds the unpacked size limit');
      return true;
    },
  });
  const byName = new Map(
    Object.entries(files).map(([name, data]) => [
      cleanRel('', name.replaceAll('\\', '/').slice(10)),
      data,
    ]),
  );
  const index = new Map([...byName.keys()].map((name) => [name.toLowerCase(), name]));
  const read = (rel) => {
    const b = byName.get(index.get(rel.toLowerCase()));
    if (!b) throw fail(`${rel} isn't in the package`);
    return b;
  };
  const get = (rel) => parseData(rel, read(rel));
  const manifest = get('package.json');
  let nls = {};
  try {
    nls = get('package.nls.json');
  } catch {}
  const localize = (v) => {
    const s = text(v);
    return s.startsWith('%') && s.endsWith('%')
      ? nls[s.slice(1, -1)]?.message || nls[s.slice(1, -1)] || s
      : s;
  };
  return { files: byName, read, get, manifest, localize };
}
export function plan(manifest) {
  const out = [],
    c = manifest.contributes || {};
  for (const [key, kind] of [
    ['themes', 'theme'],
    ['iconThemes', 'iconTheme'],
    ['languages', 'language'],
    ['grammars', 'grammar'],
    ['snippets', 'snippets'],
    ['keybindings', 'keybindings'],
  ])
    if (list(c[key]).length)
      out.push({
        kind,
        status: key === 'keybindings' ? 'partial' : 'converted',
        name: `${list(c[key]).length} ${kind}`,
      });
  if (manifest.browser || manifest.main)
    out.push({
      kind: 'code',
      status: 'partial',
      name: manifest.browser ? 'web build' : 'Node extension',
      detail: manifest.browser
        ? 'Browser host with CommonJS and ESM module resolution'
        : 'Separate Bun process with Node APIs and the VS Code bridge; unsupported APIs are reported',
    });
  for (const k of Object.keys(c))
    if (
      ![
        'themes',
        'iconThemes',
        'languages',
        'grammars',
        'snippets',
        'keybindings',
        'configuration',
        'configurationDefaults',
      ].includes(k)
    )
      out.push({
        kind: k,
        status: manifest.browser || manifest.main ? 'partial' : 'skipped',
        name: k,
        detail: tables.vsxUnsupported[k] || 'This contribution requires extension API support',
      });
  return out;
}
export function convertVSIX(data, source = {}, options = {}) {
  const pkg = openVSIX(data),
    m = pkg.manifest,
    c = m.contributes || {},
    files = {},
    binary = {},
    contributes = {},
    report = [];
  source = {
    ...source,
    namespace: source.namespace || m.publisher,
    name: source.name || m.name,
    version: source.version || m.version,
  };
  if (!source.namespace || !source.name) throw fail('package.json names no publisher and name');
  const id = `vsx.${cleanID(source.namespace)}.${cleanID(source.name)}`,
    languages = new Map();
  let total = 0;
  const add = (kind, status, name, detail = '') =>
    report.push({ kind, status, name, ...(detail ? { detail } : {}) });
  const write = (folder, name, value) => {
    const data = stringify(value);
    if ((total += Buffer.byteLength(data)) > 14 << 20)
      throw fail('the converted extension would be over 14MB');
    const stem = cleanID(
      path.posix
        .basename(name)
        .replace(/\.(tmlanguage\.json|tmlanguage|tmtheme|json|plist|code-snippets)$/i, ''),
    );
    let file = `${folder}/${stem}.json`,
      n = 1;
    while (files[file]) file = `${folder}/${stem}-${++n}.json`;
    files[file] = data;
    return file;
  };
  const language = (id) => {
    if (!languages.has(id)) {
      const known = tables.vscodeLanguages[id] || ['', ''];
      languages.set(id, {
        id,
        extensions: known[0].split(' ').filter(Boolean),
        filenames: known[1].split(' ').filter(Boolean),
      });
    }
    return languages.get(id);
  };
  for (const l of list(c.languages)) {
    if (!l.id) continue;
    const e = language(l.id);
    e.extensions = [
      ...new Set([
        ...e.extensions,
        ...list(l.extensions).map((s) => s.replace(/^\./, '').toLowerCase()),
      ]),
    ];
    e.filenames = [...new Set([...e.filenames, ...list(l.filenames).map((s) => s.toLowerCase())])];
    if (l.aliases) e.aliases = l.aliases;
    let detail = l.filenamePatterns?.length ? 'filename patterns not used' : '';
    if (l.configuration)
      try {
        const cfg = pkg.get(cleanRel('', l.configuration));
        if (cfg.comments)
          e.comments = {
            ...cfg.comments,
            lineComment:
              typeof cfg.comments.lineComment === 'object'
                ? cfg.comments.lineComment.comment
                : cfg.comments.lineComment,
          };
        for (const key of ['brackets', 'autoClosingPairs'])
          if (cfg[key])
            e[key] = cfg[key]
              .map((v) => (Array.isArray(v) ? v : [v.open, v.close]))
              .filter((v) => v.every((x) => typeof x === 'string'));
        const unsupported = ['indentationRules', 'onEnterRules', 'wordPattern', 'folding'].filter(
          (k) => cfg[k],
        );
        if (unsupported.length) detail = unsupported.join(', ') + ' not used';
      } catch (error) {
        detail = error.message;
      }
    add('language', detail ? 'partial' : 'converted', l.aliases?.[0] || l.id, detail);
  }
  for (const g of list(c.grammars))
    try {
      if (!g.path || !g.scopeName) throw fail('no scopeName or path');
      const grammar = pkg.get(cleanRel('', g.path));
      if (!grammar.patterns && !grammar.repository) throw fail('not a TextMate grammar');
      (contributes.grammars ||= []).push({ ...g, path: write('syntaxes', g.path, grammar) });
      if (g.language) language(g.language);
      add(
        'grammar',
        g.injectTo ? 'partial' : 'converted',
        g.scopeName,
        g.injectTo
          ? 'injection rules require host support'
          : `for ${g.language || 'included scopes'}`,
      );
    } catch (error) {
      add('grammar', 'skipped', g.scopeName || '', error.message);
    }
  const themeData = (rel, seen = new Set()) => {
    if (seen.has(rel) || seen.size >= 12) throw fail('theme include cycle');
    seen.add(rel);
    const t = pkg.get(rel);
    const parent = t.include
      ? themeData(cleanRel(path.posix.dirname(rel), t.include), seen)
      : { colors: {}, tokenColors: [] };
    let rules = t.tokenColors || t.settings || [];
    if (typeof rules === 'string') rules = pkg.get(cleanRel(path.posix.dirname(rel), rules));
    const global = list(t.settings).find((s) => !s.scope)?.settings || {};
    return {
      colors: {
        ...parent.colors,
        ...t.colors,
        ...(global.background ? { 'editor.background': global.background } : {}),
        ...(global.foreground ? { 'editor.foreground': global.foreground } : {}),
      },
      tokenColors: [...parent.tokenColors, ...list(rules)],
    };
  };
  for (const t of list(c.themes))
    try {
      const data = themeData(cleanRel('', t.path)),
        vars = {},
        color = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
      for (const [key, ...names] of tables.themeVars) {
        const value = names.map((n) => data.colors[n]).find((v) => color.test(v));
        if (value) vars[key] = value;
      }
      const match = (scope) => {
        let best = {},
          score = -1;
        for (const r of data.tokenColors)
          for (const s of Array.isArray(r.scope) ? r.scope : (r.scope || '').split(',')) {
            const token = s.trim();
            if ((scope === token || scope.startsWith(token + '.')) && token.length >= score) {
              best = { ...best, ...r.settings };
              score = token.length;
            }
          }
        return best;
      };
      for (const [key, ...scopes] of tables.themeTokens) {
        const value = scopes.map((s) => match(s).foreground).find((v) => color.test(v));
        if (value) vars[key] = value;
      }
      const style = match('comment.line').fontStyle;
      if (style !== undefined)
        vars['--hl-cmt-style'] = style.includes('italic') ? 'italic' : 'normal';
      if (color.test(data.colors['widget.shadow']))
        vars['--ide-shadow'] = `0 0 8px 2px ${data.colors['widget.shadow']}`;
      const label = pkg.localize(t.label) || t.id || path.posix.basename(t.path),
        type = { vs: 'light', 'hc-black': 'hc-dark', 'hc-light': 'hc-light' }[t.uiTheme] || 'dark';
      (contributes.themes ||= []).push({
        id: cleanID(t.id || label),
        label,
        uiTheme: type,
        path: write('themes', t.path, { label, type, vars }),
      });
      add('theme', 'converted', label);
    } catch (error) {
      add('theme', 'skipped', pkg.localize(t.label), error.message);
    }
  const dataURL = (base, rel) => {
    const name = cleanRel(base, rel);
    return `data:${tables.mimeOf[path.posix.extname(name).toLowerCase()] || 'application/octet-stream'};base64,${Buffer.from(pkg.read(name)).toString('base64')}`;
  };
  for (const t of list(c.iconThemes))
    try {
      const th = pkg.get(cleanRel('', t.path)),
        base = path.posix.dirname(t.path),
        defs = {},
        fonts = {},
        used = new Set();
      let missing = 0;
      const collect = (v) => {
        if (typeof v === 'string') used.add(v);
        else if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v))
            if (!['iconDefinitions', 'fonts'].includes(k)) collect(x);
      };
      collect(th);
      for (const [key, v] of Object.entries(th.iconDefinitions || {})) {
        if (!used.has(key)) continue;
        try {
          if (v.iconPath) defs[key] = { src: dataURL(base, v.iconPath) };
          else if (v.fontCharacter)
            defs[key] = {
              char: v.fontCharacter.replace(/^\\([a-f0-9]+)$/i, (_, n) =>
                String.fromCodePoint(parseInt(n, 16)),
              ),
              ...(v.fontColor ? { color: v.fontColor } : {}),
              font: v.fontId || th.fonts?.[0]?.id || '',
              ...(v.fontSize ? { size: v.fontSize } : {}),
            };
        } catch {
          missing++;
        }
      }
      for (const font of th.fonts || []) {
        const src = font.src?.[0];
        if (src?.path)
          fonts[font.id] = {
            src: dataURL(base, src.path),
            format: src.format,
            weight: font.weight,
            style: font.style,
            size: font.size,
          };
      }
      const mappings = (obj) => {
        const out = {};
        for (const key of [
          'file',
          'folder',
          'folderExpanded',
          'rootFolder',
          'rootFolderExpanded',
          'fileExtensions',
          'fileNames',
          'folderNames',
          'folderNamesExpanded',
          'rootFolderNames',
          'rootFolderNamesExpanded',
        ])
          if (obj[key])
            out[key] =
              typeof obj[key] === 'object'
                ? Object.fromEntries(Object.entries(obj[key]).map(([k, v]) => [k.toLowerCase(), v]))
                : obj[key];
        for (const [id, icon] of Object.entries(obj.languageIds || {})) {
          (out.languageExtensions ||= {})[id] = icon;
          const l = language(id);
          for (const ext of l.extensions) (out.fileExtensions ||= {})[ext] ||= icon;
          for (const name of l.filenames) (out.fileNames ||= {})[name] ||= icon;
        }
        return out;
      };
      const label = pkg.localize(t.label) || t.id;
      const out = {
        ...mappings(th),
        light: mappings(th.light || {}),
        label,
        defs,
        fonts,
        ...(th.hidesExplorerArrows ? { hidesExplorerArrows: true } : {}),
      };
      (contributes.iconThemes ||= []).push({
        id: cleanID(t.id || label),
        label,
        path: write('icons', t.path, out),
      });
      add(
        'iconTheme',
        missing ? 'partial' : 'converted',
        label,
        missing ? `${missing} missing icons` : '',
      );
    } catch (error) {
      add('iconTheme', 'skipped', pkg.localize(t.label), error.message);
    }
  for (const snippet of list(c.snippets))
    try {
      const raw = pkg.get(cleanRel('', snippet.path)),
        values = [],
        langs = list(snippet.language).filter(Boolean);
      for (const [name, v] of Object.entries(raw)) {
        const prefix = list(v.prefix).filter((s) => typeof s === 'string');
        const body = Array.isArray(v.body) ? v.body.join('\n') : v.body;
        if (!prefix.length || typeof body !== 'string') continue;
        const scope = text(v.scope)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        values.push({
          name,
          prefix,
          body,
          ...(v.description ? { description: v.description } : {}),
          ...(scope.length ? { scope } : {}),
        });
        for (const id of scope) if (!langs.includes(id)) langs.push(id);
      }
      const exts = [...new Set(langs.flatMap((id) => language(id).extensions))],
        names = [...new Set(langs.flatMap((id) => language(id).filenames))];
      (contributes.snippets ||= []).push({
        language: langs[0] || '',
        languages: langs,
        path: write('snippets', snippet.path, values),
        extensions: exts,
        filenames: names,
      });
      add('snippets', 'converted', snippet.path, `${values.length} snippets`);
    } catch (error) {
      add('snippets', 'skipped', snippet.path, error.message);
    }
  let runtime = '',
    entry = '';
  const resolveEntry = (name) => {
    if (!name) return '';
    for (const s of [name, `${name}.js`, `${name}.cjs`, `${name}.mjs`, `${name}/index.js`]) {
      const p = cleanRel('', s);
      if (pkg.files.has(p)) return p;
    }
    return '';
  };
  const browser = resolveEntry(m.browser),
    node = resolveEntry(m.main);
  entry = options.preferNode ? node || browser : browser || node;
  runtime = entry === browser && browser ? 'browser' : node ? 'bun' : '';
  // Preserve native LSP conversion: language clients often only wire up a server
  // and use VS Code APIs that are not part of Sulfur's extension bridge.
  const clientCode = node ? Buffer.from(pkg.read(node)).toString() : '';
  const usesClient =
    !!m.dependencies?.['vscode-languageclient'] ||
    !!m.devDependencies?.['vscode-languageclient'] ||
    /LanguageClient/.test(clientCode);
  if (usesClient) {
    const strings = new Set(
      [...clientCode.matchAll(/["'`]([^"'`\n]+)["'`]/g)].flatMap((x) => [
        x[1].replace(/^\.\//, ''),
        ...x[1].split('/'),
      ]),
    );
    let best = '',
      score = 0,
      native = false;
    for (const rel of [...pkg.files.keys()].sort()) {
      if (
        rel === node ||
        /(^|\/)(test|tests|example|examples|\.github)\/|\.map$|node_modules\/(vscode-languageclient|vscode-jsonrpc)/.test(
          rel,
        )
      )
        continue;
      const base = path.posix.basename(rel),
        ext = path.posix.extname(base),
        isNative = ext === '.exe' || (!ext && rel.includes('/bin/'));
      if (!isNative && !/\.[cm]?js$/.test(rel)) continue;
      let value =
        (/server|language.?server|langserver|clangd|terraform-ls|lua-language-server/i.test(base)
          ? 4
          : 0) +
        (path.posix.dirname(rel).toLowerCase().includes('server') ? 3 : 0) +
        (strings.has(rel) ? 6 : strings.has(base) ? 3 : 0) +
        (isNative ? 2 : 0) -
        (rel.includes('node_modules/') ? 2 : 0);
      if (value >= 5 && value > score) {
        best = rel;
        score = value;
        native = isNative;
      }
    }
    const served = [
      ...new Set([
        ...(m.activationEvents || [])
          .filter((v) => v.startsWith('onLanguage:'))
          .map((v) => v.slice(11)),
        ...list(c.languages).map((v) => v.id),
        ...[...clientCode.matchAll(/language\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ]),
    ];
    const exts = [...new Set(served.flatMap((id) => language(id).extensions))],
      fnames = [...new Set(served.flatMap((id) => language(id).filenames))];
    if (best && (exts.length || fnames.length)) {
      const stdio =
        native ||
        (/TransportKind\.stdio/.test(clientCode) && !/TransportKind\.ipc/.test(clientCode));
      const settings = {};
      for (const cfg of list(c.configuration))
        for (const [key, v] of Object.entries(cfg.properties || {}))
          if ('default' in v) {
            let cursor = settings;
            const parts = key.split('.');
            for (const k of parts.slice(0, -1)) cursor = cursor[k] ||= Object.create(null);
            cursor[parts.at(-1)] = v.default;
          }
      const initializationOptions = {},
        paths = new Map();
      for (const match of clientCode.matchAll(
        /([\w$]+)\s*=\s*[\w$.]*asAbsolutePath\(\s*["']([^"']+)["']\s*\)/g,
      ))
        paths.set(match[1], '${extensionPath}/' + match[2].replace(/^\.\//, ''));
      for (const match of clientCode.matchAll(
        /([\w$]+)\s*:\s*[\w$.]*asAbsolutePath\(\s*["']([^"']+)["']\s*\)/g,
      ))
        initializationOptions[match[1]] = '${extensionPath}/' + match[2].replace(/^\.\//, '');
      for (const match of clientCode.matchAll(/([\w$]+)\s*:\s*([\w$]+)\s*[,}]/g))
        if (paths.has(match[2])) initializationOptions[match[1]] = paths.get(match[2]);
      contributes.languageServers = [
        {
          name: pkg.localize(m.displayName) || m.name,
          runtime: native ? 'binary' : 'node',
          transport: stdio ? 'stdio' : 'ipc',
          entry: `extension/${best}`,
          args: !native && stdio ? ['--stdio'] : [],
          languages: served,
          extensions: exts,
          filenames: fnames,
          languageIds: Object.fromEntries(
            served.flatMap((id) => language(id).extensions.map((e) => [e, id])),
          ),
          settings,
          initializationOptions,
        },
      ];
      add(
        'languageServer',
        'partial',
        best,
        'Native LSP bridge; client middleware is not translated',
      );
      if (
        !c.customEditors &&
        !c.views &&
        !/createWebviewPanel|registerWebviewViewProvider/.test(clientCode)
      ) {
        entry = '';
        runtime = '';
      }
    }
  }
  const defaults = { ...c.configurationDefaults };
  for (const cfg of list(c.configuration))
    for (const [key, value] of Object.entries(cfg.properties || {}))
      if ('default' in value) defaults[key] = value.default;
  if (entry) {
    let bytes = 0;
    for (const [rel, data] of [...pkg.files].sort((a, b) =>
      a[0] === entry ? -1 : b[0] === entry ? 1 : a[0].localeCompare(b[0]),
    )) {
      if (/\.map$|(^|\/)(test|tests|__tests__|\.github|\.vscode)\//i.test(rel)) continue;
      bytes += data.length;
      if (bytes > 96 << 20) throw fail('extension runtime exceeds 96 MiB');
      const target = `vscode/${rel}`;
      const string = Buffer.from(data).toString('utf8');
      if (!data.includes(0) && Buffer.from(string).equals(Buffer.from(data)))
        files[target] = string;
      else binary[target] = Buffer.from(data).toString('base64');
    }
    if (runtime === 'bun') {
      files['vscode/node_modules/vscode/index.js'] =
        `module.exports = globalThis.__sulfurVSCode;\n`;
      files['vscode/node_modules/vscode/package.json'] = stringify({
        name: 'vscode',
        version: '1.95.0',
        type: 'commonjs',
        main: 'index.js',
      });
    }
    contributes.commands = list(c.commands).map((cmd) => ({
      ...cmd,
      title: pkg.localize(cmd.title),
      category: pkg.localize(cmd.category),
    }));
    contributes.customEditors = list(c.customEditors).map((e) => ({
      viewType: e.viewType,
      displayName: pkg.localize(e.displayName),
      priority: e.priority,
      filenamePatterns: list(e.selector)
        .map((s) => s.filenamePattern)
        .filter(Boolean),
    }));
    contributes.views = [];
    const containers = Object.fromEntries(
      Object.values(c.viewsContainers || {})
        .flat()
        .map((v) => [v.id, pkg.localize(v.title)]),
    );
    for (const [container, views] of Object.entries(c.views || {}))
      for (const v of list(views))
        contributes.views.push({
          ...v,
          name: pkg.localize(v.name),
          container,
          containerTitle: containers[container] || container,
        });
    add(
      'code',
      'partial',
      runtime === 'bun' ? 'Node extension' : 'web build',
      runtime === 'bun'
        ? 'Runs in a separate Bun process with local filesystem and process access; VS Code API gaps are reported'
        : 'CommonJS and ES modules resolve within the package; vscode uses Sulfur’s bridge',
    );
  }
  const commands = new Set(
    Array.isArray(options.commands) ? options.commands : Object.keys(options.commands || {}),
  );
  const own = new Set(list(c.commands).map((x) => x.command));
  for (const k of list(c.keybindings))
    if (
      k.key &&
      (commands.has(k.command?.replace(/^-/, '') || '') ||
        (entry && own.has(k.command?.replace(/^-/, '') || '')))
    )
      (contributes.keybindings ||= []).push({
        command: k.command,
        key: k.key.toLowerCase(),
        ...(k.mac ? { mac: k.mac.toLowerCase() } : {}),
        ...(k.args ? { args: k.args } : {}),
        own: own.has(k.command?.replace(/^-/, '') || ''),
      });
  if (c.keybindings)
    add(
      'keybindings',
      'partial',
      'keybindings',
      'Mapped built-in and extension commands; VS Code when-clause expressions are not translated',
    );
  if (c.configuration) {
    contributes.configuration = list(c.configuration);
    add(
      'settings',
      'partial',
      'settings',
      'Defaults preserved; VS Code-specific configuration scope rules are not translated',
    );
  }
  if (languages.size) contributes.languages = [...languages.values()];
  const handled = new Set([
    'languages',
    'grammars',
    'themes',
    'iconThemes',
    'snippets',
    'keybindings',
    'configuration',
    'configurationDefaults',
    ...(entry ? ['commands', 'views', 'viewsContainers', 'customEditors'] : []),
  ]);
  for (const key of Object.keys(c))
    if (!handled.has(key))
      add(
        key,
        'skipped',
        key,
        tables.vsxUnsupported[key] || 'This contribution is not implemented by the VS Code bridge',
      );
  const sulfur = {
    declarative: !entry,
    converted: source,
    report,
    ...(entry
      ? { vscode: { root: 'vscode', id: `${source.namespace}.${source.name}`, defaults, runtime } }
      : {}),
  };
  const manifest = {
    name: id,
    displayName: pkg.localize(m.displayName) || source.name,
    version: source.version,
    description: pkg.localize(m.description),
    publisher: source.namespace,
    contributes,
    sulfur,
    ...(m.extensionDependencies ? { extensionDependencies: m.extensionDependencies } : {}),
    ...(entry ? { main: `vscode/${entry}` } : {}),
  };
  files['package.json'] = stringify(manifest);
  files['README.md'] =
    `# ${manifest.displayName}\n\nConverted from ${source.namespace}.${source.name} ${source.version}.\n\n` +
    report.map((r) => `- ${r.kind}: ${r.status} — ${r.name}. ${r.detail || ''}`).join('\n');
  return { id, manifest, files, ...(Object.keys(binary).length ? { binary } : {}), report };
}
