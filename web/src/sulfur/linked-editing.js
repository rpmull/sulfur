// Linked editing, as VS Code's editor.linkedEditing: with the caret in a tag's name, the
// matching closing (or opening) tag's name is edited along with it. Pure: the syntax tree
// (HTML, XML or JSX) says which tag the caret is in and where its partner is; the editor
// keeps the partner's name as a linked cursor (multi-cursor.js).

const OPEN = /^(OpenTag|JSXOpenTag)$/, CLOSE = /^(CloseTag|JSXCloseTag)$/, ELEMENT = /^(Element|JSXElement)$/;
const NAME = /^(TagName|JSXIdentifier|JSXMemberExpression|JSXNamespacedName|JSXBuiltin)$/;

// a tag's name node: TagName in HTML and XML, the first name after the start in JSX
function nameOf(tag) {
  for (let child = tag.firstChild; child; child = child.nextSibling) if (NAME.test(child.name)) return child;
  return null;
}

// the name the caret is in and its partner's: { from, to, partner: { from, to } }, or null
// when the caret isn't in a tag name, the tag has no partner (self-closing, unclosed) or the
// two names differ already
export function linkedTagRange(tree, text, caret) {
  if (!tree) return null;
  for (const side of [-1, 1]) {
    let tag = null;
    for (let node = tree.resolveInner(caret, side); node; node = node.parent) {
      if (OPEN.test(node.name) || CLOSE.test(node.name)) { tag = node; break; }
      if (ELEMENT.test(node.name)) break;
    }
    if (!tag) continue;
    const name = nameOf(tag);
    if (!name || caret < name.from || caret > name.to) continue;
    const element = tag.parent;
    if (!element || !ELEMENT.test(element.name)) continue;
    let partner = null;
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child === tag) continue;
      if ((OPEN.test(tag.name) && CLOSE.test(child.name)) || (CLOSE.test(tag.name) && OPEN.test(child.name))) { partner = child; break; }
    }
    const other = partner && nameOf(partner);
    if (!other || text.slice(name.from, name.to) !== text.slice(other.from, other.to)) return null;
    return { from: name.from, to: name.to, partner: { from: other.from, to: other.to } };
  }
  return null;
}
