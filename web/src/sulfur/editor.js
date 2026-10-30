import {
  codeKey,
  codeLang,
  codeName,
  codeTabs,
  color,
  colorFor,
  dk,
  editors,
  el,
  esc,
  hostUrl,
  lines,
  name,
  shareMenu,
} from '#host';
import { syntaxRanges, errorPositions, parserFor, parserNow, syntaxErrors, syntaxCache } from '../lezer.js';
import { mdBlocks, mdRequest, renderMd } from '../md.js';
import { opApply, opTransform, opDiff, opMap, opEdits, commonEnds } from '../text-operations.js';
import { EditorHistory } from '../editor-history.js';
import { highlightRanges, rebaseHighlightRanges, rangesFromHighlight, classAt, rangeIndex } from './semantic-tokens.js';
import { quickLex, lexStateAt } from './quick-lex.js';
import { rebaseLexical, settleLexical } from './stable-highlight.js';
import { diagnosticSeverity, diagnosticCounts, diagnosticText, diagnosticsAt, offsetAtColumn, diagnosticDelay, rebaseDiagnostics } from './diagnostics.js';
import { definitionIdentifier, mountDefinitionLinks } from './definition-links.js';
import { editorDecorations } from './editor-guides.js';
import { bracketPair, enclosingPair, outdentFor } from './brackets.js';
import { toggleLineComment, toggleBlockComment, docCommentEnter, blockCommentFor } from './comments.js';
import { wordStart, wordEnd } from './completion.js';
import { textWindow } from './text-window.js';
import { contributedLang } from './vsx-contributions.js';
import { mountHoverIntent } from './hover-intent.js';
import { nextMatch, allMatches, replicateEdit, moveCursors, moveCursorsVertically, cursorBeside, cursorsAtLineEnds, normalizeCursors, rebaseCursors } from './multi-cursor.js';
import { bracketRanges, bracketStateIndex, skipSpansFromTree, skipSpansFromRanges, mergeRanges } from './bracket-colors.js';
import { stickyLines, STICKY_MAX } from './sticky-scroll.js';
import { minimapLayout, minimapRuns, minimapScrollFor } from './minimap.js';
import { lineNumberLabels } from './line-numbers.js';
import { colorLiterals, COLOR_LANGS } from './color-decorators.js';
import { linkedTagRange } from './linked-editing.js';

// --- code editor ------------------------------------------------------------------
// a share's text or code file in a tab of its own, joined to the file's live
// session on its host, so everyone with it open edits the same text: highlighted
// as it's typed (a textarea over its highlighted copy), indents kept, pairs
// closed, syntax errors marked by a parse alone, saved once typing pauses;
// nothing in it ever runs


// --- editors ---------------------------------------------------------------------

const anyCodeDirty = () => [...editors.values()].some((ed) => ed.dirty());
window.addEventListener('beforeunload', (e) => { if (anyCodeDirty()) e.preventDefault(); });

