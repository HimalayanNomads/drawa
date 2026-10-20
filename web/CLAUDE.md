# Guidelines for agents working on Drawa's frontend

`web/` is a Vite + TypeScript frontend with no framework: plain DOM modules. This file covers where frontend code goes and how it plugs in; `DESIGN.md` beside it covers how it looks; the repo root's `CLAUDE.md` covers the checks to run before you finish, the performance rules and the server. Paths here are relative to `web/src/` unless they say otherwise.

## Architecture: where things go

```
web/src/
  main.ts      boot, toolbar, keyboard shortcuts; imports features (importing a feature registers it)
  lib/         no knowledge of the app: api, store (persistence), blobs (IndexedDB), dom helpers, markdown, select (`enhance(select, rich?)`: rich rows, a per-row action button and a search box), fonts, zoom (the figure zoom/pan dialog), connection (server reachability), tabs (which tab owns the stream and the saving), update (the update-available dialog), prefs (your settings file, `~/.drawa/config.json`), settings (the toolbar's Settings panel), completion (its completion-alert control), symbols (code symbols from universal-ctags: lookups, and their Settings control), codeedit (the code editor, CodeMirror with optional Vim motions, loaded on first edit), theme, uimode (full or minimal interface), tooltip, keys (the shortcut registry), actions (the user's changes as data: the undo/redo history and the action log), help (the ? sheet and launch tips), sendkey (which key sends a message), searchbox (a search box over a result list, as the drawer's panes use: the debounce, Enter, Escape and arrow keys, `searchBox(box, spec)`)
  canvas/      the canvas engine
    core/      view (pan, zoom, `changed`), items (the item registry, geometry, stacking, bulk measuring), drag (dragging, resize and edge grips, `track`), itemactions (every item's moves and resizes as actions), placement (free spots, `spawnIn`, fit), window shape, refs (references registry), tools (canvas tools), select, find (Ctrl+K), nav, mode, menu, layers, winkeys, dock, fullview, snapshot
    ink/       stroke (the stroke model, painting, saving, `inkBox`), ink (Draw mode: tools, input, toolbar), inkplace (where a press lands), inktext (text on the drawing), inkrows, inksel, inkactions (the drawing's changes as actions), shapes, shapegeom
    graph/     graph (a session's edges), links (your arrows), sessionwins (a session's Files and commands windows)
  session/     session cards
    card/      session (create, focus, close), render (header, status, appending to the log), saved (layout slices, referable, removable), live (the connection), history, gen (model and effort), mode, notify
    composer/  composer (the message box), drafts, recall, images, uploads, shell, filetypes (which dropped files are bitmaps)
    stream/    stream (rendering the agent's output), asks, notices, tasks
  items/       one folder per kind of canvas item that spans several files, one file for the rest (agent: a sub-agent's window; diagram; doc: a Markdown window, its source edited in lib/codeedit's editor; notes; sketch)
    git/       git (the window), gitrepo (one repository's lists and commit box, a group each for repos in subfolders), gitwt (a repo's worktree dropdown and removal), gitgh (a repo's pull request strip)
    github/    github (the window and its lists), gh (its data, Send to Claude and `publish()`), ghpr, ghissue, ghruns (a pull request, an issue, Actions and checks)
    group/     group (a frame holding windows and drawings), groupgeom (its geometry; groupgeom.check runs without a browser), groupink (the drawings it holds), groupselect (grouping from the selection)
    plan/      plan (plan review), plandiff (what changed between versions)
    image/     image, crop
    snippet/   snippet, pinmarks (a snippet's source stays marked)
    preview/   preview (a project file opened from Ctrl+K), fileedit (editing it in place, saved through `POST /api/file`, and the Vim setting)
  panels/      side panels: drawer (one pane at a time, History or Files; panes register with `drawerPane()`), file tree + inspector, filefind (the Files pane's search: files by name, then code symbols), diffs, defs (a diff's names: go to definition, or in the Git and GitHub windows find references, `/api/refs` with the clicked diff's `repo` (its `data-repo`: a nested repo's or a worktree's commits search that repo), picked ones opening in a small window stuck to the screen), expand (a diff's "show 10 more lines" around its hunks, from the file's new side: `/api/file`, `/api/git/blob` or `/api/gh/blob`)
  types/       data shapes, one file per feature: session (`Session`), canvas (every item's actions), ink (the drawing's actions), notes (a note, and its actions), drawer (the drawer's panes and what each one is)
  styles/      index.css imports tokens.css, then one stylesheet per area
```

