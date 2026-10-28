import test from 'node:test';
import assert from 'node:assert/strict';
import { noteLinks, noteTags, linkIndex, resolveLink, noteGraph, pastedImageName, rngRoll, diceRoll, rngTable, joinPath, NOTES_DIR } from '../src/sulfur/notes.js';

// the same numbers each time: 0, 1, 2… wrapped to what's asked
const counting = () => { let i = 0; return (n) => i++ % n; };

test('a note’s links and tags, none from its code or comments', () => {
  const text = '---\ntags: [alpha, "beta"]\n---\nSee [[Ideas]], [[Deep#Part|part]] and ![[pic.png|200]]\n[guide](docs/guide.md) [web](https://x.y) [here](#top)\n`[[Code]]` %%[[Hidden]]%% #gamma x#no\n```\n[[Fenced]] #fenced\n```';
  assert.deepEqual(noteLinks(text).map((l) => [l.target, l.embed, !!l.path]), [['Ideas', false, false], ['Deep', false, false], ['pic.png', true, false], ['docs/guide.md', false, true]]);
  assert.deepEqual(noteTags(text).sort(), ['alpha', 'beta', 'gamma']);
});

test('links are found from the note, the top, then by name nearest first', () => {
  const idx = linkIndex(['p/README.md', `p/${NOTES_DIR}/Ideas.md`, `p/${NOTES_DIR}/sub/Deep.md`, `p/${NOTES_DIR}/images/shot.png`, 'p/docs/guide.md', 'p/other/guide.md', 'p/docs/sub/x.md']);
  const deep = `p/${NOTES_DIR}/sub/Deep.md`;
  assert.equal(resolveLink('Ideas', deep, idx, 'p'), `p/${NOTES_DIR}/Ideas.md`);
  assert.equal(resolveLink('ideas.md', deep, idx, 'p'), `p/${NOTES_DIR}/Ideas.md`);
  assert.equal(resolveLink('shot.png', 'p/README.md', idx, 'p'), `p/${NOTES_DIR}/images/shot.png`);
  assert.equal(resolveLink('docs/guide', 'p/README.md', idx, 'p'), 'p/docs/guide.md');
  assert.equal(resolveLink('guide', 'p/docs/sub/x.md', idx, 'p'), 'p/docs/guide.md');
  assert.equal(resolveLink('../guide.md', 'p/docs/sub/x.md', idx, 'p'), 'p/docs/guide.md');
  assert.equal(resolveLink('Nowhere', 'p/README.md', idx, 'p'), null);
  assert.equal(joinPath('a/b', '../../..'), '');
});

test('the graph links each pair once, with missing notes, tags and files when asked', () => {
  const idx = linkIndex(['p/a.md', 'p/b.md', 'p/i.png']);
  const notes = [{ path: 'p/a.md', text: '[[b]] [[b]] [[ghost]] ![[i.png]] #t' }, { path: 'p/b.md', text: '[[a]]' }];
  const plain = noteGraph(notes, idx, { root: 'p' });
  assert.deepEqual(plain.nodes.map((n) => [n.id, n.kind, n.degree]), [['p/a.md', 'note', 2], ['p/b.md', 'note', 1], ['missing:ghost', 'missing', 1]]);
  assert.equal(plain.links.length, 2);
  const all = noteGraph(notes, idx, { root: 'p', tags: true, files: true, missing: false });
  assert.deepEqual(all.nodes.map((n) => n.kind).sort(), ['file', 'note', 'note', 'tag']);
});

test('a pasted image gets its own name or a dated one, never one taken', () => {
  const at = new Date(2026, 9, 28, 14, 2, 3);
  assert.equal(pastedImageName('image/png', 'image.png', at), 'image-20261028-140203.png');
  assert.equal(pastedImageName('image/png', '', at, (n) => n === 'image-20261028-140203.png'), 'image-20261028-140203-1.png');
  assert.equal(pastedImageName('image/jpeg', 'My: [shot].JPG', at), 'My- -shot-.JPG');
  assert.equal(pastedImageName('image/webp', '', at).endsWith('.webp'), true);
});

test('notes-rng rolls dice, ranges, coins, picks and tables', () => {
  assert.deepEqual(diceRoll('2d6+1', counting()), { text: '4', detail: '2d6+1: [1, 2] +1 = 4' });
  assert.equal(diceRoll('4d6kh3', () => 5).text, '18');
  assert.equal(diceRoll('2d20kl1-1', counting()).text, '0');
  assert.equal(rngRoll('d%', () => 99).text, '100');
  assert.equal(rngRoll('5-10', () => 0).text, '5');
  assert.equal(rngRoll('10 to 5', () => 5).text, '10');
  assert.equal(rngRoll('coin', () => 1).text, 'Heads');
  assert.equal(rngRoll('pick a | b | c', () => 2).text, 'c');
  assert.equal(rngRoll('pick 2 a, b, c', () => 0).text, 'a, b');
  assert.equal(rngRoll('[x, y]', () => 1).text, 'y');
  assert.equal(rngRoll('shuffle a, b, c', () => 0).text, 'b, c, a');
  assert.throws(() => rngRoll('banana'), /not a roll/);
  assert.throws(() => rngRoll('2000d6'), /too many dice/);
  assert.equal(rngTable('3: Goblin\n- Orc\n# a comment\n1: Dragon', () => 3).text, 'Orc');
  assert.throws(() => rngTable('# nothing'), /empty/);
});