// opts.bare: no bar of its own, for a host that draws its own (the ide), told
// of every change by opts.onState. opts.markdownView(el, file): a rendered note's
// blocks, for the host's links, images and embeds; opts.pasteImage(blob, file): an
// image pasted into a note saved, resolving with the link to type in
function codeEditor(view, file, btn, id, opts = {}) {
  // a converted VS Code extension's language or grammar over the host's (vsx-contributions.js)
  let lang = contributedLang(file.path, codeLang(file.path)) || { hl: 'plaintext', check: '', comment: '' };
  const bare = !!opts.bare;
  const localOnly = typeof opts.localText === 'string';
  const bar = el('div', 'code-bar');
  const pathEl = el('span', 'code-path', file.label);
  const whoEl = el('span', 'code-who');
  const stateEl = el('span', 'code-state', 'connecting');
  const errEl = Object.assign(el('button', 'code-errs-btn'), { type: 'button', title: 'show the syntax errors', hidden: true });
  const saveBtn = Object.assign(el('button', 'code-btn', 'save'), { type: 'button', title: 'save to the share now' });
  const isMd = !localOnly && lang.hl === 'markdown';
  const viewBtn = Object.assign(el('button', 'code-btn'), { type: 'button', hidden: !isMd });
  const shareBtn = Object.assign(el('button', 'code-btn', 'share'), { type: 'button', title: 'invite someone to work on it with you' });
  bar.append(pathEl, el('span', 'code-lang', lang.hl), whoEl, errEl, stateEl, viewBtn, shareBtn, saveBtn);

  const scroller = el('div', 'code-ed');
  const gutter = el('div', 'code-gutter');
  const nums = el('pre', 'code-nums');
  gutter.append(nums);
  const body = el('div', 'code-body');
  const pre = el('pre', 'code-hl');
  const code = el('code', `hljs language-${lang.hl} code-lines`);
  pre.append(code);
  const squig = el('pre', 'code-hl code-squig');
  // a find's matches, the current one stronger, drawn as the squiggles are
  const finds = el('pre', 'code-hl code-finds');
  // an agent's edit as it lands: what it wrote lit, its caret where it's writing
  const agentL = el('pre', 'code-hl code-agent');
  for (const layer of [gutter, pre, squig, finds, agentL]) layer.setAttribute('aria-hidden', 'true');
  const ta = Object.assign(document.createElement('textarea'), { className: 'code-ta', spellcheck: false, autocomplete: 'off', wrap: 'off' });
  const inlineLayer = Object.assign(el('pre', 'code-hl code-inline'), { hidden: true });
  inlineLayer.setAttribute('aria-hidden', 'true');
  const definitionLayer = Object.assign(el('pre', 'code-hl code-definition-link'), { hidden: true });
  definitionLayer.setAttribute('aria-hidden', 'true');
  let definitionHover = null;
  const guidesLayer = el('div', 'code-guide-layer');
  guidesLayer.setAttribute('aria-hidden', 'true');
  let inlineSuggestion = null;
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', file.label);
  // under the text: the caret's line, rulers, the bracket pair and the caret's word elsewhere
  const deco = el('div', 'code-deco');
  const lineNow = el('div', 'code-line-now');
  const rulersEl = el('div', 'code-rulers');
  const decoMarks = el('pre', 'code-hl code-deco-marks');
  const decoWin = el('code');
  decoMarks.append(decoWin);
  deco.append(lineNow, rulersEl, decoMarks);
  // the caret's line number, lit over the gutter's
  const nrNow = el('div', 'code-nr-now');
  // the overview ruler over the scrollbar: problems, matches, bookmarks, the caret, the whole file at once
  const overview = el('canvas', 'code-overview');
  // the minimap beside the text, the file at a glance, and the sticky lines over its top:
  // the scopes the view is inside, held there as it scrolls away from them
  const minimap = Object.assign(el('canvas', 'code-minimap'), { hidden: true });
  const sticky = Object.assign(el('div', 'code-sticky'), { hidden: true });
  for (const layer of [deco, nrNow, overview, sticky]) layer.setAttribute('aria-hidden', 'true');
  gutter.append(nrNow);
  body.append(deco, agentL, finds, pre, guidesLayer, squig, inlineLayer, definitionLayer, ta);
  scroller.append(gutter, body);

  const out = el('div', 'code-out');
  out.hidden = true;
  const outHead = el('div', 'code-out-head');
  const outTitle = el('span', 'code-out-title');
  const outClose = Object.assign(el('button', 'code-btn', '×'), { type: 'button', title: 'hide errors' });
  outHead.append(outTitle, outClose);
  const outList = el('div', 'code-out-text');
  out.append(outHead, outList);
  // markdown rendered, each block its source again on a double click
  const mdView = Object.assign(el('div', 'code-md'), { hidden: true, tabIndex: -1 });
  mdView.dataset.notePath = file.path;
  view.append(bar, scroller, mdView, out, overview, minimap, sticky);
  const diskNotice = Object.assign(el('div', 'code-disk-notice'), { hidden: true });
  const diskMessage = el('span');
  const diskCompare = el('details');
  diskCompare.append(el('summary', '', 'Review disk version'));
  const diskText = el('pre'); diskCompare.append(diskText);
  const keepEditor = Object.assign(el('button', 'code-btn', 'Keep editor version'), { type: 'button' });
  const reloadDisk = Object.assign(el('button', 'code-btn', 'Reload disk version'), { type: 'button' });
  const diskActions = el('div', 'code-disk-actions'); diskActions.append(keepEditor, reloadDisk);
  diskNotice.append(diskMessage, diskActions, diskCompare); view.prepend(diskNotice);
  let diskRevision = 0;
  keepEditor.addEventListener('click', () => say({ type: 'resolveDisk', choice: 'keep', revision: diskRevision }));
  reloadDisk.addEventListener('click', () => say({ type: 'resolveDisk', choice: 'reload', revision: diskRevision }));
  const diagnosticHover = el('div', 'code-diagnostic-hover');
  diagnosticHover.hidden = true;
  diagnosticHover.setAttribute('role', 'tooltip');
  view.append(diagnosticHover);
  function hideDiagnosticHover() { diagnosticHover.hidden = true; }
  // the hover: the problems under the mouse at once, then what the language server says of
  // the word there (opts.hover) once the mouse rests on it, in one tooltip as VS Code's
  let hoverTimer = 0, hoverAbort = null, hoverWord = null, hoverIntent;
  function hideHover() { clearTimeout(hoverTimer); hoverTimer = 0; hoverIntent?.cancel(); hoverAbort?.abort(); hoverAbort = null; hoverWord = null; hideDiagnosticHover(); }
  let lastPlace = null;
  function placeHover(x, y, below = true) {
    lastPlace = [x, y, below];
    const bounds = diagnosticHover.getBoundingClientRect();
    diagnosticHover.style.left = `${Math.max(4, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    const top = below ? y : y - bounds.height;
    diagnosticHover.style.top = `${Math.max(4, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
  }
  function showHover(problems, extra, x, y, below) {
    if (!problems.length && !extra) { hideDiagnosticHover(); return; }
    diagnosticHover.replaceChildren();
    if (problems.length) diagnosticHover.append(el('div', 'code-hover-problems', problems.map(diagnosticText).join('\n\n')));
    const hint = problems.length && opts.quickFixHint;
    if (hint) {
      // the problem's Quick Fix, run from the tooltip with the caret put on the problem
      const b = Object.assign(el('button', 'code-hover-hint', hint), { type: 'button' });
      b.addEventListener('click', () => { const at = problems[0].from; hideHover(); ta.focus(); ta.setSelectionRange(at, at); tell(); opts.quickFix?.(); });
      diagnosticHover.append(b);
    }
    if (extra) diagnosticHover.append(extra);
    diagnosticHover.classList.toggle('code-hover-rich', !!extra);
    diagnosticHover.hidden = false;
    placeHover(x, y, below);
  }
  // markdown rendered after it's shown changes its size: placed again within the window
  const hoverResize = new ResizeObserver(() => { if (!diagnosticHover.hidden && lastPlace) placeHover(...lastPlace); });
  hoverResize.observe(diagnosticHover);
  // a place's screen point: the caret's, for a hover or signature asked from the keyboard
  function pointAt(offset) {
    const text = ta.value, g = geom();
    const line = lineAt(text, offset) - 1;
    const rect = ta.getBoundingClientRect();
    return { x: rect.left + g.left + columnOf(text, lineStarts[line], offset) * g.cw, top: rect.top + g.top + line * g.lh, bottom: rect.top + g.top + (line + 1) * g.lh };
  }
  async function hoverAt(offset, x, y, below = true) {
    const text = ta.value;
    const problems = errsText === text ? diagnosticsAt(errs, offset) : [];
    showHover(problems, null, x, y, below);
    if (!opts.hover) return;
    hoverAbort?.abort();
    const own = hoverAbort = new AbortController();
    let extra = null;
    try { extra = await opts.hover(offset, own.signal); } catch {}
    if (own.signal.aborted || closed || ta.value !== text || hoverAbort !== own) return;
    if (extra || problems.length) showHover(problems, extra, x, y, below);
  }
  function hoverLocation(event) {
    const rect = ta.getBoundingClientRect(), g = geom();
    const line = Math.floor((event.clientY - rect.top - g.top) / g.lh);
    const column = Math.floor((event.clientX - rect.left - g.left) / g.cw);
    const text = ta.value;
    lineAt(text, 0);
    const start = lineStarts[line];
    const local = start === undefined ? null : offsetAtColumn(text.slice(start, lineStarts[line + 1] ?? text.length), 0, column, g.tab);
    if (local == null) return null;
    const at = start + local, ws = wordStart(text, at), we = wordEnd(text, at);
    const hit = errsText === text ? diagnosticsAt(errs, at) : [];
    return { at, ws, we, hit, key: ws + ':' + we + ':' + hit.length };
  }
  hoverIntent = mountHoverIntent({ target: ta, tooltip: diagnosticHover, hide: hideHover,
    isAnchor: (event) => !inlineSuggestion && hoverWord !== null && hoverLocation(event)?.key === hoverWord,
    onMove(event) {
      if (inlineSuggestion || (!errs.length && !opts.hover)) { hideHover(); return; }
      const at = hoverLocation(event);
      if (!at) { hideHover(); return; }
      if (hoverWord === at.key && (!diagnosticHover.hidden || hoverTimer)) return;
      startHover(at.at, at.ws, at.we, at.hit, at.key, event.clientX + 12, event.clientY + 20);
    },
  });

  function startHover(at, ws, we, hit, key, x, y) {
    hideHover();
    if (we === ws && !hit.length) return;
    hoverWord = key;
    if (hit.length) showHover(hit, null, x, y, true);
    // the language server asked once the mouse rests, VS Code's 300ms
    if (opts.hover && we > ws) hoverTimer = setTimeout(() => { hoverTimer = 0; hoverAt(at, x, y); }, 300);
  }
  for (const event of ['blur', 'input', 'keydown']) ta.addEventListener(event, hideHover);
  scroller.addEventListener('scroll', hideHover);
  // a rich hover takes the mouse: moved into, it stays to be read, scrolled and its links
  // followed; focus stays in the text throughout
  diagnosticHover.addEventListener('mousedown', (e) => e.preventDefault());
  diagnosticHover.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (/^https?:/i.test(a.href)) (opts.openLink || ((u) => window.open(u, '_blank', 'noopener')))(a.href);
  });
  function clearDefinitionHover() {
    if (!definitionHover) return;
    definitionHover = null; definitionLayer.hidden = true; definitionLayer.replaceChildren();
    ta.classList.remove('code-definition-target');
  }
  function definitionTarget(event) {
    if (inlineSuggestion) setInlineSuggestion(null);
    const rect = ta.getBoundingClientRect(), g = geom();
    const line = Math.floor((event.clientY - rect.top - g.top) / g.lh);
    const column = Math.floor((event.clientX - rect.left - g.left) / g.cw);
    lineAt(ta.value, 0);
    const start = lineStarts[line];
    if (start === undefined) return null;
    const local = offsetAtColumn(ta.value.slice(start, lineStarts[line + 1] ?? ta.value.length), 0, column, g.tab);
    const at = local == null ? null : start + local;
    const parser = ta.value.length <= HL_MAX && parserNow(lang.check);
    return definitionIdentifier(ta.value, at, { tree: parser ? syntax.current(parser, ta.value) : null, extension: file.path.split('.').pop().toLowerCase() });
  }
  const definitionLinks = opts.definitionLinks ? mountDefinitionLinks({
    target: ta, document, window, enabled: () => ready && !closed && !view.hidden,
    locate: definitionTarget, clear: clearDefinitionHover,
    mac: /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || ''),
    show(target) {
      if (!target) { clearDefinitionHover(); return; }
      if (definitionHover?.from === target.from && definitionHover.to === target.to && definitionHover.text === ta.value) return;
      hideDiagnosticHover();
      definitionHover = { ...target, text: ta.value };
      const g = geom();
      const line = lineAt(ta.value, target.from) - 1;
      const column = columnOf(ta.value, lineStarts[line], target.from);
      const underline = el('span', '', target.name);
      underline.style.left = `${g.left + column * g.cw}px`;
      underline.style.top = `${g.top + line * g.lh}px`;
      definitionLayer.replaceChildren(underline);
      definitionLayer.hidden = false; ta.classList.add('code-definition-target');
    },
  }) : null;
  scroller.addEventListener('scroll', () => definitionLinks?.leave());
  if (bare) bar.hidden = true;

  // the session: the server's text and version, the edit in flight to it
  let S = '';
  // the file's line ending on disk, as its host said: the editor's text is always LF
  let eolMode = 'LF';
  // S made the textarea's own string object once their contents match: V8 compares strings
  // by pointer first, so every later comparison of the two (dirty, flush, a save) is then
  // immediate rather than a scan of the whole file
  const sameS = () => { const v = ta.value; if (S === v) { if (savedText === v) savedText = v; S = v; } };
  let V = 0;
  let saved = -1;
  // the text as last saved, when this tab knows it, so an undo back to it is clean
  let savedText = null;
  let perms = '';
  let ready = false;
  let inflight = null;
  let wantSave = false;
  let sock = null;
  let closed = false;
  let retry = 1000;
  let people = [];
  let bookmarks = [];
  // this tab's own id in the session, its own caret never drawn
  let me = 0;
  // someone else in the file: edits go to them as typed, the session saving them soon after.
  // Alone (a local file, a remote one no one else has open) they're held here until a save
  // asks for them, Ctrl+S, as an editor's are
  const shared = () => people.some((p) => !p.agent && (me ? p.id !== me : p.name !== name));
  // the session's text the held edits were made on, when the socket dropped with them unsent
  let heldBase = null;
  let opSeq = 0;
  const canWrite = () => perms.includes('w');
  const sameOps = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
  const say = (body) => sock && sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(body));
  const history = new EditorHistory();
  let historyText = '';
  let historyReady = false;
  let beforeSelection = [0, 0];
  let historyGroup = '';
  let agentSequence = 0;

  function historyStep(redo = false) {
    if (ta.readOnly) return false;
    const next = history.step(ta.value, [ta.selectionStart, ta.selectionEnd], redo);
    if (!next) return false;
    setCursors([], null);
    ta.value = next.text;
    historyText = ta.value;
    ta.setSelectionRange(...next.selection);
    beforeSelection = next.selection;
    redraw(); flush(); paintState(); caretInView(); sendCursor();
    return true;
  }

  // --- drawing ---
  // Only the lines on screen (and a screen above and below) are drawn: a keystroke
  // costs the same in a file of any length, as in VS Code. Every layer under the
  // textarea draws the same window, padded above and below to the full text's height.
  let drawFrame = 0;
  let hlText = null;
  let hlForce = false;
  const syntax = syntaxCache();
  let semantic = [], semanticText = null;
  // a grammar's colors kept steady across half-typed code (stable-highlight.js)
  let lexState = null, lexText = null, lexParsedText = null;
  // the server's colors for a grammar the page has no parser for, the whole text's, and
  // the span edited since they came (quick-lex.js colors those lines meanwhile)
  let lexical = [], lexicalText = null, lexicalDirty = null;
  const HL_MAX = 8 * 1024 * 1024;
  // Past this, parse after typing pauses, retaining rebased colors between.
  const HL_IDLE = 1024 * 1024;
  const SERVER_HL_MAX = 200 * 1024;
  let bigTimer = 0;
  let hlNow = false;
  // the text last drawn, and the window of it drawn
  let shownText = null;
  let drawn = { first: 0, last: 0, from: 0, to: 0, lines: 1, lh: 18 };
  let wantCaret = false, wantCenter = false;
  // what changed between two texts, worked out once for every layer that moves with it
  let lastChange = null;
  const changeOf = (before, after) => {
    if (lastChange?.before === before && lastChange.after === after) return lastChange.change;
    const change = commonEnds(before, after);
    lastChange = { before, after, change };
    return change;
  };
  const numsWin = el('div'), squigWin = el('code'), findsWin = el('code'), agentWin = el('code');
  nums.append(numsWin); squig.append(squigWin); finds.append(findsWin); agentL.append(agentWin);
  // the widest line in columns, so the body is as wide as the text without drawing it all
  let maxCols = 0, widthTab = 0;
  function widest(text, from, to, tabSize) {
    let most = 0, column = 0;
    for (let i = from; i < to; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) { most = Math.max(most, column); column = 0; } else if (c === 9) column += tabSize - column % tabSize;
      // wide and astral characters counted double, never narrower than drawn
      else column += c < 0x1100 ? 1 : 2;
    }
    return Math.max(most, column);
  }
  function measureWidth(before, after) {
    const tabSize = geom().tab;
    if (before === null || tabSize !== widthTab) { widthTab = tabSize; maxCols = widest(after, 0, after.length, tabSize); return; }
    const { head, tail } = changeOf(before, after);
    const lineFrom = (t) => t.lastIndexOf('\n', head - 1) + 1;
    const lineTo = (t, p) => { const e = t.indexOf('\n', p); return e < 0 ? t.length : e; };
    const was = widest(before, lineFrom(before), lineTo(before, before.length - tail), tabSize);
    const now = widest(after, lineFrom(after), lineTo(after, after.length - tail), tabSize);
    if (now >= maxCols) maxCols = now;
    else if (was >= maxCols) maxCols = widest(after, 0, after.length, tabSize);
  }
  // what's kept for the text last drawn moved onto the text now
  function textChanged(before, text) {
    shownText = text;
    measureWidth(before, text);
    if (before === null) return;
    const change = changeOf(before, text);
    lastTextChange = Date.now();
    hideDiagnosticHover();
    const moved = { head: change.head, tail: change.tail, before: before.length };
    if (cursors.length && cursorsText !== text) setCursors(rebaseCursors(cursors, cursorsText, text, cursorsText === before ? change : undefined), text);
    if (errsText === before) { errs = rebaseDiagnostics(errs, moved, text.length - before.length); errsText = text; }
    if (languageErrors && languageErrorsText === before) { languageErrors = rebaseDiagnostics(languageErrors, moved, text.length - before.length); languageErrorsText = text; }
  }
  function syncColors(text) {
    if (semanticText !== text) { if (semanticText !== null) semantic = rebaseHighlightRanges(semanticText, text, semantic, changeOf(semanticText, text)); semanticText = text; }
    if (lexicalText !== text) {
      if (lexicalText !== null) {
        const { head, tail } = changeOf(lexicalText, text), endA = lexicalText.length - tail, delta = text.length - lexicalText.length;
        lexical = rebaseHighlightRanges(lexicalText, text, lexical, { head, tail });
        const at = (p) => p < head ? p : p >= endA ? p + delta : head;
        lexicalDirty = { from: Math.min(head, lexicalDirty ? at(lexicalDirty.from) : head), to: Math.max(text.length - tail, lexicalDirty ? (lexicalDirty.to >= endA ? lexicalDirty.to + delta : text.length - tail) : 0) };
      }
      lexicalText = text;
    }
    if (lexText !== text) { if (lexText !== null) lexState = rebaseLexical(lexState, lexText, text, changeOf(lexText, text)); lexText = text; }
  }
  // The scroller's metrics as last laid out, kept from its own scroll and resize events:
  // drawing a keystroke then never forces a layout of its own, which in a long file costs
  // as much as the textarea's whole text (the one layout per frame the browser does anyway)
  const metrics = { top: 0, left: 0, height: 0, width: 0, gutter: 0 };
  // The text's geometry: line height, advance, paddings, tab size. Read from computed style
  // once and kept until the font, a setting or the size changes (show(), a resize, fonts
  // loading), since a style read after the frame's edits forces a style recalculation.
  let geomCache = null, geomEpoch = -1;
  function geom() {
    if (geomCache && geomEpoch === fontEpoch) return geomCache;
    const cs = getComputedStyle(ta);
    // not kept until the editor's in the page: a detached one's style is empty
    geomEpoch = ta.isConnected ? fontEpoch : -1;
    return (geomCache = {
      // the top padding the highlight layer's: the textarea's own also carries its window's offset
      lh: lineHeightIn(ta), cw: chWidthIn(ta), top: parseFloat(getComputedStyle(pre).paddingTop) || 0, left: parseFloat(cs.paddingLeft) || 0,
      tab: parseInt(cs.tabSize, 10) || 4, font: cs.font || `${cs.fontSize} ${cs.fontFamily}`,
      preTop: parseFloat(getComputedStyle(pre).paddingTop) || 0, numsTop: parseFloat(getComputedStyle(nums).paddingTop) || 0,
    });
  }
  const regeom = () => { geomCache = null; placeWindowTa(); };
  // the place kept while the editor is hidden: a hidden scroller can't scroll, and the browser
  // forgets its offset, so it's put back once the editor shows again
  let hiddenScroll = null;
  // what the scroller took is kept, not what was asked: an offset past the end, or set while
  // hidden, would leave the drawn window somewhere the view isn't (lines missing)
  const scrollTo = (top, left = metrics.left) => {
    if (!scroller.clientHeight) { hiddenScroll = { top: Math.max(0, top), left: Math.max(0, left) }; return; }
    // shown again and scrolled before its size was read (a jump into a tab just activated): the
    // place kept while hidden gives way, or it would put the view back there a frame later
    hiddenScroll = null;
    if (!metrics.height) { metrics.height = scroller.clientHeight; metrics.width = scroller.clientWidth; }
    if (top !== metrics.top) { scroller.scrollTop = Math.max(0, top); metrics.top = scroller.scrollTop; }
    if (left !== metrics.left) { scroller.scrollLeft = Math.max(0, left); metrics.left = scroller.scrollLeft; }
  };
  // (the textarea's window follows the view in the scroll itself, not a frame later: a press
  // on the lines now on screen must find them there, and an engine may hold its frames back)
  scroller.addEventListener('scroll', () => { if (!scroller.clientHeight) return; metrics.top = scroller.scrollTop; metrics.left = scroller.scrollLeft; tw?.check(); }, { passive: true });
  // the lines to draw: those on screen and as many again above and below
  function viewWindow(text) {
    lineAt(text, 0);
    const n = lineStarts.length, lh = geom().lh;
    const top = metrics.top - geom().preTop;
    const height = metrics.height || 900;
    const margin = Math.max(40, Math.ceil(height / lh));
    const first = Math.max(0, Math.min(n - 1, Math.floor(top / lh) - margin));
    const last = Math.max(first + 1, Math.min(n, Math.ceil((top + height) / lh) + margin));
    return { first, last, from: lineStarts[first], to: last < n ? lineStarts[last] - 1 : text.length, lines: n, lh };
  }
  // a layer's window placed: as tall and wide as the whole text, its lines where they lie
  function placeWindow(node, w) {
    const top = `${w.first * w.lh}px`, bottom = `${(w.lines - w.last) * w.lh}px`, width = `${maxCols + 2}ch`;
    if (node.style.paddingTop !== top) node.style.paddingTop = top;
    if (node.style.paddingBottom !== bottom) node.style.paddingBottom = bottom;
    if (node.style.minWidth !== width) node.style.minWidth = width;
    if (node === code) { const lh = `${w.lh}px`; if (node.style.getPropertyValue('--code-line') !== lh) node.style.setProperty('--code-line', lh); }
  }
  // the window's text with marks over some ranges (sorted); wrap(raw) gives a mark's html
  function markedHtml(text, marks, w) {
    let html = '', at = w.from;
    for (const m of marks) {
      if (m.to < w.from || m.from > w.to) continue;
      const a = Math.max(m.from, w.from), b = Math.min(m.to, w.to);
      if (a < at) continue;
      html += esc(text.slice(at, a)) + m.wrap(text.slice(a, b));
      at = b;
    }
    return `${html}${esc(text.slice(at, w.to))}\n`;
  }
  function paintText() {
    const text = ta.value;
    syncColors(text);
    const w = drawn = viewWindow(text);
    const parser = text.length <= HL_MAX && parserNow(lang.check);
    let colors = lexical;
    if (parser) {
      // a big file parsed once typing pauses, its colors moved with the edits meanwhile
      if (text.length > HL_IDLE && lexParsedText !== null && lexParsedText !== text && !hlNow) {
        clearTimeout(bigTimer);
        bigTimer = setTimeout(() => { if (closed || ta.value !== text) return; hlNow = true; paintText(); hlNow = false; }, 400);
      } else {
        // parsed as far as the screen at once, the rest in slices while the page is idle: a
        // long file opens colored without waiting for its whole parse
        const { tree, complete } = syntax.parseTo(parser, text, w.to + 4096, 3);
        if (!complete) parseRest();
        lexState = settleLexical(lexState, syntaxRanges(parser, text, tree, w.from, w.to), errorPositions(tree, w.from, w.to, parser, text), w.from, w.to, text);
        lexParsedText = text;
      }
      colors = lexState?.ranges || [];
    } else if (text.length <= HL_MAX) {
      if (lang.check) parserFor(lang.check).then((p) => {
        if (closed || ta.value !== text) return;
        if (p) redraw(true);
        else if (lang.hl !== 'plaintext' && text.length <= SERVER_HL_MAX) serverHighlight(text);
      });
      else if (lang.grammar) grammarHighlight(text);
      else if (lang.hl !== 'plaintext' && text.length <= SERVER_HL_MAX) serverHighlight(text);
      if (lexicalDirty && lang.hl !== 'plaintext' && lang.hl !== 'markdown') colors = quickColors(text, w);
    }
    paintLines(text, bracketTokens(text, colors, w, parser), w);
    placeWindow(code, w);
    paintNums(w);
    hlText = text;
    paintSquiggles(); paintFinds(); paintAgent();
    if (inlineSuggestion) paintInline();
    minimapSoon(); stickySoon();
  }
  // the gutter's numbers for the window: absolute, relative to the caret's line, every tenth
  // or none (editor.lineNumbers), drawn again only when what they'd show changed
  function paintNums(w = drawn) {
    const mode = (opts.display?.() || {}).lineNumbers || 'on';
    const caretLine = mode === 'on' || mode === 'off' ? -1 : lineAt(ta.value, headOf(selNow())) - 1;
    const numsKey = `${w.first}|${w.last}|${w.lines}|${w.lh}|${mode}|${caretLine}`;
    if (numsKey === numsDrawn) return;
    numsDrawn = numsKey;
    numsWin.textContent = lineNumberLabels(w.first, w.last, caretLine, mode);
    numsWin.style.paddingTop = `${w.first * w.lh}px`; numsWin.style.paddingBottom = `${(w.lines - w.last) * w.lh}px`;
    numsWin.style.minWidth = mode === 'off' ? '0' : `${String(w.lines).length}ch`;
  }
  // --- bracket pairs colored by their nesting (bracket-colors.js), the window's brackets laid
  // over the semantic tokens; the openers still open where the window begins kept by an index
  // so a keystroke scans from its nearest mark, never from the top of the file ---
  const bracketIndex = bracketStateIndex();
  function bracketTokens(text, colors, w, parser) {
    const display = opts.display?.() || {};
    if (display.bracketPairColorization === false || lang.hl === 'plaintext' || lang.hl === 'markdown' || text.length > HL_MAX) return semantic;
    // strings and comments looked past: the tree's when it's for this text, else the colors'
    const treeFor = parser && lexParsedText === text ? (to) => syntax.parseTo(parser, text, to, 0).tree : null;
    const skipFor = treeFor ? (a, b) => skipSpansFromTree(treeFor(b), a, b) : (a, b) => skipSpansFromRanges(colors, a, b);
    const was = bracketIndex.text();
    const stack = bracketIndex.stateAt(text, w.from, skipFor, was !== null && was !== text ? changeOf(was, text) : null);
    const brackets = bracketRanges(text, w.from, w.to, stack, skipFor(w.from, w.to));
    if (!brackets.length) return semantic;
    return mergeRanges(semantic.slice(rangeIndex(semantic, w.from), rangeIndex(semantic, w.to) + 1), brackets);
  }
  // the parse finished a slice at a time, the page answering between: then the brackets and
  // the syntax check, which need the whole tree, see it
  let restTimer = 0;
  // the whole tree for text, its parse finished a slice at a time rather than in one long
  // task; null once the text has moved on
  async function wholeTree(parser, text) {
    for (let n = 0; !closed && ta.value === text && !syntax.current(parser, text) && n < 100000; n++) {
      syntax.parseTo(parser, text, 0, 8);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return !closed && ta.value === text ? syntax.current(parser, text) : null;
  }
  function parseRest() {
    if (restTimer) return;
    const slice = () => {
      restTimer = 0;
      const text = ta.value, parser = !closed && text.length <= HL_MAX && parserNow(lang.check);
      if (!parser) return;
      if (!syntax.parseTo(parser, text, 0, 8).complete) restTimer = setTimeout(slice, 0);
      else { decoSoon(); minimapSoon(); stickySoon(); }
    };
    restTimer = setTimeout(slice, 0);
  }
  // The highlighted text a block per line, each drawn again only when its own html changed:
  // a keystroke redraws its line, not the screen (as VS Code's view lines). Lines are matched
  // to those drawn before through the edit between: above it the same line, below it moved by
  // the lines it added or took away.
  let lineNodes = [], linesFirst = 0, linesText = null, linesCount = 0, numsDrawn = '';
  function paintLines(text, colors, w) {
    lineAt(text, 0);
    let headLine = Infinity, endLine = -1, delta = 0;
    if (linesText !== null && linesText !== text) {
      const { head, tail } = changeOf(linesText, text);
      headLine = lineAt(text, head) - 1;
      endLine = lineAt(text, text.length - tail) - 1;
      delta = lineStarts.length - linesCount;
    }
    const old = new Map();
    for (let i = 0; i < lineNodes.length; i++) old.set(linesFirst + i, lineNodes[i]);
    const next = [], spare = [];
    for (let l = w.first; l < w.last; l++) {
      const a = lineStarts[l], b = l + 1 < lineStarts.length ? lineStarts[l + 1] - 1 : text.length;
      const html = highlightRanges(text, colors, semantic, a, b);
      const was = l < headLine ? l : l > endLine ? l - delta : -1;
      let node = was >= 0 ? old.get(was) : null;
      if (node) old.delete(was);
      if (node && node.lineHtml !== html) { node.innerHTML = html; node.lineHtml = html; }
      next.push(node || { html });
    }
    for (const node of old.values()) spare.push(node);
    // the lines not kept: the nodes left over made them, else new ones
    for (let i = 0; i < next.length; i++) {
      if (next[i].nodeType) continue;
      const node = spare.pop() || document.createElement('div');
      if (node.lineHtml !== next[i].html) { node.innerHTML = next[i].html; node.lineHtml = next[i].html; }
      next[i] = node;
    }
    for (const node of spare) node.remove();
    // into the layer in order, moving only what's out of place
    let at = code.firstChild;
    for (const node of next) {
      if (node === at) { at = at.nextSibling; continue; }
      code.insertBefore(node, at);
    }
    while (at) { const after = at.nextSibling; at.remove(); at = after; }
    lineNodes = next; linesFirst = w.first; linesText = text; linesCount = lineStarts.length;
  }
  // the lines edited since the server's colors came, lexed here, the rest as it colored them
  function quickColors(text, w) {
    lineAt(text, 0);
    const a = Math.max(w.from, lineStarts[lineAt(text, lexicalDirty.from) - 1]);
    const endLine = lineAt(text, Math.min(lexicalDirty.to, text.length));
    const b = Math.min(w.to, endLine < lineStarts.length ? lineStarts[endLine] : text.length);
    if (b <= a) return lexical;
    const before = rangeIndex(lexical, a), after = rangeIndex(lexical, b);
    const head = lexical.slice(rangeIndex(lexical, w.from), before);
    if (lexical[before]?.from < a) head.push({ ...lexical[before], to: a });
    const tail = lexical.slice(after, rangeIndex(lexical, w.to) + 1).map((r) => r.from < b ? { ...r, from: b } : r).filter((r) => r.to > r.from);
    return [...head, ...quickLex(text, a, b, { lang: lang.hl, comment: lang.comment, state: lexStateAt(lexical, before, a) }), ...tail];
  }
  // the class drawn at an offset, for completion to stay out of comments and strings
  function tokenClass(offset) {
    const text = ta.value;
    syncColors(text);
    const line = { from: text.lastIndexOf('\n', offset - 1) + 1, to: Math.min(text.length, offset + 1) };
    const lexicalClass = classAt(parserNow(lang.check) ? lexState?.ranges || [] : lexicalDirty ? quickColors(text, line) : lexical, offset);
    return /hljs-(comment|string|regexp)/.test(lexicalClass) ? lexicalClass : classAt(semantic, offset) || lexicalClass;
  }
  // scrolled past what's drawn: the new lines drawn on the next frame
  let viewFrame = 0;
  scroller.addEventListener('scroll', () => {
    if (viewFrame || hlText === null) return;
    viewFrame = requestAnimationFrame(() => {
      viewFrame = 0;
      if (closed || view.hidden) return;
      if (ta.value !== hlText) { redraw(); return; }
      // the lines on screen, and half a screen beyond, must lie inside what's drawn
      const g = geom(), top = metrics.top - g.preTop;
      const first = Math.floor(top / g.lh), last = Math.ceil((top + metrics.height) / g.lh);
      const ahead = Math.max(10, (last - first) >> 1);
      if ((drawn.first > 0 && first - ahead < drawn.first) || (drawn.last < drawn.lines && last + ahead > drawn.last)) { paintText(); paintMarks(); paintDeco(); }
      minimapSoon(); stickySoon();
    });
  }, { passive: true });
  let guideFrame = 0, guideSnapshot = null;
  function paintGuides() {
    guideFrame = 0;
    if (closed || !ready || view.hidden) return;
    const options = opts.display?.() || {};
    const text = ta.value, g = geom();
    const lh = g.lh, cw = g.cw, x = g.left, y = g.top;
    const first = Math.max(0, Math.floor((metrics.top - y) / lh) - 1), last = Math.ceil((metrics.top + metrics.height - y) / lh) + 1;
    const left = Math.max(0, Math.floor((metrics.left - x) / cw) - 1), right = left + Math.ceil(metrics.width / cw) + 2;
    const tabSize = g.tab, indent = unit(), indentSize = indent === '\t' ? tabSize : indent.length;
    const key = JSON.stringify([first, last, left, right, tabSize, indentSize, cw, lh, x, y, options]);
    if (guideSnapshot?.text === text && guideSnapshot.key === key) return;
    guideSnapshot = { text, key };
    if (!options.indentationGuides && (!options.whitespace || options.whitespace === 'none') || inlineSuggestion?.insert.includes('\n')) { guidesLayer.replaceChildren(); return; }
    lineAt(text, 0);
    const decorations = editorDecorations(text, lineStarts, { first, last, left, right, tabSize, whitespace: options.whitespace || 'none', guides: options.indentationGuides });
    setStyle(guidesLayer, 'font', g.font);
    // a row kept for each kind of row drawn (its guides and marks), moved to its line: a
    // keystroke or a scroll moves rows rather than making them again
    const spare = new Map();
    for (const row of guidesLayer.children) { const list = spare.get(row.guideKey) || []; list.push(row); spare.set(row.guideKey, list); }
    const rows = decorations.map((item) => {
      const key = `${options.indentationGuides ? item.indent : 0}|${item.markers.map((m) => `${m.column}${m.text}`).join(',')}|${indentSize}|${cw}|${lh}|${x}`;
      let row = spare.get(key)?.pop();
      if (!row) {
        row = el('div', 'code-guide-row');
        row.guideKey = key;
        row.style.left = `${x}px`; row.style.height = `${lh}px`;
        if (options.indentationGuides && item.indent) {
          const guides = el('span', 'code-indent-guides');
          guides.style.width = `${item.indent * cw}px`; guides.style.backgroundSize = `${indentSize * cw}px 100%`; row.append(guides);
        }
        for (const marker of item.markers) {
          const mark = el('span', 'code-whitespace-mark', marker.text); mark.style.left = `${marker.column * cw}px`; row.append(mark);
        }
      }
      setStyle(row, 'top', `${y + item.line * lh}px`);
      return row;
    });
    for (const list of spare.values()) for (const row of list) row.remove();
    for (const row of rows) if (row.parentNode !== guidesLayer) guidesLayer.append(row);
  }
  const guidesSoon = () => { guideFrame ||= requestAnimationFrame(paintGuides); };
  scroller.addEventListener('scroll', guidesSoon, { passive: true });
  // a taller pane shows more lines: the window drawn again for it
  // read after layout, before paint: free, unlike a read in the middle of drawing
  const guideResize = new ResizeObserver(() => {
    regeom();
    // hidden (its tab switched away): where it was kept, the rest left for when it shows
    if (!scroller.clientHeight) { hiddenScroll ||= { top: metrics.top, left: metrics.left }; metrics.height = 0; return; }
    if (hiddenScroll) {
      scroller.scrollTop = hiddenScroll.top; scroller.scrollLeft = hiddenScroll.left;
      hiddenScroll = null;
    }
    const taller = scroller.clientHeight > metrics.height;
    Object.assign(metrics, { top: scroller.scrollTop, left: scroller.scrollLeft, height: scroller.clientHeight, width: scroller.clientWidth, gutter: gutter.offsetWidth });
    guidesSoon(); minimapSoon(); stickySoon();
    if (hlText !== null && taller) redraw(true);
  });
  guideResize.observe(scroller); guideResize.observe(gutter);
  let lastTextChange = 0;
  function paintInline() {
    const s = inlineSuggestion;
    if (!s || s.text !== ta.value || s.caret !== ta.selectionStart || s.caret !== ta.selectionEnd || ta.readOnly || s.caret < drawn.from || s.caret > drawn.to) {
      inlineSuggestion = null;
      inlineLayer.hidden = true;
      inlineLayer.replaceChildren();
      gutter.querySelector('.code-inline-nums')?.remove();
      body.classList.remove('code-has-inline');
      nums.style.visibility = '';
      return;
    }
    // Clone the drawn syntax spans and insert ghost text with DOM text APIs.
    // It can contain arbitrary source, including HTML, without becoming markup.
    const copy = code.cloneNode(true);
    // the caret's line among the drawn line blocks, its text walked to the caret
    const lineIndex = lineAt(s.text, s.caret) - 1;
    const block = copy.children[lineIndex - drawn.first] || copy.lastElementChild || copy;
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let at = lineStarts[lineIndex] ?? drawn.from, found = false;
    const ghost = el('span', 'code-inline-text', s.insert);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      if (s.caret <= at + node.length) {
        const range = document.createRange();
        range.setStart(node, s.caret - at); range.collapse(true); range.insertNode(ghost);
        found = true; break;
      }
      at += node.length;
    }
    if (!found) block.append(ghost);
    // a suggestion of several lines: its line block as tall as they are
    if (s.insert.includes('\n') && block !== copy) block.style.height = 'auto';
    inlineLayer.replaceChildren(copy);
    inlineLayer.hidden = false;
    body.classList.add('code-has-inline');
    // Keep line numbers aligned when a preview inserts virtual lines.
    const line = lineAt(s.text, s.caret);
    const virtual = s.insert.split('\n').length - 1;
    gutter.querySelector('.code-inline-nums')?.remove();
    if (virtual) {
      const numberCopy = el('pre', 'code-nums code-inline-nums');
      const numbers = el('div');
      numbers.textContent = Array.from({ length: drawn.last - drawn.first }, (_, i) => String(drawn.first + i + 1) + (drawn.first + i + 1 === line ? '\n'.repeat(virtual) : '')).join('\n');
      Object.assign(numbers.style, { paddingTop: numsWin.style.paddingTop, paddingBottom: numsWin.style.paddingBottom, minWidth: numsWin.style.minWidth });
      numberCopy.append(numbers);
      gutter.append(numberCopy); nums.style.visibility = 'hidden';
    } else nums.style.visibility = '';
  }
  // the selection read once a frame, before the frame's writes, so the layers drawn after it
  // don't each force a layout of the textarea to read it again
  let frameSel = null, decoStamp = -1;
  const selNow = () => frameSel || [ta.selectionStart, ta.selectionEnd, ta.selectionDirection];
  // the caret: the selection's active end, its start when it was made backward (Shift+Up)
  const headOf = (sel) => (sel[2] === 'backward' ? sel[0] : sel[1]);
  function draw(stamp) {
    drawFrame = 0;
    if (closed) return;
    frameSel = [ta.selectionStart, ta.selectionEnd, ta.selectionDirection];
    decoStamp = stamp;
    try { drawFrame0(); } finally { frameSel = null; }
  }
  function drawFrame0() {
    const text = ta.value;
    if (definitionHover && definitionHover.text !== text) clearDefinitionHover();
    const changed = text !== shownText;
    if (changed) textChanged(shownText, text);
    if (inlineSuggestion && inlineSuggestion.text !== text) setInlineSuggestion(null);
    if (changed || hlForce || hlText !== text) paintText();
    hlForce = false;
    paintMarks();
    paintDeco();
    guidesSoon();
    if (changed) checkSoon();
    if (wantCaret) { wantCaret = false; caretInView(wantCenter); wantCenter = false; }
  }
  function setInlineSuggestion(value) {
    inlineSuggestion = value;
    if (!value) { inlineLayer.replaceChildren(); gutter.querySelector('.code-inline-nums')?.remove(); }
    paintInline();
    guideSnapshot = null; guidesSoon();
  }
  // force: drawn again though the text's the same (new colors, a resize, a tab shown)
  const redraw = (force = false) => { hlForce ||= force; drawFrame ||= requestAnimationFrame(draw); mdSoon(); };

  // --- decorations: the caret's line and number, rulers, the bracket pair, the caret's word ---
  // whether an offset is code, not a string or comment: the parse when there is one, else
  // the drawn colors
  function isCode(text) {
    const parser = text.length <= HL_MAX && parserNow(lang.check);
    // a long file is parsed once typing pauses (HL_IDLE): its tree used only when it's current
    const tree = parser && syntax.current(parser, text);
    if (tree) return (i) => !/String|Comment|Regex|Template|Char/.test(tree.resolveInner(i, 1).name);
    return (i) => !/hljs-(comment|string|regexp)/.test(tokenClass(i));
  }
  // the caret's word (or a short selection) found through the file once the caret rests
  let occurrences = null, occurrenceTimer = 0;
  const OCCURRENCE_MAX = 2000;
  function findOccurrences() {
    occurrenceTimer = 0;
    if (closed || !ready) return;
    const text = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const display = opts.display?.() || {};
    let needle = '', whole = false;
    if (s === e && display.occurrencesHighlight !== false) {
      const ws = wordStart(text, s), we = wordEnd(text, s);
      if (we > ws && !/^\d/.test(text.slice(ws, we))) { needle = text.slice(ws, we); whole = true; }
    } else if (s !== e && display.selectionHighlight !== false && e - s <= 200) {
      const sel = text.slice(s, e);
      if (!sel.includes('\n') && sel.trim()) needle = sel;
    }
    const ranges = [];
    if (needle && text.length <= HL_MAX) {
      for (let i = text.indexOf(needle); i >= 0 && ranges.length < OCCURRENCE_MAX; i = text.indexOf(needle, i + 1)) {
        // a whole word only: no word character either side
        if (whole && (wordStart(text, i) !== i || wordEnd(text, i + needle.length) !== i + needle.length)) continue;
        // the selection itself left plain, as VS Code leaves it
        if (!whole && i === s) continue;
        ranges.push([i, i + needle.length]);
      }
    }
    // a lone word marks nothing
    occurrences = { text, s, e, ranges: whole && ranges.length < 2 ? [] : ranges };
    paintDeco();
  }
  let decoFrame = 0, rulersKey = '';
  const set = (node, key, value) => { if (node[key] !== value) node[key] = value; };
  const setStyle = (node, key, value) => { if (node.style[key] !== value) node.style[key] = value; };
  const decoSoon = () => { decoFrame ||= requestAnimationFrame(() => { decoFrame = 0; paintDeco(); }); };
  function paintDeco() {
    if (closed || view.hidden) return;
    const sel = selNow(), [s, e] = sel;
    const text = ta.value;
    const display = opts.display?.() || {};
    const g = geom();
    const line = lineAt(text, headOf(sel)) - 1;
    const highlight = display.lineHighlight ?? 'line';
    // each written only when it changes: a write of the same value still costs an engine
    // (WebKit) a repaint of the whole screen under it
    set(lineNow, 'hidden', !ready || highlight === 'none' || highlight === 'gutter' || s !== e);
    setStyle(lineNow, 'top', `${g.top + line * g.lh}px`); setStyle(lineNow, 'height', `${g.lh}px`);
    set(nrNow, 'hidden', !ready || highlight === 'none');
    set(nrNow, 'textContent', String(line + 1));
    setStyle(nrNow, 'top', `${g.numsTop + line * g.lh}px`); setStyle(nrNow, 'height', `${g.lh}px`); setStyle(nrNow, 'lineHeight', `${g.lh}px`);
    const rulers = Array.isArray(display.rulers) ? display.rulers.filter((n) => Number.isFinite(n) && n > 0) : [];
    const key = `${rulers}|${g.left}|${g.cw}`;
    if (key !== rulersKey) {
      rulersKey = key;
      rulersEl.replaceChildren(...rulers.map((n) => { const r = el('div'); r.style.left = `${g.left + n * g.cw}px`; return r; }));
    }
    const marks = [];
    if (ready && s === e && display.matchBrackets !== false && text.length <= HL_MAX) {
      const pair = bracketPair(text, s, isCode(text));
      if (pair) for (const at of [pair.open, pair.close]) marks.push({ from: at, to: at + 1, wrap: (raw) => `<mark class="bracket">${esc(raw)}</mark>` });
    }
    const occ = occurrences;
    if (occ && occ.text === text && occ.s === s && occ.e === e) {
      for (const [from, to] of occ.ranges) if (to >= drawn.from && from <= drawn.to) marks.push({ from, to, wrap: (raw) => `<mark class="word">${esc(raw)}</mark>` });
    } else {
      clearTimeout(occurrenceTimer);
      if (ready) occurrenceTimer = setTimeout(findOccurrences, 250);
    }
    // the other cursors (multi-cursor.js): each selection lit, a caret at each active end
    if (cursors.length && cursorsText === text) {
      const focused = document.activeElement === ta;
      for (const c of cursors) {
        if (c.linked) { if (c.to >= drawn.from && c.from <= drawn.to && c.to > c.from) marks.push({ from: c.from, to: c.to, wrap: (raw) => `<mark class="linked">${esc(raw)}</mark>` }); continue; }
        const a = Math.min(c.anchor, c.head), b = Math.max(c.anchor, c.head);
        if (b < drawn.from || a > drawn.to) continue;
        if (b > a) marks.push({ from: a, to: b, wrap: (raw) => `<mark class="sel">${esc(raw)}</mark>` });
        if (focused && !ta.readOnly) marks.push({ from: c.head, to: c.head, wrap: () => '<span class="code-extra-caret"></span>' });
      }
    }
    // a stylesheet's colors shown under themselves (color-decorators.js)
    if (display.colorDecorators !== false && COLOR_LANGS.has(lang.hl) && text.length <= HL_MAX) {
      if (colorsAt?.text !== text || colorsAt.from !== drawn.from || colorsAt.to !== drawn.to) colorsAt = { text, from: drawn.from, to: drawn.to, list: colorLiterals(text, drawn.from, drawn.to, isCode(text)) };
      for (const { from, to, color } of colorsAt.list) marks.push({ from, to, wrap: (raw) => `<mark class="swatch" style="--swatch:${color.replace(/["'<>&]/g, '')}">${esc(raw)}</mark>` });
    }
    if (numsDrawn && !/\|(on|off)\|/.test(numsDrawn)) paintNums();
    // a selection the textarea doesn't hold (text-window.js), drawn here instead, over the rest
    if (tw?.away() && s !== e) { for (let i = marks.length - 1; i >= 0; i--) if (marks[i].to > s && marks[i].from < e) marks.splice(i, 1); marks.push({ from: s, to: e, wrap: (raw) => `<mark class="sel">${esc(raw)}</mark>` }); }
    // zero-width marks (the carets) before any mark starting where they stand
    marks.sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from));
    if (marks.length) { decoWin.innerHTML = markedHtml(text, marks, drawn); placeWindow(decoWin, drawn); } else if (decoWin.firstChild) decoWin.textContent = '';
    overviewSoon();
  }
  let colorsAt = null;

  // --- the overview ruler: the whole file's problems, matches, bookmarks and caret at a glance ---
  let overviewFrame = 0, overviewColors = null, overviewEpoch = -1;
  const overviewSoon = () => { overviewFrame ||= requestAnimationFrame(paintOverview); };
  function paintOverview() {
    overviewFrame = 0;
    if (closed || view.hidden || !ready || (opts.display?.() || {}).overviewRuler === false) { overview.hidden = true; return; }
    const h = metrics.height, w = 10, dpr = window.devicePixelRatio || 1;
    if (!h) return;
    overview.hidden = false;
    overview.style.top = `${scroller.offsetTop}px`;
    overview.style.height = `${h}px`;
    if (overview.width !== w * dpr || overview.height !== Math.round(h * dpr)) { overview.width = w * dpr; overview.height = Math.round(h * dpr); }
    if (!overviewColors || overviewEpoch !== fontEpoch) {
      const cs = getComputedStyle(view);
      const v = (name, fall) => cs.getPropertyValue(name).trim() || fall;
      overviewColors = { err: v('--ide-err', '#f14c4c'), warn: v('--ide-warn', '#cca700'), info: v('--ide-info', '#3794ff'), find: v('--ide-find-now', '#d18616'), mark: v('--ide-accent', '#3794ff'), word: v('--ide-word-hl-ruler', v('--ide-muted', '#888')), caret: v('--ide-caret', '#ccc') };
      overviewEpoch = fontEpoch;
    }
    const c = overview.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const text = ta.value, g = geom();
    lineAt(text, 0);
    const total = lineStarts.length * g.lh + h / 2;
    const y = (offset) => Math.min(h - 2, (lineAt(text, Math.min(offset, text.length)) - 1) * g.lh / total * h);
    const bar = (offset, color, x, width, height = 2) => { c.fillStyle = color; c.fillRect(x, Math.round(y(offset)), width, height); };
    const occ = occurrences;
    if (occ && occ.text === text) for (const [from] of occ.ranges) bar(from, overviewColors.word, 3, 4);
    if (findRanges.length) for (const [from] of findRanges.slice(0, 5000)) bar(from, overviewColors.find, 3, 4);
    for (const at of bookmarks) bar(at, overviewColors.mark, 0, 3, 3);
    if (errsText === text) for (const x of errs) bar(x.from, x.severity === 2 ? overviewColors.warn : x.severity > 2 ? overviewColors.info : overviewColors.err, 6, 4, 3);
    c.globalAlpha = 0.7;
    bar(headOf(selNow()), overviewColors.caret, 0, w, 1);
    c.globalAlpha = 1;
  }

  // --- the minimap (minimap.js): the file's lines drawn tiny on a canvas beside the text, a
  // slider over the part on screen, clicked or dragged to scroll; a long file slides through ---
  const MINIMAP_W = 90, MINIMAP_ROW = 2;
  let minimapFrame = 0, minimapColors = new Map(), minimapRows = null, minimapDrag = null, minimapLast = null;
  const minimapSoon = () => { minimapFrame ||= requestAnimationFrame(paintMinimap); };
  // a token class's color as the stylesheet draws it in the text, read once per theme
  function minimapColor(cls) {
    if (minimapColors.has(cls)) return minimapColors.get(cls);
    const probe = Object.assign(document.createElement('span'), { className: cls });
    probe.style.display = 'none';
    pre.append(probe);
    const color = getComputedStyle(probe).color || '#888';
    probe.remove();
    minimapColors.set(cls, color);
    return color;
  }
  // the colors for lines first..last of text: the whole tree's when it's parsed, else what the
  // window has; a grammar without a parser has the server's or the grammar's for the whole text
  function colorsFor(text, first, last) {
    lineAt(text, 0);
    const from = lineStarts[first] ?? text.length, to = last < lineStarts.length ? lineStarts[last] : text.length;
    const parser = text.length <= HL_MAX && parserNow(lang.check);
    if (parser) {
      const tree = syntax.current(parser, text);
      if (tree) return syntaxRanges(parser, text, tree, from, to);
      return lexState?.ranges || [];
    }
    return lexical;
  }
  function paintMinimap() {
    minimapFrame = 0;
    const display = opts.display?.() || {};
    const on = display.minimap !== false && ready && !closed && !view.hidden && !rendered;
    scroller.classList.toggle('code-has-minimap', on);
    if (!on) { if (!minimap.hidden) { minimap.hidden = true; minimapRows = null; } return; }
    const h = metrics.height;
    if (!h) return;
    minimap.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    setStyle(minimap, 'top', `${scroller.offsetTop}px`); setStyle(minimap, 'height', `${h}px`); setStyle(minimap, 'width', `${MINIMAP_W}px`);
    if (minimap.width !== Math.round(MINIMAP_W * dpr) || minimap.height !== Math.round(h * dpr)) { minimap.width = Math.round(MINIMAP_W * dpr); minimap.height = Math.round(h * dpr); }
    const text = ta.value, g = geom();
    lineAt(text, 0);
    const layout = minimapLayout({ lines: lineStarts.length, lineHeight: g.lh, scrollTop: metrics.top, viewHeight: h, height: h, rowHeight: MINIMAP_ROW });
    minimapLast = layout;
    // the runs kept for a band around the lines shown, made again only when the view leaves it
    const want = { first: layout.first, last: layout.first + layout.count };
    if (!minimapRows || minimapRows.text !== text || want.first < minimapRows.first || want.last > minimapRows.last || minimapRows.epoch !== fontEpoch) {
      const first = Math.max(0, want.first - layout.count), last = Math.min(lineStarts.length, want.last + layout.count);
      minimapRows = { text, first, last, epoch: fontEpoch, rows: minimapRuns(text, lineStarts, first, last, colorsFor(text, first, last), MINIMAP_W, g.tab) };
    }
    const c = minimap.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, MINIMAP_W, h);
    const plain = minimapColor('code-minimap-plain');
    for (let i = 0; i < layout.count; i++) {
      const runs = minimapRows.rows[layout.first + i - minimapRows.first];
      if (!runs) continue;
      const y = i * MINIMAP_ROW;
      for (const [col, len, cls] of runs) {
        c.fillStyle = cls ? minimapColor(cls) : plain;
        c.globalAlpha = cls ? 0.8 : 0.55;
        c.fillRect(col, y, len, MINIMAP_ROW - 0.5);
      }
    }
    c.globalAlpha = minimapDrag ? 0.22 : 0.12;
    c.fillStyle = minimapColor('code-minimap-slider');
    c.fillRect(0, Math.max(0, layout.sliderTop), MINIMAP_W, Math.max(4, layout.sliderHeight));
    c.globalAlpha = 1;
  }
  // a press on the slider drags the view with it; elsewhere, the line pressed is brought mid-view
  minimap.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !minimapLast) return;
    e.preventDefault();
    const g = geom(), rect = minimap.getBoundingClientRect(), y = e.clientY - rect.top, layout = minimapLast;
    if (y >= layout.sliderTop && y <= layout.sliderTop + layout.sliderHeight) minimapDrag = { grab: y - layout.sliderTop };
    else { scrollTo(minimapScrollFor(layout, y, { lineHeight: g.lh, viewHeight: metrics.height, rowHeight: MINIMAP_ROW })); minimapDrag = { grab: layout.sliderHeight / 2 }; }
    const move = (ev) => {
      if (!minimapDrag || !minimapLast) return;
      const top = ev.clientY - rect.top - minimapDrag.grab;
      scrollTo((minimapLast.first + top / MINIMAP_ROW) * geom().lh);
    };
    const up = () => { minimapDrag = null; removeEventListener('mousemove', move); removeEventListener('mouseup', up); minimapSoon(); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
    minimapSoon();
  });

  // --- sticky scroll (sticky-scroll.js): the lines opening the scopes the top of the view is
  // in, held over it as it scrolls past them; a click on one scrolls to it ---
  let stickyFrame = 0, stickyKey = '', stickyText = null;
  const stickySoon = () => { stickyFrame ||= requestAnimationFrame(paintSticky); };
  function hideSticky() { if (!sticky.hidden) { sticky.hidden = true; sticky.replaceChildren(); } stickyKey = ''; }
  function paintSticky() {
    stickyFrame = 0;
    const display = opts.display?.() || {};
    const text = ta.value;
    const parser = display.stickyScroll !== false && ready && !closed && !view.hidden && !rendered && text.length <= HL_MAX && parserNow(lang.check);
    if (!parser || !metrics.height) { hideSticky(); return; }
    const g = geom();
    lineAt(text, 0);
    const topLine = Math.floor((metrics.top - g.top) / g.lh);
    if (topLine <= 0) { hideSticky(); return; }
    // the tree as far as the lines that could be held, parsed already for the view above them
    const upto = lineStarts[Math.min(lineStarts.length - 1, topLine + STICKY_MAX)] ?? text.length;
    const tree = syntax.parseTo(parser, text, upto, 0).tree;
    const lines = stickyLines(tree, text, lineStarts, topLine);
    if (!lines.length) { hideSticky(); return; }
    const key = `${lines.join(',')}|${metrics.left}|${metrics.gutter}|${g.lh}|${g.cw}|${g.left}|${text === stickyText ? '' : '!'}|${semanticText === text}`;
    stickyText = text;
    if (key === stickyKey && !sticky.hidden) return;
    stickyKey = key;
    const colors = lexState && lexParsedText === text ? lexState.ranges : null;
    sticky.replaceChildren(...lines.map((line) => {
      const a = lineStarts[line], b = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
      const row = el('div', 'code-sticky-row');
      row.style.height = `${g.lh}px`;
      const nr = el('span', 'code-sticky-nr', String(line + 1));
      nr.style.width = `${metrics.gutter}px`;
      const codeEl = el('code', `hljs language-${lang.hl}`);
      const lineColors = colors && a >= lexState.from && b <= lexState.to ? colors : syntaxRanges(parser, text, tree, a, b);
      codeEl.innerHTML = highlightRanges(text, lineColors, semantic, a, b) || ' ';
      codeEl.style.paddingLeft = `${g.left}px`;
      codeEl.style.transform = `translateX(${-metrics.left}px)`;
      const body = el('div', 'code-sticky-text');
      body.append(codeEl);
      row.append(nr, body);
      row.addEventListener('click', () => { scrollTo(g.top + line * g.lh); ta.focus({ preventScroll: true }); });
      return row;
    }));
    sticky.style.top = `${scroller.offsetTop}px`;
    sticky.hidden = false;
  }
  // the wheel over the held lines scrolls the text under them
  sticky.addEventListener('wheel', (e) => { e.preventDefault(); scrollTo(metrics.top + e.deltaY, metrics.left + e.deltaX); }, { passive: false });

  // --- a find's matches, set by the host, redrawn with the text ---
  let findRanges = [];
  let findAt = -1;
  function paintFinds() {
    if (!findRanges.length) { if (findsWin.firstChild) findsWin.textContent = ''; return; }
    const text = ta.value;
    if (text !== hlText) { redraw(); return; }
    // only the window's matches made into marks: a find with thousands of matches costs a
    // keystroke no more than one with a few
    const marks = [];
    for (let i = windowStart(findRanges, (r) => r[0], (r) => r[1]); i < findRanges.length && findRanges[i][0] <= drawn.to; i++) {
      const [from, to] = findRanges[i];
      if (to <= text.length) marks.push({ from, to, wrap: (raw) => `<mark${i === findAt ? ' class="now"' : ''}>${esc(raw)}</mark>` });
    }
    findsWin.innerHTML = markedHtml(text, marks, drawn);
    placeWindow(findsWin, drawn);
  }
  // the first of a list sorted by start that may reach into the drawn window: the first
  // starting at or after it, or the one before when that one runs into it
  function windowStart(list, startOf, endOf) {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (startOf(list[mid]) < drawn.from) lo = mid + 1; else hi = mid; }
    while (lo > 0 && endOf(list[lo - 1]) >= drawn.from) lo--;
    return lo;
  }

  // --- an agent's edits, typed in a little at a time where the user sees them ---
  let agentMarks = [];
  let agentAt = -1;
  let agentFade = 0;
  let agentChain = Promise.resolve();
  function paintAgent() {
    if (!agentMarks.length && agentAt < 0) { if (agentWin.firstChild) agentWin.textContent = ''; return; }
    const text = ta.value;
    if (text !== hlText) { redraw(); return; }
    const marks = [...agentMarks.map(([from, to, cls]) => ({ from, to, wrap: (raw) => `<mark class="${cls}">${esc(raw)}</mark>` })),
      ...(agentAt >= 0 ? [{ from: agentAt, to: agentAt, caret: true, wrap: () => '<span class="caret"></span>' }] : [])]
      .filter((x) => x.to <= text.length)
      .sort((x, y) => x.from - y.from || !!x.caret - !!y.caret);
    agentWin.innerHTML = markedHtml(text, marks, drawn);
    placeWindow(agentWin, drawn);
  }
  // a place in the text scrolled to, the user's own caret and selection left as they are
  function revealAt(pos) {
    const line = lineAt(ta.value, pos) - 1;
    const { lh, cw, top, left } = geom();
    const y = top + line * lh;
    if (y < metrics.top || y + lh > metrics.top + metrics.height) scrollTo(y - metrics.height / 3);
    const x = metrics.gutter + left + columnOf(ta.value, lineStarts[line], pos) * cw;
    if (x > metrics.left + metrics.width - cw * 2 || x < metrics.left + metrics.gutter) scrollTo(metrics.top, x - metrics.width / 2);
  }
  // from..to replaced with text: what goes lit red a moment, the new typed in
  // over a second or so; one edit after another, resolved false if it can't land
  function agentEdit(from, to, text, o = {}) {
    const go = () => new Promise((resolve) => {
      const t0 = Date.now();
      const wait = () => {
        if (closed) { resolve(false); return; }
        if (!ready) { if (Date.now() - t0 < 8000) setTimeout(wait, 100); else resolve(false); return; }
        if (ta.readOnly || from < 0 || to > ta.value.length || from > to) { resolve(false); return; }
        start();
      };
      const group = `agent:${++agentSequence}`;
      const put = (str, a, b) => {
        beforeSelection = [ta.selectionStart, ta.selectionEnd];
        historyGroup = group;
        try { ta.setRangeText(str, a, b, 'preserve'); ta.dispatchEvent(new Event('input')); }
        finally { historyGroup = ''; }
      };
      const finish = (n) => {
        agentAt = -1;
        agentMarks = n ? [[from, from + n, 'add done']] : [];
        paintAgent();
        clearTimeout(agentFade);
        agentFade = setTimeout(() => { agentMarks = []; paintAgent(); }, 2200);
        resolve(true);
      };
      const start = () => {
        clearTimeout(agentFade);
        revealAt(from);
        agentMarks = to > from ? [[from, to, 'del']] : [];
        agentAt = from;
        paintAgent();
        setTimeout(() => {
          if (closed) { resolve(false); return; }
          put('', from, to);
          const total = text.length;
          const ms = o.instant ? 0 : Math.min(1400, 6 * total + 150);
          if (!ms || !total) { if (total) put(text, from, from); finish(total); return; }
          const began = performance.now();
          let n = 0;
          const step = (now) => {
            if (closed) { resolve(false); return; }
            const want = Math.min(total, Math.max(n + 1, Math.ceil(total * Math.min(1, (now - began) / ms))));
            put(text.slice(n, want), from + n, from + n);
            n = want;
            agentMarks = [[from, from + n, 'add']];
            agentAt = from + n;
            revealAt(agentAt);
            paintAgent();
            if (n < total) setTimeout(() => step(performance.now()), 16); else finish(n);
          };
          // timers, not frames: a hidden window still finishes its edit
          setTimeout(() => step(performance.now()), 16);
        }, to > from && !o.instant ? 260 : 0);
      };
      wait();
    });
    const p = agentChain.then(go, go);
    agentChain = p;
    return p;
  }
  // text an agent already wrote, there when the file opened: lit a moment
  function agentFlash(from, to) {
    agentChain = agentChain.then(() => {
      if (closed || from < 0 || to > ta.value.length) return;
      clearTimeout(agentFade);
      revealAt(from);
      agentMarks = [[from, to, 'add done']];
      paintAgent();
      agentFade = setTimeout(() => { agentMarks = []; paintAgent(); }, 2200);
    });
    return agentChain;
  }

  // --- the host told: state, caret and errors, once a frame at most ---
  let tellFrame = 0;
  // decorations follow the caret; drawn already this frame if the text was
  const tell = () => { if (!tellFrame) tellFrame = requestAnimationFrame((stamp) => { tellFrame = 0; if (closed) return; tw?.check(); linkedUpdate(); if (stamp !== decoStamp) paintDeco(); opts.onState?.(info()); }); };
  let indexedText, lineStarts = [];
  const firstAbove = (p) => { let lo = 0, hi = lineStarts.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= p) lo = mid + 1; else hi = mid; } return lo; };
  // the line starts kept for the text: an edit's lines found again where it changed, the
  // rest moved by its length, rather than every newline of a long file sought per keystroke
  function reindex(text) {
    const before = indexedText;
    indexedText = text;
    if (before == null || Math.abs(text.length - before.length) > 65536) {
      lineStarts = [0];
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
      return;
    }
    const { head, tail } = changeOf(before, text);
    const endA = before.length - tail, endB = text.length - tail, delta = endB - endA;
    const lo = firstAbove(head), hi = firstAbove(endA);
    const fresh = [];
    for (let i = text.indexOf('\n', head); i >= 0 && i < endB; i = text.indexOf('\n', i + 1)) fresh.push(i + 1);
    const moved = lineStarts.slice(hi);
    if (delta) for (let i = 0; i < moved.length; i++) moved[i] += delta;
    lineStarts.length = lo;
    for (const x of fresh) lineStarts.push(x);
    for (const x of moved) lineStarts.push(x);
  }
  const lineAt = (text, p) => {
    if (text !== indexedText) reindex(text);
    return Math.max(1, firstAbove(p));
  };
  // a long file's textarea holding only the lines around the view and the selection
  // (text-window.js): its value and selection still the whole text's
  const tw = textWindow(ta, {
    view: () => {
      const g = geom(), top = metrics.top - g.top, h = metrics.height || 900;
      return { first: Math.max(0, Math.floor(top / g.lh)), last: Math.max(1, Math.ceil((top + h) / g.lh)) };
    },
    lines: (text) => { lineAt(text, 0); return lineStarts.length; },
    lineOf: (text, p) => lineAt(text, p) - 1,
    lineStart: (text, l) => { lineAt(text, 0); return lineStarts[l]; },
    placed: (line, away) => {
      placeWindowTa();
      ta.classList.toggle('code-ta-away', !!away);
      if (away || awayWas) decoSoon();
      awayWas = !!away;
    },
    // the offset under the mouse, as the hover finds it
    offsetAt: (event) => offsetAtEvent(event),
    moved: () => { caretInView(); sendCursor(); tell(); },
  });
  let awayWas = false;
  // the offset under a mouse event: its line, and the column nearest the mouse on it
  function offsetAtEvent(event) {
    const rect = ta.getBoundingClientRect(), g = geom(), text = ta.value;
    lineAt(text, 0);
    const line = Math.max(0, Math.min(lineStarts.length - 1, Math.floor((event.clientY - rect.top - g.top) / g.lh)));
    const column = Math.max(0, Math.round((event.clientX - rect.left - g.left) / g.cw));
    const start = lineStarts[line], end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
    return start + (offsetAtColumn(text.slice(start, end), 0, column, g.tab) ?? end - start);
  }
  // the textarea's lines drawn from its window's first line down
  let taWindowAt = -1;
  function placeWindowTa() {
    const at = tw ? tw.line() * geom().lh : 0;
    if (at === taWindowAt) return;
    taWindowAt = at;
    ta.style.setProperty('--code-window', `${at}px`);
  }
  // a place's column as drawn, tabs to their stops
  const columnOf = (text, from, to, tabSize = geom().tab) => {
    let n = 0;
    for (let i = from; i < to; i++) n = text.charCodeAt(i) === 9 ? n + tabSize - n % tabSize : n + 1;
    return n;
  };
  // the problems as the host has them, made once per text and list rather than every frame
  let infoErrors = { errs: null, text: null, list: [] };
  function info() {
    const text = ta.value;
    const s = ta.selectionStart;
    if (infoErrors.errs !== errs || infoErrors.text !== text) infoErrors = { errs, text, list: errs.map((x) => ({ from: x.from, to: x.to, what: x.what, source: x.source, code: x.code, severity: diagnosticSeverity(x), line: lineAt(text, x.from), col: x.from - text.lastIndexOf('\n', x.from - 1) })) };
    // line and column the caret's, as VS Code's status bar has them
    const e = headOf(selNow());
    const u = unit();
    return {
      ready, dirty: dirty(), readOnly: ta.readOnly, state: stateEl.textContent, bad: stateEl.classList.contains('bad'),
      lang: lang.hl, line: lineAt(text, e), col: e - text.lastIndexOf('\n', e - 1), sel: ta.selectionEnd - s,
      indent: u === '\t' ? 'tab' : u.length, eol: eolMode, length: text.length, cursors: cursorCount(),
      errors: infoErrors.list,
      people: people.filter((p) => (me ? p.id !== me : p.name !== name)),
    };
  }
  // a converted extension's TextMate grammar: at once when the file opens, then once typing
  // pauses briefly, each line kept while the state it begins in holds; the server's chroma
  // if the grammar can't be read
  let tmTimer = 0, tmApplied = null, tmHighlighter;
  function grammarHighlight(text) {
    if (tmApplied === text) return;
    clearTimeout(tmTimer);
    tmTimer = setTimeout(async () => {
      if (closed || ta.value !== text) return;
      if (tmHighlighter === undefined) { try { tmHighlighter = await lang.grammar(); } catch { tmHighlighter = null; } }
      if (closed || ta.value !== text) return;
      if (!tmHighlighter) { if (text.length <= SERVER_HL_MAX) serverHighlight(text); return; }
      lexical = tmHighlighter(text); lexicalText = text; lexicalDirty = null; tmApplied = text; redraw(true);
    }, tmApplied === null ? 0 : 60);
  }
  // a grammar the page has no parser for: chroma's, once typing pauses
  let hlTimer = 0, hlRequested = null, hlApplied = null, hlAbort = null;
  function serverHighlight(text) {
    if (localOnly || hlRequested === text || hlApplied === text) return;
    clearTimeout(hlTimer);
    hlAbort?.abort();
    hlRequested = text;
    hlTimer = setTimeout(async () => {
      const controller = new AbortController(); hlAbort = controller;
      try {
        const { html } = await mdRequest({ highlight: lang.hl, text }, controller.signal);
        // a reply for text since typed on still applies, moved onto the text now
        const ranges = !closed && typeof html === 'string' ? rangesFromHighlight(html, text) : null;
        if (ranges !== null) { lexical = ranges; lexicalText = text; lexicalDirty = null; hlApplied = text; redraw(true); }
      } catch {} finally { if (hlRequested === text) hlRequested = null; if (hlAbort === controller) hlAbort = null; }
    }, 150);
  }

  // --- markdown rendered: the source's blocks drawn, one edited at a time in place, a click
  // on a block opening its source there. Rendered unless the source was last asked for ---
  const MD_KEY = 'sulfur-md-source';
  let rendered = false;
  let mdEditing = null;
  let mdTimer = 0;
  const mdSoon = () => { if (rendered) { clearTimeout(mdTimer); mdTimer = setTimeout(paintMd, 120); } };
  function setRendered(on) {
    rendered = isMd && on;
    scroller.hidden = rendered;
    mdView.hidden = !rendered;
    viewBtn.textContent = rendered ? 'source' : 'view';
    viewBtn.title = rendered ? 'back to the markdown source' : 'show it rendered, a block edited where it is clicked';
    if (isMd) try { localStorage.setItem(MD_KEY, rendered ? '' : '1'); } catch {}
    if (rendered) paintMd(); else if (mdEditing) mdEditing.box.blur();
    minimapSoon(); stickySoon();
  }
  let mdSeq = 0;
  async function paintMd() {
    if (!rendered || mdEditing) return;
    const text = ta.value;
    const seq = mdSeq += 1;
    const blocks = await mdBlocks(text);
    if (seq !== mdSeq || !rendered || mdEditing || ta.value !== text) return;
    const top = mdView.scrollTop;
    const edit = canWrite();
    mdView.replaceChildren(...blocks.map((b) => {
      const d = el('div', 'md-block');
      renderMd(d, b.raw.replace(/\n+$/, ''), false, b.html);
      if (edit) {
        // a click edits, not one on a link, a box, a plugin's button or a selection made
        d.addEventListener('click', (e) => {
          if (e.target.closest('input, a, summary, button, .md-plugin, .md-embed') || String(getSelection?.() || '')) return;
          editBlock(d, b);
        });
        d.querySelectorAll('li.task input').forEach((box, i) => {
          box.disabled = false;
          box.addEventListener('change', () => tickTask(b, i, box.checked));
        });
      }
      return d;
    }));
    if (!blocks.length) mdView.append(el('div', 'md-empty', 'empty'));
    if (edit) {
      const add = Object.assign(el('button', 'md-add', '+ add a block'), { type: 'button' });
      add.addEventListener('click', () => {
        const t = ta.value;
        const gap = !t || t.endsWith('\n\n') ? '' : t.endsWith('\n') ? '\n' : '\n\n';
        editBlock(add, { from: t.length, raw: '', gap });
      });
      mdView.append(add);
    }
    mdView.scrollTop = top;
    // links, images and embeds made the host's: found as files, opened where they are
    opts.markdownView?.(mdView, file);
  }
  // a block painted later (its html still on its way) given the same
  mdView.addEventListener('md-painted', (e) => { if (rendered && e.target !== mdView && mdView.contains(e.target)) opts.markdownView?.(e.target, file); });
  // an image pasted into a note: saved by the host (into the notes' images), its link typed in
  async function pasteImage(e, put) {
    if (!isMd || !opts.pasteImage || !canWrite()) return false;
    const image = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!image) return false;
    e.preventDefault();
    e.stopPropagation();
    paintState('saving the image…');
    try {
      const link = await opts.pasteImage(image, file);
      if (link && !closed) put(link);
      paintState();
    } catch (err) {
      paintState(`image not saved: ${err.message}`);
    }
    return true;
  }
  mdView.addEventListener('paste', (e) => {
    if (mdEditing || !canWrite()) return;
    pasteImage(e, (link) => {
      const t = ta.value;
      ta.setRangeText(`${!t || t.endsWith('\n\n') ? '' : t.endsWith('\n') ? '\n' : '\n\n'}${link}\n`, t.length, t.length, 'end');
      ta.dispatchEvent(new Event('input'));
    });
  });
  // a task's [ ] or [x] flipped in the source, its block found again if it moved
  function tickTask(b, i, on) {
    const marks = [...b.raw.matchAll(/^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/gm)];
    const now = ta.value;
    const from = now.slice(b.from, b.from + b.raw.length) === b.raw ? b.from : now.indexOf(b.raw);
    if (!marks[i] || from < 0) { paintMd(); return; }
    const at = from + marks[i].index + marks[i][0].length - 2;
    ta.setRangeText(on ? 'x' : ' ', at, at + 1);
    ta.dispatchEvent(new Event('input'));
  }
  function editBlock(d, b) {
    if (mdEditing) return;
    const src = b.raw.replace(/\n+$/, '');
    const tail = b.raw.slice(src.length) || (b.raw ? '' : '\n');
    const box = Object.assign(document.createElement('textarea'), { className: 'md-edit', value: src, spellcheck: true });
    const grow = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };
    d.replaceWith(box);
    mdEditing = { box };
    grow();
    box.focus();
    const done = (keep) => {
      if (mdEditing?.box !== box) return;
      mdEditing = null;
      if (keep && box.value !== src) {
        // found again if others' edits moved it meanwhile
        const now = ta.value;
        const from = now.slice(b.from, b.from + b.raw.length) === b.raw ? b.from : b.raw ? now.indexOf(b.raw) : now.length;
        if (from < 0) paintState('edit lost');
        else {
          const put = box.value.trim() ? `${b.gap || ''}${box.value.replace(/\n+$/, '')}${tail}` : '';
          ta.setRangeText(put, from, from + b.raw.length, 'end');
          ta.dispatchEvent(new Event('input'));
        }
      }
      paintMd();
    };
    box.addEventListener('input', grow);
    box.addEventListener('paste', (e) => { pasteImage(e, (link) => { box.setRangeText(link, box.selectionStart, box.selectionEnd, 'end'); grow(); }); });
    box.addEventListener('blur', () => done(true));
    box.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); mdView.focus(); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); done(true); mdView.focus(); }
      // a tab character typed in, focus staying in the block
      else if (e.key === 'Tab' && !mod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (!document.execCommand('insertText', false, '\t')) {
          box.setRangeText('\t', box.selectionStart, box.selectionEnd, 'end');
          grow();
        }
      }
    });
  }
  viewBtn.addEventListener('click', () => setRendered(!rendered));

  // --- syntax errors: a squiggle under each, a mark in the gutter, a list to jump from ---
  // errs and languageErrors move with edits until the next check replaces them
  let errs = [], errsText = null;
  let languageErrors = null, languageErrorsText = null;
  let checkTimer = 0;
  const diagnosticsDelay = () => diagnosticDelay(opts.diagnosticDelay?.());
  const checkSoon = () => { clearTimeout(checkTimer); checkTimer = setTimeout(check, diagnosticsDelay()); };
  function clearDiagnostics() { errs = []; errsText = ta.value; squigWin.replaceChildren(); errEl.hidden = true; out.hidden = true; hideDiagnosticHover(); paintMarks(); tell(); }
  function paintSquiggles() {
    const text = ta.value;
    if (!errs.length || errsText !== text) { if (squigWin.firstChild) squigWin.replaceChildren(); return; }
    if (text !== hlText) { redraw(); return; }
    const marks = [];
    for (let i = windowStart(errs, (e) => e.from, (e) => e.to); i < errs.length && errs[i].from <= drawn.to; i++) {
      const e = errs[i];
      marks.push({ from: e.from, to: Math.max(e.to, Math.min(e.from + 1, text.length)),
        wrap: (raw) => `<mark class="${e.severity === 2 ? 'code-warning' : e.severity > 2 ? 'code-hint' : ''}">${esc(raw.replace(/\n/g, ' \n')) || ' '}</mark>` });
    }
    squigWin.innerHTML = markedHtml(text, marks, drawn);
    placeWindow(squigWin, drawn);
  }
  // The parse's own syntax errors wait for typing to pause (half-typed code isn't an error
  // yet); a language server's are shown the moment they come, moved onto the text now, as
  // VS Code shows them
  async function check() {
    if (languageErrors !== null) { publishErrors(); return; }
    if (Date.now() - lastTextChange < diagnosticsDelay()) { checkSoon(); return; }
    const text = ta.value;
    const parser = lang.check && text.length <= HL_MAX && await parserFor(lang.check);
    if (closed || text !== ta.value || languageErrors !== null) return;
    const tree = parser && await wholeTree(parser, text);
    if (closed || text !== ta.value || languageErrors !== null || (parser && !tree)) return;
    publishErrors(tree ? syntaxErrors(parser, text, tree) : [], text);
  }
  function publishErrors(list = languageErrorsText === ta.value ? languageErrors : [], text = ta.value) {
    errs = list;
    errsText = text;
    paintSquiggles();
    const lineOf = (p) => lineAt(text, p);
    errEl.hidden = !errs.length;
    const counts = diagnosticCounts(errs);
    errEl.textContent = [['errors', 'error'], ['warnings', 'warning'], ['info', 'info']].filter(([k]) => counts[k]).map(([k, label]) => `${counts[k]} ${label}${counts[k] !== 1 && k !== 'info' ? 's' : ''}`).join(', ');
    outTitle.textContent = errEl.textContent;
    // the list under a bar of its own; the ide has its Problems view instead
    if (!bare) outList.replaceChildren(...errs.map((e) => {
      const row = Object.assign(el('button', 'code-err-row'), { type: 'button' });
      row.append(el('span', 'code-out-dim', `line ${lineOf(e.from)}`), el('span', `code-out-err${diagnosticSeverity(e) === 2 ? ' code-warning' : diagnosticSeverity(e) > 2 ? ' code-hint' : ''}`, diagnosticText(e)));
      row.addEventListener('click', () => { ta.focus(); ta.setSelectionRange(e.from, e.from); caretInView(); });
      return row;
    }));
    if (!errs.length) out.hidden = true;
    paintMarks();
    overviewSoon();
    tell();
  }

  // the others' carets as marks in the gutter, their colour, their name on hover; problems and
  // bookmarks marked beside their lines. Built again only when what they show has moved
  let marksKey = '';
  function paintMarks() {
    const others = people.filter((p) => me ? p.id !== me : p.name !== name);
    const text = ta.value;
    const { lh, numsTop: padTop, cw, top: padY, left: padX } = geom();
    const want = [];
    for (const line of new Set(bookmarks.map((at) => lineAt(text, Math.min(at, text.length)) - 1))) want.push({ kind: 'bookmark', line });
    const byLine = new Map();
    for (const e of errsText === text ? errs : []) {
      const line = lineAt(text, Math.min(e.from, text.length)) - 1;
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(e);
    }
    for (const [line, onLine] of byLine) {
      onLine.sort((a, b) => diagnosticSeverity(a) - diagnosticSeverity(b));
      want.push({ kind: 'err', line, severity: diagnosticSeverity(onLine[0]), title: onLine.map(diagnosticText).join('\n') });
    }
    for (const p of others) {
      const at = Math.min(p.pos, text.length);
      const line = lineAt(text, at) - 1;
      want.push({ kind: 'person', line, col: columnOf(text, lineStarts[line], at), p, tint: p.color || colorFor(p.name) });
    }
    const key = `${lh}|${padTop}|${cw}|${padY}|${padX}|${drawn.first}|${drawn.last}|` + want.filter((m) => m.line >= drawn.first && m.line < drawn.last).map((m) => m.kind === 'person' ? `p${m.line}:${m.col}:${m.p.name}:${m.tint}:${!!m.p.agent}` : `${m.kind}${m.line}:${m.severity ?? ''}:${m.title ?? ''}`).join('|');
    if (key === marksKey) return;
    marksKey = key;
    for (const m of gutter.querySelectorAll('.code-mark')) m.remove();
    for (const c of body.querySelectorAll('.code-caret')) c.remove();
    for (const m of want) {
      if (m.line < drawn.first || m.line >= drawn.last) continue;
      if (m.kind === 'bookmark') {
        const mark = Object.assign(el('div', 'code-mark code-mark-bookmark'), { title: `Bookmark: line ${m.line + 1}` });
        mark.style.top = `${padTop + m.line * lh}px`;
        mark.style.height = `${lh}px`;
        gutter.append(mark);
      } else if (m.kind === 'err') {
        const mk = Object.assign(el('div', `code-mark code-mark-err${m.severity === 2 ? ' code-mark-warning' : m.severity > 2 ? ' code-mark-hint' : ''}`), { title: m.title });
        mk.style.top = `${padTop + m.line * lh}px`;
        mk.style.height = `${lh}px`;
        gutter.append(mk);
      } else {
        const { p, tint, line, col } = m;
        const mk = Object.assign(el('div', p.agent ? 'code-mark agent' : 'code-mark'), { title: p.name });
        mk.style.top = `${padTop + line * lh}px`;
        mk.style.height = `${lh}px`;
        if (!p.agent) mk.style.background = tint;
        gutter.append(mk);
        // their caret in the text, their name over it
        const caret = el('div', p.agent ? 'code-caret agent' : 'code-caret');
        caret.style.cssText = `top:${padY + line * lh}px;left:${padX + col * cw}px;height:${lh}px;--who:${tint}`;
        const flag = caret.appendChild(el('span', 'code-caret-name', p.agent ? '' : p.name));
        if (p.agent) flag.append(el('span', 'who-model', p.name));
        body.append(caret);
      }
    }
  }

  const dirty = () => ready && !(saved < 0 && !ta.value) && (savedText === null || !!inflight || ta.value !== S || S !== savedText);
  function paintState(note) {
    const d = dirty();
    if (!bare) {
      btn.classList.toggle('dirty', d);
      btn.querySelector('.tab-label').textContent = `${codeName(file)}${d ? ' •' : ''}`;
    }
    stateEl.textContent = note || (!ready ? 'connecting' : !canWrite() ? 'read-only' : saved < 0 && !ta.value ? 'new file' : d ? (localOnly ? 'unsaved local changes' : inflight || wantSave || shared() ? 'saving' : 'unsaved') : 'saved');
    stateEl.classList.toggle('bad', !!note);
    saveBtn.disabled = !ready || !canWrite();
    ta.readOnly = !ready || !canWrite();
    const others = people.filter((p) => p.name !== name);
    whoEl.replaceChildren(...others.map((p) => {
      const s = el('span', p.agent ? 'who who-model' : 'who', p.name);
      if (!p.agent) s.style.color = p.color || colorFor(p.name);
      return s;
    }));
    whoEl.hidden = !others.length;
    tell();
    minimapSoon(); stickySoon();
  }

  // the caret kept in view as it moves, the scroller being the editor, not the box
  // center: a jump from afar put mid-view, as a find or a go to line wants
  function caretInView(center = false) {
    // the text not drawn yet (a jump into a file just opened): the layers aren't as tall as
    // the text, so a scroll now would be cut short; done in the frame that draws it
    if (hlText !== ta.value) { wantCaret = true; wantCenter ||= center; redraw(); return; }
    // the line from the kept index and the column as drawn: the measured line height, so a
    // caret far down a long file is scrolled to where its line is drawn
    const text = ta.value, end = headOf(selNow());
    const line = lineAt(text, end) - 1;
    const { lh, cw, top: padY, left: padX } = geom();
    const col = columnOf(text, lineStarts[line], end);
    const y = padY + line * lh;
    const x = metrics.gutter + padX + col * cw;
    const { top, left, width, gutter: gw } = metrics;
    const height = metrics.height || scroller.clientHeight;
    // lines kept between the caret and the view's edges (editor.cursorSurroundingLines)
    const keep = Math.min(Math.max(0, Math.floor(height / lh / 2) - 1), (opts.display?.() || {}).cursorSurroundingLines || 0) * lh;
    const out = y < top + keep || y + lh > top + height - keep;
    if (center && out) scrollTo(y - height / 2);
    else if (y < top + keep) scrollTo(y - keep);
    else if (y + lh > top + height - keep) scrollTo(y + lh - height + 4 + keep);
    if (x < left + gw) scrollTo(metrics.top, x - gw - cw * 4);
    else if (x > left + width - cw * 2) scrollTo(metrics.top, x - width + cw * 4);
  }

  // --- the session ---
  function flush() {
    if (localOnly) return;
    if (inflight || !ready || !canWrite() || ta.value === S || (!wantSave && !shared())) return;
    const text = ta.value;
    inflight = { id: `${id}-${opSeq += 1}`, ops: opDiff(S, text), text };
    say({ type: 'op', base: V, ops: inflight.ops, id: inflight.id });
  }

  function setText(text, keepSel) {
    indentText = null;
    const [s0, s1] = [ta.selectionStart, ta.selectionEnd];
    if (historyReady && ta.value !== text) history.remote(opDiff(ta.value, text));
    historyReady = true;
    ta.value = text;
    historyText = text;
    if (keepSel) ta.setSelectionRange(Math.min(s0, text.length), Math.min(s1, text.length));
    redraw();
  }

  function remote(ops, agent = '') {
    const C = ta.value;
    const P = inflight ? opApply(S, inflight.ops) : S;
    let r = ops;
    // (the edit in flight moved past theirs: the text it made no longer the one it will make)
    if (inflight) { [inflight.ops, r] = opTransform(inflight.ops, r); inflight.text = null; }
    const [, r2] = opTransform(opDiff(P, C), r);
    const [s0, s1] = [ta.selectionStart, ta.selectionEnd];
    const top = scroller.scrollTop;
    const next = opApply(C, r2);
    if (agent) history.record(C, next, [s0, s1], [opMap(r2, s0), opMap(r2, s1)], `agent:remote:${agent}`);
    else history.remote(r2);
    ta.value = next;
    historyText = ta.value;
    ta.setSelectionRange(opMap(r2, s0), opMap(r2, s1));
    scroller.scrollTop = top;
    redraw();
  }

  let refused = '';
  function connect() {
    if (closed) return;
    const q = new URLSearchParams({ share: file.share, path: file.path });
    sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${hostUrl(file.host, `/api/code/${encodeURIComponent(file.host)}`)}?${q}`);
    // the chat's name, else the user this desktop logged into the host as
    const who = name || dk.creds.get(file.host)?.user || 'anon';
    sock.onopen = () => { retry = 1000; say({ type: 'join', name: who, color: color || colorFor(who) }); };
    sock.onmessage = (ev) => {
      if (closed) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'init' || msg.type === 'resync') {
        const lost = ready && ta.value !== S && ta.value !== msg.text;
        // edits held here when the socket dropped, put onto the text the session came back with
        const base = msg.type === 'init' ? heldBase : null;
        heldBase = null;
        const mine = base !== null && ta.value !== base ? opDiff(base, ta.value) : null;
        S = msg.text;
        V = msg.v;
        saved = msg.saved;
        savedText = saved >= 0 && saved === V ? S : null;
        // a host's own share without its login: read only
        if (msg.perms !== undefined) perms = file.share !== 'home' && !dk.creds.has(file.host) ? msg.perms.replace(/[^r]/g, '') : msg.perms;
        if (msg.people) people = msg.people;
        if (msg.you) me = msg.you;
        if (msg.eol) eolMode = msg.eol === '\r\n' ? 'CRLF' : 'LF';
        inflight = null;
        ready = true;
        if (mine) { const [, theirs] = opTransform(mine, opDiff(base, S)); setText(opApply(ta.value, theirs), true); }
        else setText(S, true);
        sameS();
        flush();
        paintState(lost ? 'edit dropped' : '');
        if (msg.type === 'init' && !view.dataset.seen) { view.dataset.seen = '1'; ta.setSelectionRange(0, 0); }
      } else if (msg.type === 'op') {
        if (inflight && msg.id === inflight.id) {
          // our own edit as sent: the text it made, the very string, rather than made again
          S = inflight.text !== null && sameOps(msg.ops, inflight.ops) ? inflight.text : opApply(S, msg.ops);
          V = msg.v;
          inflight = null;
          sameS();
          flush();
        } else {
          remote(msg.ops, msg.agent ? msg.agentEdit || msg.by || 'agent' : '');
          S = opApply(S, msg.ops);
          V = msg.v;
          if (!inflight) sameS();
        }
        if (wantSave && !inflight && ta.value === S) { wantSave = false; say({ type: 'save' }); }
        paintState();
      } else if (msg.type === 'eol') {
        eolMode = msg.eol === '\r\n' ? 'CRLF' : 'LF';
        tell();
      } else if (msg.type === 'saved') {
        saved = msg.v;
        if (saved === V) savedText = S;
        paintState();
      } else if (msg.type === 'disk') {
        diskRevision = msg.revision;
        diskNotice.hidden = !msg.conflict;
        diskMessage.textContent = msg.problem || 'This file changed outside Sulfur while the editor had unsaved changes. Review both versions before saving.';
        diskText.textContent = msg.conflict ? msg.text || '' : '';
        diskCompare.hidden = !!msg.problem;
        reloadDisk.disabled = !!msg.problem;
        keepEditor.disabled = !canWrite();
        paintState(msg.conflict ? 'disk changes need review' : '');
      } else if (msg.type === 'people') {
        people = Array.isArray(msg.people) ? msg.people : [];
        // someone came in: what was held goes to them now
        flush();
        paintState();
        paintMarks();
      } else if (msg.type === 'error') {
        refused = msg.error;
        paintState(msg.error);
      }
    };
    sock.onclose = () => {
      if (ready && !inflight && ta.value !== S) heldBase = S;
      ready = false;
      inflight = null;
      if (closed) return;
      // the host said why: said once, never retried
      if (refused) { paintState(refused); return; }
      paintState('reconnecting');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
  }

  // --- editing ---
  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  const CLOSERS = new Set([')', ']', '}']);
  // the indentation detected as VS Code does it, from the file as it opened (or came back
  // from its host), not again every keystroke; a small file still being started is read
  // again as it grows, so its first indented lines decide
  let indentText = null, indentUnit;
  function unit() {
    const t = ta.value;
    const options = opts.formatting?.();
    if (options && !options.detectIndentation) return options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
    if (indentText === t || (indentText !== null && indentText.length > 20000)) return indentUnit;
    indentText = t;
    indentUnit = detectUnit(t);
    return indentUnit;
  }
  function detectUnit(t) {
    if (/^\t/m.test(t) && !/^ {2}/m.test(t)) return '\t';
    if (lang.hl === 'python') return '    ';
    const m = t.slice(0, 20000).match(/^( +)\S/gm) || [];
    const w = Math.min(...m.map((s) => s.length - 1).filter((n) => n > 0), 8);
    return ' '.repeat(Number.isFinite(w) && w <= 8 && w > 0 ? (w >= 4 ? 4 : w) : 2);
  }
  // All edits go through the same history, including synthetic and agent edits.
  // A short edit is the browser's own (execCommand: its events, the caret shown); a long one is
  // put in directly, as the browser's editing takes time quadratic in the lines it inserts (an
  // indent of 100KB took it 3s, of 540KB two and a half minutes; setRangeText 8ms)
  const NATIVE_EDIT = 4096;
  function typeIn(from, to, text, selFrom, selTo) {
    beforeSelection = [ta.selectionStart, ta.selectionEnd];
    history.boundary();
    const native = text.length + (to - from) <= NATIVE_EDIT;
    // the range in the textarea's window, however long, for the browser's own edit of it
    if (native) { if (tw) tw.grab(from, to); else ta.setSelectionRange(from, to); }
    replicaShift = 0;
    const ok = native && (text ? document.execCommand('insertText', false, text) : document.execCommand('delete'));
    if (!ok) { ta.setRangeText(text, from, to, 'end'); wantCaret = true; ta.dispatchEvent(new Event('input')); }
    if (selFrom !== undefined) ta.setSelectionRange(selFrom + replicaShift, (selTo ?? selFrom) + replicaShift);
  }
  const lineStart = (p) => ta.value.lastIndexOf('\n', p - 1) + 1;
  const lineEnd = (p) => { const e = ta.value.indexOf('\n', p); return e < 0 ? ta.value.length : e; };

  function shiftLines(out) {
    const u = unit();
    const a = lineStart(ta.selectionStart);
    const b = lineEnd(ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && ta.value[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    const lines = ta.value.slice(a, b).split('\n');
    const n = u === '\t' ? 4 : u.length;
    const next = lines.map((l) => (out
      ? (l.startsWith('\t') ? l.slice(1) : l.replace(new RegExp(`^ {1,${n}}`), ''))
      : (l ? u + l : l))).join('\n');
    typeIn(a, b, next, a, a + next.length);
  }

  // a line comment per line, as VS Code's Ctrl+/; a language with only block comments (CSS,
  // HTML, XML) takes those instead
  function toggleComment() {
    if (ta.readOnly) return false;
    if (!lang.comment) return toggleBlock();
    const s = ta.selectionStart, e = ta.selectionEnd;
    const edit = toggleLineComment(ta.value, s, e, lang.comment);
    const whole = s !== e;
    typeIn(edit.from, edit.to, edit.text, whole ? edit.from : undefined, whole ? edit.from + edit.text.length : undefined);
    if (!whole) {
      // the caret kept on its text, moved by what went in or out before it on its line
      const delta = edit.text.indexOf('\n') < 0 ? edit.text.length - (edit.to - edit.from) : 0;
      const at = Math.max(edit.from, s + delta);
      ta.setSelectionRange(at, at);
    }
    return true;
  }
  function toggleBlock() {
    const pair = blockCommentFor(lang.hl);
    if (!pair || ta.readOnly) return false;
    const edit = toggleBlockComment(ta.value, ta.selectionStart, ta.selectionEnd, pair);
    typeIn(edit.from, edit.to, edit.text, ...edit.select);
    return true;
  }
  // the nearest line above ls with text: its indentation, and whether it opens a block
  function indentAbove(v, ls) {
    for (let end = ls - 1; end > 0;) {
      const start = v.lastIndexOf('\n', end - 1) + 1;
      const line = v.slice(start, end);
      if (line.trim()) return { indent: line.match(/^[ \t]*/)[0], opens: /[{[(]\s*$/.test(line) || (lang.hl === 'python' && /:\s*(#.*)?$/.test(line)) };
      end = start - 1;
    }
    return null;
  }
  // the caret's active end and the selection's anchor, as the textarea's direction says
  const anchorHead = () => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    return ta.selectionDirection === 'backward' ? [e, s] : [s, e];
  };
  // Home as VS Code's: the line's first non-blank character, then its start, and back
  function smartHome(extend) {
    const v = ta.value;
    const [anchor, head] = anchorHead();
    const ls = lineStart(head);
    const ind = ls + v.slice(ls, lineEnd(ls)).match(/^[ \t]*/)[0].length;
    const to = head === ind ? ls : ind;
    if (extend) ta.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? 'backward' : 'forward');
    else ta.setSelectionRange(to, to);
    caretInView(); sendCursor(); tell();
  }
  // Up, Down, PageUp and PageDown as VS Code's: the caret a line (or a screen of lines) on, at
  // the column it set out from however short the lines it passes, the first line's start or the
  // last's end when there's no line further; a page scrolling the view with it (the browser's
  // only scrolls, the textarea not being the scroller)
  let goal = null;
  function verticalMove(d, extend, page) {
    const v = ta.value, g = geom();
    const [anchor, head] = anchorHead();
    const line = lineAt(v, head) - 1, n = lineStarts.length;
    const col = goal?.at === head ? goal.col : columnOf(v, lineStarts[line], head);
    const step = page ? Math.max(1, Math.floor(metrics.height / g.lh) - 1) : 1;
    const to = Math.max(0, Math.min(n - 1, line + d * step));
    let at;
    if (to === line) at = d > 0 ? v.length : 0;
    else {
      const start = lineStarts[to], end = to + 1 < n ? lineStarts[to + 1] - 1 : v.length;
      at = start + (offsetAtColumn(v.slice(start, end), 0, col, g.tab) ?? end - start);
    }
    // without shift, a selection collapses to where its active end moves
    if (extend) ta.setSelectionRange(Math.min(anchor, at), Math.max(anchor, at), at < anchor ? 'backward' : 'forward');
    else ta.setSelectionRange(at, at);
    goal = { at, col };
    if (page) scrollTo(metrics.top + (to - line) * g.lh);
    caretInView(); sendCursor(); tell();
  }
  // copy and cut with nothing selected take the whole line, as VS Code's do; pasting that
  // line back with nothing selected puts it above the caret's line
  let lineClip = null;
  const lineRange = (p) => { const a = lineStart(p), b = lineEnd(p); return [a, b]; };
  ta.addEventListener('copy', (e) => {
    if (ta.selectionStart !== ta.selectionEnd || (opts.display?.() || {}).emptySelectionClipboard === false) { lineClip = null; return; }
    const [a, b] = lineRange(ta.selectionStart);
    lineClip = `${ta.value.slice(a, b)}\n`;
    e.clipboardData.setData('text/plain', lineClip);
    e.preventDefault();
  });
  ta.addEventListener('cut', (e) => {
    if (ta.selectionStart !== ta.selectionEnd || (opts.display?.() || {}).emptySelectionClipboard === false) { lineClip = null; return; }
    e.preventDefault();
    const v = ta.value, [a, b] = lineRange(ta.selectionStart);
    lineClip = `${v.slice(a, b)}\n`;
    e.clipboardData.setData('text/plain', lineClip);
    if (ta.readOnly) return;
    const from = b < v.length ? a : Math.max(0, a - 1), to = b < v.length ? b + 1 : b;
    typeIn(from, to, '', from);
  });
  ta.addEventListener('paste', (e) => {
    if (!ta.readOnly && [...(e.clipboardData?.files || [])].some((f) => f.type.startsWith('image/'))) {
      pasteImage(e, (link) => typeIn(ta.selectionStart, ta.selectionEnd, link));
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (ta.readOnly || !lineClip || text?.replace(/\r\n/g, '\n') !== lineClip || ta.selectionStart !== ta.selectionEnd) return;
    e.preventDefault();
    const s = ta.selectionStart, a = lineStart(s);
    typeIn(a, a, lineClip, s + lineClip.length);
  });

  // ctrl+s the file's save, never the browser's save page
  view.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
  });

  ta.addEventListener('keydown', (e) => {
    const s = ta.selectionStart;
    const t = ta.selectionEnd;
    const v = ta.value;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) {
      e.preventDefault(); e.stopPropagation();
      historyStep(e.key.toLowerCase() === 'y' || e.shiftKey);
      return;
    }
    if (e.key === 'Escape' && cursors.length) { e.preventDefault(); e.stopPropagation(); clearCursors(); return; }
    // the ide's escape its own: a find closed, the focus kept
    if (e.key === 'Escape' && !bare) { e.preventDefault(); ta.blur(); return; }
    // the other cursors moved as the primary is about to be (multi-cursor.js)
    if (cursors.length && !e.isComposing) {
      const word = IS_MAC ? e.altKey : e.ctrlKey, lineKey = IS_MAC && e.metaKey;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const right = e.key === 'ArrowRight'; setCursors(moveCursors(v, cursors, lineKey ? (right ? 'end' : 'lineStart') : word ? (right ? 'wordRight' : 'wordLeft') : right ? 'right' : 'left', e.shiftKey), v); }
      else if (e.key === 'End' && !mod) setCursors(moveCursors(v, cursors, 'end', e.shiftKey), v);
      else if (e.key === 'Home' && !mod) setCursors(moveCursors(v, cursors, 'home', e.shiftKey), v);
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !mod && !e.altKey) setCursors(moveCursorsVertically(v, cursors, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey, geom().tab), v);
      else if (e.key === 'PageDown' || e.key === 'PageUp' || (mod && e.key.toLowerCase() === 'a')) clearCursors();
    }
    if (mod && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (e.key === 'Home' && !mod && !e.altKey) { e.preventDefault(); smartHome(e.shiftKey); return; }
    if ((e.key === 'PageDown' || e.key === 'PageUp') && !mod && !e.altKey) { e.preventDefault(); verticalMove(e.key === 'PageDown' ? 1 : -1, e.shiftKey, true); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !mod && !e.altKey && !e.isComposing) { e.preventDefault(); verticalMove(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey, false); return; }
    if (ta.readOnly || mod || e.altKey) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey || v.slice(s, t).includes('\n')) shiftLines(e.shiftKey);
      else typeIn(s, t, unit());
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const ls = lineStart(s);
      let ind = v.slice(ls, s).match(/^[ \t]*/)[0];
      const before = v.slice(ls, s).trimEnd();
      // on an empty line the indentation comes from the nearest line above with text (a
      // level deeper if it opens a block), as VS Code's, so a run of Enters stays indented
      if (s === t && ls === s && !v.slice(s, lineEnd(s)).trim()) {
        const above = indentAbove(v, ls);
        if (above) ind = above.indent + (above.opens ? unit() : '');
      }
      // a doc comment carried on, or closed under a fresh /**
      const doc = s === t && docCommentEnter(v, s, lang.hl);
      if (doc) { typeIn(s, t, doc.text, s + doc.caret); return; }
      const opens = /[{[(]$/.test(before) || (lang.hl === 'python' && before.endsWith(':'));
      const u = unit();
      // a line left holding only indentation is left empty, as VS Code trims what it put in
      const from = !before && s === t && lineEnd(s) === s ? ls : s;
      if (opens && CLOSERS.has(v[t])) {
        typeIn(from, t, `\n${ind}${u}\n${ind}`, from + 1 + ind.length + u.length);
      } else typeIn(from, t, `\n${ind}${opens ? u : ''}`);
      return;
    }
    if (e.key === 'Backspace' && s === t && s > 0 && !cursors.length) {
      if (PAIRS[v[s - 1]] && PAIRS[v[s - 1]] === v[s]) { e.preventDefault(); typeIn(s - 1, s + 1, ''); return; }
      const ls = lineStart(s);
      const u = unit();
      if (u !== '\t' && /^ +$/.test(v.slice(ls, s))) {
        e.preventDefault();
        const n = (s - ls) % u.length || u.length;
        typeIn(s - n, s, '');
      }
      return;
    }
    if (e.key.length !== 1) return;
    // with several cursors a key types plainly at each, the pair tricks being a lone caret's
    if (cursors.length) return;
    // a closer already there stepped over
    if ((CLOSERS.has(e.key) || `"'\``.includes(e.key)) && s === t && v[s] === e.key) {
      e.preventDefault();
      ta.setSelectionRange(s + 1, s + 1);
      return;
    }
    // a closer typed on a line of only indentation outdented to its opener's line
    if (CLOSERS.has(e.key) && s === t && v.length <= HL_MAX) {
      const o = outdentFor(v, s, e.key, isCode(v));
      if (o) { e.preventDefault(); typeIn(o.from, o.to, `${o.indent}${e.key}`, o.from + o.indent.length + 1); return; }
    }
    if (PAIRS[e.key]) {
      const quote = `"'\``.includes(e.key);
      if (s !== t) { e.preventDefault(); typeIn(s, t, `${e.key}${v.slice(s, t)}${PAIRS[e.key]}`, s + 1, t + 1); return; }
      const next = v[s] || '';
      const prev = v[s - 1] || '';
      const free = !next || /\s/.test(next) || CLOSERS.has(next) || next === ',' || next === ';';
      if (free && (!quote || !/[\w"'`]/.test(prev))) { e.preventDefault(); typeIn(s, t, `${e.key}${PAIRS[e.key]}`, s + 1); }
    }
  });

  // --- several cursors at once (multi-cursor.js): the textarea's selection the primary, the
  // others kept here and drawn under the text, each edit typed made again at every one ---
  let cursors = [], cursorsText = null, cursorsWhole = false, replicaShift = 0;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
  function setCursors(list, text) { cursors = list.length ? normalizeCursors(list) : []; cursorsText = cursors.length ? text : null; }
  const cursorCount = () => cursors.filter((c) => !c.linked).length;
  function clearCursors() {
    if (!cursors.length) return;
    // a linked tag name let go stays unlinked until the caret leaves it
    if (cursors.some((c) => c.linked) && linkedAt !== null) linkedOff = linkedAt;
    setCursors([], null); cursorsWhole = false; paintDeco(); tell();
  }
  // --- linked editing (linked-editing.js): the caret in a tag's name, its partner's name a
  // linked cursor, so a rename types into both; drawn as an underline rather than a caret ---
  const LINKED = /^(html|xml|javascript:jsx)/;
  let linkedAt = null, linkedOff = null;
  function linkedUpdate() {
    const display = opts.display?.() || {};
    const text = ta.value;
    const parser = display.linkedEditing !== false && ready && !ta.readOnly && LINKED.test(lang.check) && text.length <= HL_MAX && parserNow(lang.check);
    const linkedNow = cursors.length === 1 && !!cursors[0].linked && cursorsText === text;
    if (!parser) { if (linkedNow) setCursors([], null); return; }
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (s !== e || (cursors.length && !linkedNow)) { if (linkedNow) { setCursors([], null); paintDeco(); } return; }
    // the tree as far as the caret: parsed already for the view when the caret's on screen
    const link = linkedTagRange(syntax.parseTo(parser, text, Math.min(text.length, s + 1), 0).tree, text, s);
    if (!link || linkedOff === link.from) {
      if (!link) { linkedOff = null; linkedAt = null; }
      if (linkedNow) { setCursors([], null); paintDeco(); }
      return;
    }
    linkedAt = link.from;
    const at = link.partner.from + (s - link.from);
    if (linkedNow && cursors[0].head === at && cursors[0].from === link.partner.from && cursors[0].to === link.partner.to) return;
    setCursors([{ anchor: at, head: at, linked: true, from: link.partner.from, to: link.partner.to }], text);
    paintDeco();
  }
  // the browser's edit at the primary (historyText → ta.value) made at the others too
  function replicate() {
    const before = historyText, after = ta.value;
    const r = replicateEdit(before, after, beforeSelection, ta.selectionStart, cursorsText === before ? cursors : []);
    if (!r) { setCursors([], null); return; }
    const ops = opEdits(after, r.edits);
    const next = opApply(after, ops);
    const was = ta.selectionStart;
    ta.value = next;
    ta.setSelectionRange(r.primary[0], r.primary[1]);
    replicaShift = r.primary[0] - was;
    // a linked name stays linked through the edit, its range found again at the next frame
    if (cursors.every((c) => c.linked)) for (const c of r.cursors) c.linked = true;
    setCursors(r.cursors, next);
  }
  // the primary made one of the others, a new selection taking its place
  function takePrimary(select) {
    const [s, e] = [ta.selectionStart, ta.selectionEnd];
    setCursors([...(cursorsText === ta.value ? cursors : []), { anchor: s, head: e }], ta.value);
    ta.setSelectionRange(select[0], select[1]);
    ta.focus({ preventScroll: true });
    caretInView(); sendCursor(); tell(); paintDeco();
  }
  // Ctrl+D: the word at the caret, then the next match of the selection as another cursor
  function addNextMatch() {
    if (ta.readOnly && !ready) return false;
    const text = ta.value;
    const m = nextMatch(text, [ta.selectionStart, ta.selectionEnd], cursorsText === text ? cursors : [], cursorsWhole);
    if (!m) return false;
    if (ta.selectionStart === ta.selectionEnd) { cursorsWhole = m.whole; ta.setSelectionRange(...m.select); sendCursor(); tell(); return true; }
    cursorsWhole = m.whole;
    takePrimary(m.select);
    return true;
  }
  // Ctrl+Shift+L: a cursor on every match
  function selectAllMatches() {
    const text = ta.value;
    const all = allMatches(text, [ta.selectionStart, ta.selectionEnd], cursorsWhole);
    if (all.length < 2) return false;
    const primary = all.pop();
    setCursors(all, text);
    ta.setSelectionRange(primary.anchor, primary.head);
    ta.focus({ preventScroll: true });
    sendCursor(); tell(); paintDeco();
    return true;
  }
  // Ctrl+Alt+Up and Down: a cursor on the line beside the primary, at its column
  function addCursorLine(d) {
    const next = cursorBeside(ta.value, ta.selectionEnd, d, geom().tab);
    if (!next) return false;
    takePrimary([next.anchor, next.head]);
    return true;
  }
  // Shift+Alt+I: a cursor at the end of each selected line
  function addCursorsAtLineEnds() {
    const [s, e] = [ta.selectionStart, ta.selectionEnd];
    const ends = cursorsAtLineEnds(ta.value, s, e);
    if (!ends.length) return false;
    const primary = ends.pop();
    setCursors(ends, ta.value);
    ta.setSelectionRange(primary.anchor, primary.head);
    sendCursor(); tell(); paintDeco();
    return true;
  }
  // Alt+click adds a cursor where the mouse is; any other press is one caret again
  ta.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!e.altKey || ta.readOnly) { if (!e.shiftKey) clearCursors(); return; }
    e.preventDefault();
    const at = offsetAtEvent(e);
    if (at === null) return;
    ta.focus({ preventScroll: true });
    takePrimary([at, at]);
  });
  let cursorTimer = 0;
  const sendCursor = () => {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => say({ type: 'cursor', pos: ta.selectionStart }), 250);
  };
  ta.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); historyStep(e.inputType === 'historyRedo'); return; }
    beforeSelection = [ta.selectionStart, ta.selectionEnd];
  });
  ta.addEventListener('input', (e) => {
    const group = historyGroup || (/^(insertText|deleteContentBackward|deleteContentForward)$/.test(e.inputType) ? e.inputType : '');
    if (cursors.length) replicate();
    history.record(historyText, ta.value, beforeSelection, [ta.selectionStart, ta.selectionEnd], group);
    historyText = ta.value;
    beforeSelection = [ta.selectionStart, ta.selectionEnd];
    // the caret scrolled to in the frame that draws the edit: one layout per keystroke. Only for
    // the user's own typing: an edit made elsewhere (an agent's, a task ticked in the rendered
    // markdown) leaves the view where it is
    if (e.isTrusted) wantCaret = true;
    redraw(); flush(); paintState(); sendCursor();
  });
  // the caret brought into view when it moved, not on any key let go: a key released into
  // an editor just focused (Enter from quick open) would scroll a tab coming back to its caret
  let seenSel = [-1, -1];
  ta.addEventListener('focus', () => { seenSel = [ta.selectionStart, ta.selectionEnd]; });
  // (a select event the same: the textarea's window moving fires one for a selection unchanged)
  // the line highlight, brackets and status moved with the caret the frame it moves: a press
  // places it (click comes only on release), and a drag or the keyboard moves it on
  ta.addEventListener('mousedown', () => tell());
  const selectionMoved = () => { if (document.activeElement === ta) tell(); };
  document.addEventListener('selectionchange', selectionMoved);
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, () => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (ev === 'click' || s !== seenSel[0] || e !== seenSel[1]) caretInView();
    seenSel = [s, e];
    sendCursor(); tell();
  });

  let localSave = null;
  function save() {
    if (!ready || !canWrite()) return;
    if (localOnly) {
      if (localSave) return localSave;
      const text = ta.value;
      localSave = Promise.resolve().then(() => opts.saveText(text)).then(() => {
        S = savedText = text;
        if (!closed) paintState();
        return true;
      }).catch((error) => {
        if (error.name !== 'AbortError') opts.onError?.(error);
        paintState(error.name === 'AbortError' ? 'save cancelled' : error.message);
        return false;
      }).finally(() => { localSave = null; });
      return localSave;
    }
    if (inflight || ta.value !== S) { wantSave = true; flush(); return; }
    say({ type: 'save' });
  }

  errEl.addEventListener('click', () => { out.hidden = !out.hidden; });
  saveBtn.addEventListener('click', save);
  shareBtn.addEventListener('click', () => shareMenu(shareBtn, file, (said) => {
    stateEl.textContent = said;
    setTimeout(() => paintState(), 3000);
  }));
  if (isMd) { let on = true; try { on = localStorage.getItem(MD_KEY) !== '1'; } catch {} setRendered(on); }
  outClose.addEventListener('click', () => { out.hidden = true; });
  // the gutter scrolled with the text, kept at the left edge
  scroller.addEventListener('click', (e) => { if (e.target === scroller || e.target === body) ta.focus({ preventScroll: true }); });

  // a close with unsaved edits held once: the label says so, a second close goes
  let armed = 0;
  function holdClose() {
    if (!dirty() || armed) return false;
    btn.querySelector('.tab-label').textContent = 'unsaved';
    armed = setTimeout(() => { armed = 0; paintState(); }, 3000);
    return true;
  }

  if (typeof opts.readOnlyText === 'string' || localOnly) {
    S = localOnly ? opts.localText : opts.readOnlyText; V = 0; saved = 0; savedText = S; ready = true; perms = localOnly ? 'rw' : 'r';
    setText(S, false);
  } else connect();
  redraw();
  paintState();
  return {
    file,
    dirty,
    save,
    holdClose,
    undo: () => historyStep(),
    redo: () => historyStep(true),
    // focus never scrolls: the browser would bring the textarea's caret into view, undoing
    // the place a tab coming back was put; caretInView scrolls where a move asks for it
    focus: () => ta.focus({ preventScroll: true }),
    // shown again (its tab's), or restyled (a setting): only a restyle reads the geometry again,
    // a read of computed style forcing the whole page's style to be worked out mid-switch
    show: (restyle = false) => { if (restyle || !geomCache) regeom(); overviewColors = null; minimapColors = new Map(); minimapRows = null; stickyKey = ''; rulersKey = ''; guideSnapshot = null; redraw(true); },
    // several cursors (multi-cursor.js)
    addNextMatch, selectAllMatches, addCursorLine, addCursorsAtLineEnds, clearCursors, cursorCount,
    // every range a cursor, the last the primary (a find's matches, Alt+Enter)
    setSelections(ranges) {
      if (!ranges.length) return false;
      const list = ranges.map(([a, b]) => ({ anchor: a, head: b }));
      const primary = list.pop();
      setCursors(list, ta.value); cursorsWhole = false;
      ta.focus({ preventScroll: true }); ta.setSelectionRange(primary.anchor, primary.head);
      caretInView(); sendCursor(); tell(); paintDeco();
      return true;
    },
    text: () => ta.value,
    // a converted extension enabled or disabled: its grammar taken up or let go, the colors
    // worked out again; a language the page parses never changes
    refreshLanguage() {
      if (lang.check) return false;
      const next = contributedLang(file.path, codeLang(file.path)) || { hl: 'plaintext', check: '', comment: '' };
      if (next.hl === lang.hl && next.scopeName === lang.scopeName && next.comment === lang.comment) return false;
      lang = next;
      clearTimeout(tmTimer); tmHighlighter = undefined; tmApplied = null; hlApplied = null; hlRequested = null;
      redraw(true);
      return true;
    },
    setInlineSuggestion,
    info,
    async syntaxTree() {
      const text = ta.value;
      const p = text.length <= HL_MAX && await parserFor(lang.check);
      return !closed && p && ta.value === text ? wholeTree(p, text) : null;
    },
    editMany: (edits, selection) => {
      if (ta.readOnly || !ready) return false;
      const before = ta.value;
      const ops = opEdits(before, edits);
      const next = opApply(before, ops);
      const sel = selection || [opMap(ops, ta.selectionStart), opMap(ops, ta.selectionEnd)];
      history.recordOperation(before, ops, [ta.selectionStart, ta.selectionEnd], sel);
      // the edits' own places for the parse: a format's many small edits reuse the tree
      // between them rather than parsing the file again from the first to the last
      syntax.noteEdits(before, next, ops);
      setCursors([], null);
      ta.value = next; historyText = ta.value; beforeSelection = sel;
      ta.setSelectionRange(...sel);
      redraw(); flush(); paintState(); caretInView(); sendCursor();
      return true;
    },
    // Programmatic edits share the same history as typing and agent edits.
    edit: (from, to, text, selFrom, selTo) => {
      if (ta.readOnly) return false;
      ta.focus();
      typeIn(from, to, text, selFrom, selTo);
      caretInView();
      return true;
    },
    // focus false: the caret moved and shown, the focus left where it is (a find's box)
    select: (from, to = from, { focus = true } = {}) => {
      if (focus) ta.focus({ preventScroll: true });
      ta.setSelectionRange(from, to);
      caretInView(true);
      sendCursor();
      tell();
    },
    selection: () => [ta.selectionStart, ta.selectionEnd],
    toggleComment: () => toggleComment(),
    // the file's line ending changed by its host, which writes it; a browser file keeps its own
    setEol: localOnly ? null : (mode) => { if (!ready || !canWrite()) return false; say({ type: 'eol', eol: mode === 'CRLF' ? '\r\n' : '\n' }); return true; },
    // the indentation detected again, after it was converted
    indentChanged: () => { indentText = null; guideSnapshot = null; tell(); },
    toggleBlockComment: () => toggleBlock(),
    // Go to Bracket: to the partner of the bracket at the caret, else to the enclosing pair's
    // closer (its opener from there); select: everything from one bracket to the other
    goToBracket(select = false) {
      const text = ta.value, code = isCode(text);
      const [s, e] = [ta.selectionStart, ta.selectionEnd];
      const pair = bracketPair(text, e, code) || enclosingPair(text, e, code);
      if (!pair) return false;
      if (select) ta.setSelectionRange(pair.open, pair.close + 1);
      else {
        // from at or just after one bracket to just before the other, as VS Code jumps
        const to = e === pair.close || e === pair.close + 1 ? pair.open : pair.close;
        ta.setSelectionRange(to, to);
      }
      ta.focus(); caretInView(); sendCursor(); tell();
      return s !== ta.selectionStart || e !== ta.selectionEnd;
    },
    // the hover at the caret, from the keyboard (Show Hover)
    showHover() {
      const at = ta.selectionEnd, p = pointAt(at);
      hoverAt(at, p.x, p.bottom + 4, true);
    },
    hideHover: () => hideHover(),
    // a place's screen coordinates: { x, top, bottom } of its line
    pointAt: (offset = ta.selectionEnd) => pointAt(offset),
    definitionTarget,
    agentEdit,
    agentFlash,
    ready: () => ready,
    // tokens for an older text still apply: moved onto the text now, as VS Code moves them
    setSemanticTokens: (ranges, text) => { if (closed) return; semantic = ranges; semanticText = text; redraw(true); },
    // errors: offsets in forText (the text the server checked, the editor's own when left
    // out), moved onto the text now through what's been typed since; null back to the parse
    setDiagnostics: (errors, forText = ta.value) => {
      if (closed) return;
      const text = ta.value;
      let list = errors === null ? null : [...errors].sort((a, b) => a.from - b.from);
      if (list && forText !== text) {
        const { head, tail } = commonEnds(forText, text);
        list = rebaseDiagnostics(list, { head, tail, before: forText.length }, text.length - forText.length);
      }
      languageErrors = list;
      languageErrorsText = text;
      if (errors === null) { clearDiagnostics(); checkSoon(); } else publishErrors();
    },
    tokenClass,
    lineHeight: () => geom().lh,
    setFinds: (ranges, at = -1) => { findRanges = ranges; findAt = at; paintFinds(); overviewSoon(); },
    setBookmarks: (offsets) => { if (bookmarks.length === offsets.length && bookmarks.every((at, i) => at === offsets[i])) return; bookmarks = offsets; paintMarks(); overviewSoon(); },
    preview: isMd ? (on) => setRendered(on ?? !rendered) : null,
    previewing: () => rendered,
    close: () => {
      closed = true;
      document.removeEventListener('selectionchange', selectionMoved);
      definitionLinks?.dispose();
      hoverIntent.dispose();
      guideResize.disconnect(); hoverResize.disconnect(); cancelAnimationFrame(guideFrame);
      hlAbort?.abort();
      for (const timer of [bigTimer, hlTimer, mdTimer, checkTimer, cursorTimer, agentFade, armed, occurrenceTimer, hoverTimer, restTimer]) clearTimeout(timer);
      hoverAbort?.abort();
      for (const frame of [drawFrame, tellFrame, viewFrame, decoFrame, overviewFrame, minimapFrame, stickyFrame]) cancelAnimationFrame(frame);
      syntax.clear();
      if (sock) sock.close();
      if (codeTabs.get(codeKey(file)) === id) codeTabs.delete(codeKey(file));
      editors.delete(id);
    },
  };
}