The dependency direction is `lib` ← `canvas` ← `items` / `session` / `panels` ← `main`.
- `lib/` never imports from other folders.
- `canvas/` never imports from `items/`. It only imports *types* from `session/` and `panels/`.
- If you need to import upward, add a registry or callback in the lower layer instead (see `onDrop`, `persist`, `referable`).
- `types/` sits outside that order: it holds only types and enums, imports only types (`import type`), and any folder may import from it (its enums are plain values with nothing behind them). A type goes there when it's a data shape: an action kind's (what the log and, later, the server read), a saved one, or one more than one file uses (`Session`). One module's private shapes (`WindowOpts` in `window.ts`) stay in it; its enums don't (see Code conventions). Write each type out one field per line.

Import cycles between feature modules are tolerated only when every cross-use happens inside functions, never at module top level. Don't add top-level code that reads another module's exports.

## The registries: extend by adding, not by editing

The app scales through these registration points. A new feature should plug into them rather than add special cases elsewhere.

| Need | Use | Where |
|---|---|---|
| Something on the canvas | `addItem(el, kind)` for bare nodes, or `makeWindow({...})` for windows | `canvas/core/items.ts`, `canvas/core/window.ts` |
| Survive a reload | `persist(key, save, load, phase)` | `lib/store.ts` |
| Referenceable with `@` or by dropping on a card | `referable(kind, { icon, name, label, status, content, copy })` (`name`: what Ctrl+K calls the kind; `status(el)`: what the item is doing, shown there in its place; `copy(el)`: the text its window's copy button copies, such as Markdown or Mermaid source; no button without it; `picture: true`: its content is an image, which a card whose agent takes text only refuses) | `canvas/core/refs.ts` |
| Recover after the server comes back | `onReconnect(fn)` | `lib/connection.ts` |
| Post-process rendered Markdown (diagrams, anything drawn from a code block) | `onRendered(fn)` | `lib/markdown.ts` |
| Claude can create or edit it (canvas tools) | `creatable(kind, { size, create, update })` | `canvas/core/tools.ts` |
| Removed as part of a deleted selection, without its own confirm | `removable(kind, fn, note?)` (`fn` only if its × button asks first or it has none; `null` means its × is clicked; `note` words the selection's delete confirm) | `canvas/core/select.ts` |
| Off the page for now, may come back (a finished sub-agent's window, a delete Undo can still reverse) | `park(el)` returns what puts it back; `drop(el)` when it's gone for good; `onGone(fn)` for what holds items by id (a group's members), which must skip `parked(el)` removals | `canvas/core/items.ts` |
| Moves along when another item is dragged (a selection, a group's windows) | `moveWith(fn)` (`fn(el)` returns what comes with `el`; `movesWith(el)` follows every answer through; items with `data-locked` stay put) | `canvas/core/drag.ts` |
| Ctrl+K lists project files and code symbols, previews the highlighted one and opens a picked one | `fileOpener(open, peek)` (`open(path, line?)` returns the file's window, open or new, showing `line`; `peek(path, line?)` draws its preview; `openFileAt(path, line)` opens one from elsewhere) | `canvas/core/find.ts` |
| A change the user makes to the canvas (undo and redo it, log it, replay it) | `defineAction(type, { apply, invert })` registers a kind of action: plain JSON (`{ type: ItemActionType.Rename, id, from, to }`), its `type` a member of its feature's enum in `types/` (`ItemActionType`, `InkActionType`, `NoteActionType`; the values are what the log holds, so never change one), items by `data-id` and strokes by `id`, never elements. `applyActions(...a)` makes the change and records it; `recordActions(...a)` records one that already happened (a drag that ended); `asOneUndoStep(fn)` makes everything recorded inside one undo step. Undo applies the inverses, and every applied action (undo, redo and `replayActions` included) is appended to the log (`actionLog()`) that `onAction` listeners read. The log is saved with the layout (key `actions`: the newest that fit in 500k characters); the undo history isn't. `apply` returns false when its target is gone for good, and undo passes over a step like that | `lib/actions.ts` |
| A keyboard shortcut or action users can find (the `?` sheet, Ctrl+K commands, launch tips) | `command({ label, group, keys?, run?, key?, when?, anywhere?, tip? })` (`keys`: tinykeys combos, matched against what the key types or its physical key: `'w'`, `'Shift+Digit1'`, `'$mod+k'`, `'[Shift]+ArrowLeft'`; `run`: runnable from Ctrl+K, and what the keys do; `key(e)`: what the keys do instead, returning `false` to pass the key on; `when(e)`: the keys act only then; `anywhere`: even while typing; `tip`: a launch tip, backticked keys become key caps). The one keydown listener in `lib/keys.ts` dispatches every command's keys, trying commands in registration order; don't add a window keydown listener for a shortcut. A field, menu or dialog with focus still handles its own keys | `lib/keys.ts` |
| Let go of an item when it leaves the canvas (a message box drops its reference chip) | `onForget(fn)` (`fn(el)` runs from `forget(el)`, which every removal already calls) | `canvas/graph/graph.ts` |
| A button on the bar by a selection | `selectionAction(label, tip, fn, when?)` (`when(els)`: shown only for selections it applies to) | `canvas/core/select.ts` |
| Drawings that move along when an item is dragged (the selection's, a group's) | `inkWith(fn)` (`fn(el)` returns canvas strokes; `inkOf(els)` gathers them, each once) | `canvas/ink/inksel.ts` |
| React to drawings just drawn, written or dragged (a group taking in what lands in its frame) | `onInkPlaced(fn)` | `canvas/ink/stroke.ts` |
| Windows made beside an item or at a spot land somewhere else (inside the item's group, or the group whose frame holds the spot) | `spawnIn(fn)` (`fn(from, w, h)`: `from` is an item, or a spot (a drop, a paste); returns the spot or null; `spotBeside()` and `spotAt()` ask it) | `canvas/core/placement.ts` |
| An item whose empty space is canvas (a group's frame): pans in Hand mode, with the middle button or when locked; Shift+drag draws a selection box; a selection box picks it only when it holds all of it | class `frame` on the item | `canvas/core/nav.ts`, `canvas/core/select.ts` |
| Pressing a window's tab to drag it leaves focus where it is (typing carries on after the drag; a message box isn't one) | attribute `data-keep-focus` on the box holding the focus (`codeEditor()` sets it) | `canvas/core/drag.ts` (`draggable`) |

**Adding a new kind of canvas item** should mean one new file in `items/` (a folder `items/<kind>/` once it needs more than one), an import in `main.ts`, and CSS in `styles/items.css`. The item file should:
- Build the element with `makeWindow()`, which handles the folder tab, dragging, collapsing and resizing.
- Call `persist()` for its saved state, and restore a list with `each(list, fn)` from `lib/store.ts` so one bad entry doesn't stop the rest. Binary data (images) goes in IndexedDB via `lib/blobs.ts`, keyed by the item's id; localStorage only holds the layout.
- If its content scales with the window (a picture, a drawing), put it in `inkBox()` from `canvas/ink/stroke.ts`, so pen strokes on it keep their spot at any size, including full view.
- Something Claude should receive that isn't on the canvas (a GitHub pull request) can still be a reference: `referable()` a kind, then `addRef()` a detached element whose dataset says what to fetch at send time (see `sendToClaude` in `items/github/gh.ts`). Such chips have no arrow; clicking one runs the element's `onclick`.
- Text marked in place (like pinned snippets' sources in `items/snippet/pinmarks.ts`) uses the CSS Custom Highlight API, never wrapper elements: the chat re-renders while streaming and skips off-screen rows.
- Give it a `data-id` that is the same after a reload: arrows, pins and canvas tools find items by it.
- Call `referable()` if Claude should be able to receive it (that also makes it readable with `canvas_read`).
- Call `creatable()` if Claude should be able to create it with `canvas_create` (add the kind to that tool's `enum` in `Tools` in `internal/canvastools/canvastools.go`), with an `update` if Claude should be able to edit it with `canvas_update`.
- Its × is `removeButton(label, also?)` from `canvas/core/window.ts`: it offers Undo instead of asking first, and runs `also` (stored data) only once Undo is gone. Don't add a per-kind delete confirm.
- Windows get renaming, pinning (sidebar or screen) and full view from `makeWindow()`; don't rebuild these per kind. Anything that asks "where is this item on screen" should use `liveRect()` (handles pinned, floating and collapsed windows); `rect()` is the canvas geometry that gets saved.
- Add a `--k-<kind>` color in `tokens.css` and one `[data-kind=<kind>]` entry in the kind map at the top of `canvas.css` (it colors windows, Ctrl+K rows, chips and minimap boxes alike). The tab's glyph is the kind's `referable` icon; don't add a per-kind `::before` rule.

If you find yourself adding the new kind to a list in `canvas/core/`, the minimap, `main.ts` restore code or a CSS `:not(...)` selector, stop: that list should be a registry or a `data-kind` rule.

Rules for these registries:
- **Persistence keys are a public format.** Existing users have saved layouts in localStorage (`drawa:canvas:<root>`). Never rename or reshape a key without a loader that still reads the old shape.
- **One tab saves:** only the tab that owns the server (`lib/tabs.ts`) streams and saves; `save()` checks it. A layout that fails to parse is never saved over until the user picks Restore previous canvas or Start fresh.
- **Restore phases:** 0 is settings and positions, 1 is items, 2 is things that attach to items (ink). A loader may be async; the next one waits for it.
- **Item state goes in `data-state`,** not in ad-hoc classes (`busy`, `edit`, `approved`...). The minimap and CSS both key off `data-kind` + `data-state`.
- **Two canvas-wide attributes** belong to no kind, so they sit beside `data-state`: `data-hidden-in` (inside a collapsed group: use `hidden(el)` from `canvas/core/items.ts`, which placement, arrows, Ctrl+K and the selection skip) and `data-locked` (stays put: `movesWith()` and selection nudges leave it).
- **The user's changes are actions.** Moving, resizing, renaming, collapsing and deleting a window, notes, and the drawing all record actions, which is what Ctrl+Z undoes and what the action log holds. A new kind of change registers its own action with `defineAction` next to the code that does it, rather than adding another undo stack. Changes that follow from another one (a session folding its windows, a group settling, a restore) aren't recorded: undoing the cause brings them back. ponytail: Claude's canvas tools and the remaining item kinds' own edits aren't actions yet.
- **`data-state="editing"`** means the item holds a draft the user hasn't finished (a note being typed, a diagram source that doesn't parse yet); `canvas_update` refuses such items, as it does any item with focus in one of its text fields.

## Code conventions

- **Match the surrounding code:** short functions, early returns, `make()` / `iconButton()` / `button()` from `lib/dom.ts` rather than hand-built buttons, and `confirmBox()` rather than `confirm()`. Messages go through `toast()` (a few seconds) or `notice()` (stays until you remove it: for states that last); both stack, so never position one by hand. Reuse the small helpers there before writing another: `shortcutOk(e)` / `typing(t)` for keyboard guards, `keepOnScreen()` for anything floating, `revealIn()` to scroll a marked line (`data-reveal`) into view, `closestAt()` for hit-testing through overlays, `focusedIn()` to hand focus back after moving a window in the page, `perFrame()` for once-a-frame work, `spinWhile(button, work)` for a refresh button's icon while it reloads; `watched(el)` in `canvas/core/items.ts` before polling for a window (page visible, not collapsed, on screen); and `edgeGrip()` / `track()` in `canvas/core/drag.ts` for drag handles. No native browser dialogs or `alert`.
- **Names say what a thing is.** Variables, parameters, functions, types and generics get meaningful names: `action`, `stroke`, `item`, `offsetX`, `MAX_UNDO_STEPS`, `StrokeSnapshot`, `SpecificAction`, not `a`, `s`, `el`, `dx`, `MAX`, `Shape`, `A`. No single letters and no cryptic abbreviations in new or changed code, loop indexes included (`index`, not `i`). Two exceptions: keys of a saved format already in users' layouts (a stroke's `p` and `t`, a note's `w`) keep their names, since renaming them breaks saved canvases; and older code you're not otherwise touching isn't renamed in an unrelated change.
- **Related values get a type or an enum, not loose strings.** A fixed set of values (kinds of action, modes, states) is an `enum` (`ItemActionType.Rename`, not `'item.rename'` written out at each use). Fields that belong together are a named type, written one field per line, rather than parallel variables or an inline `{ ... }` repeated in several places. Every `enum` goes in `types/`, one file per feature, even one only a single module uses: never declare one in `main.ts` or a feature module. Data shapes go there when they're shared or saved (see `types/` above).
- **Keep modules small.** When a file passes about 350 lines or does two jobs, split it by responsibility the way `session/` is split: card, composer, stream, asks and live are separate modules.
- **No new dependency** for what a few lines or the platform can do. Big libraries (Mermaid, Excalidraw, html-to-image) are loaded with dynamic `import()` on first use. Keep it that way.
- **Loose typing only where the CLI owns the schema.** Claude's stream-json messages are `Record<string, any>`. Type everything else.

## When you change the rules

Update this file whenever you add a folder, a registry, or a frontend rule, `DESIGN.md` for a styling rule, and the architecture diagram in `CONTRIBUTING.md` if the big picture changes.
