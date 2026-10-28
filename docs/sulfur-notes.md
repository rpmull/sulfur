# Notes in Sulfur

Every markdown file in the open folder is a note. Notes made in Sulfur, and the
images pasted into any note, are kept in the folder's own `.sulfur/.notes`:

```
your-folder/
  .sulfur/.notes/
    Ideas.md
    Projects/Roadmap.md
    images/image-20261028-140203.png
```

It is an ordinary folder of markdown, so it travels with the project (commit it,
or add `.sulfur/.notes` to `.gitignore`). Sulfur writes no settings or other
files into it.

## Writing notes

Markdown opens rendered. Click a block to edit its source in place; `Escape`
drops the edit, `Ctrl+Enter` or clicking away keeps it, and **+ add a block**
adds one at the end. `Ctrl+Shift+V` shows the whole source instead, and Sulfur
remembers which you chose. Task list boxes can be ticked in the rendered note.

Edits reach the disk when you save (`Ctrl+S`), unless someone else has the note
open with you; see [the editor](sulfur-editor.md).

| write | renders |
|---|---|
| `[[Ideas]]`, `[[Projects/Roadmap]]` | a link to that note: the name alone finds it anywhere in the folder, nearest first |
| `[[Ideas#Next steps]]`, `[[Ideas\|my ideas]]` | a link to a heading; a link with its own text |
| `![[image-….png]]`, `![[diagram.png\|300]]` | an image, at a width when given one |
| `![[Ideas]]`, `![[Ideas#Next steps]]` | that note (or that heading's section) drawn inside this one |
| `[text](docs/guide.md)`, `![](images/a.png)` | plain markdown links and images, from the note's folder |
| `#tag`, `#area/sub` | a tag; click it to search the folder for it |
| `==highlighted==` | highlighted text |
| `%%a comment%%` | nothing: comments show only in the source |
| `> [!note] Title` and `> [!warning]-` | a callout box; `-` folds it, `+` folds it open. Kinds: note, info, tip, success, question, warning, failure, danger, bug, example, quote, and their usual synonyms |
| `---` properties `---` at the very top | a table of the note's properties; `tags:` show as tags |
| `$x^2$`, `$$\int f$$` | math, by KaTeX |
| a ` ```mermaid ` fence | a Mermaid diagram |

A link to a note that does not exist yet is drawn faded. Click it and Sulfur
writes the note in `.sulfur/.notes` and opens it.

## Pasting images

Paste an image into a note, in the rendered view or the source, and Sulfur saves
it to `.sulfur/.notes/images/` and types `![[its-name.png]]` where you pasted. A
screenshot is named `image-<date>-<time>.png`; a copied image file keeps its own
name. A number is added when the name is taken.

## The Notes view and the graph

The **Notes** view in the activity bar lists the notes in `.sulfur/.notes`, then
the folder's other markdown, with a filter. Its buttons make a note
(**Notes: New Note…**, which takes a name like `Projects/Ideas`), open the graph,
and refresh.

**Notes: Open Graph View** draws every note as a point and every link as a line.
Pick the whole folder or only `.sulfur/.notes`, and show tags, attachments (the
images and other files notes link to), missing notes and orphans. Drag the
background to pan, the wheel (or `+`, `-`, `0`) to zoom, and a point to move it.
Hover a note to see what it links; click it to open it. Type in **Find a note**
to bring one to the middle, and press Enter to open it. The graph redraws when a
note is saved.

## Notes plugins

A notes plugin draws inline code written `name: something` and fences written
` ```name ` in rendered notes. Sulfur's own is **Notes RNG**
(`notes.rng.enabled` turns it off):

| write | rolls |
|---|---|
| `` `rng: 2d6+1` ``, `` `rng: 4d6kh3` ``, `` `rng: 2d20kl1` ``, `` `rng: d%` `` | dice: `kh`/`kl` keep the highest or lowest |
| `` `rng: 1-100` `` | a whole number in the range |
| `` `rng: coin` `` | Heads or Tails |
| `` `rng: pick red \| green \| blue` ``, `` `rng: pick 2 a, b, c` `` | one (or that many) of the list |
| `` `rng: shuffle a, b, c` `` | the list in a random order |
| a ` ```rng ` fence, one entry a line, `3: Goblin` weighting one | one entry of the table |

Click a result to roll again; hover it for how it was rolled. Results are not
written into the note.

Extensions add their own with `api.notes.registerRenderer`; see
[Writing extensions](sulfur-extensions.md#apinotes).