// a monospace advance, measured once per element's font
const chWidths = new Map();
function chWidthIn(node) {
  const style = getComputedStyle(node);
  const font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (chWidths.has(font)) return chWidths.get(font);
  const probe = Object.assign(document.createElement('span'), { textContent: '0'.repeat(50) });
  probe.style.cssText = `font:${font};position:absolute;visibility:hidden;white-space:pre`;
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width / 50;
  probe.remove();
  if (w) chWidths.set(font, w);
  return w || 8;
}
// a line's height as laid out: measured over many lines, since engines round each
// line box and a computed 20.15px drifts from the text a few hundred lines down
const lineHeights = new Map();
function lineHeightIn(node) {
  const style = getComputedStyle(node);
  const font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const key = `${font}|${style.lineHeight}`;
  if (lineHeights.has(key)) return lineHeights.get(key);
  const probe = Object.assign(document.createElement('pre'), { textContent: '\n'.repeat(999) + '0' });
  probe.style.cssText = `font:${font};line-height:${style.lineHeight};position:absolute;visibility:hidden;white-space:pre;margin:0;padding:0;border:0`;
  document.body.append(probe);
  const h = probe.getBoundingClientRect().height / 1000;
  probe.remove();
  if (h) lineHeights.set(key, h);
  return h || parseFloat(style.lineHeight) || 18;
}
// bumped as fonts arrive: every editor's kept geometry read again
let fontEpoch = 0;
document.fonts.addEventListener('loadingdone', () => { chWidths.clear(); lineHeights.clear(); fontEpoch++; });

// the editor tabs from the last visit, back on their sessions


export { codeEditor };
