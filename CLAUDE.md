# Guidelines for agents working on Drawa

Drawa is a browser canvas around coding agents: the Claude Code CLI, OpenCode for any other provider, OpenAI's Codex CLI, and Google's Antigravity CLI (`agy`, headless, so without approvals). `main.go` + `internal/` run their processes (one per session card, behind the backend registry in `internal/live`) and serve a JSON API. `web/` is a Vite + TypeScript frontend with no framework: plain DOM modules. Read `README.md` for how to run it, `CONTRIBUTING.md` for the development setup and an architecture overview, and `PRODUCT.md` for the design brief. This file covers how to change the code without making it harder to change next time.

## Before you finish any change

1. `cd web && npm run fix && npm run build`. `fix` runs Biome (`biome.json`): it formats the TS (single quotes, semicolons) and applies safe lint fixes; `npm run lint` checks without writing. `build` runs `tsc` and the Vite build. All must pass with no new errors. Biome sorts imports, except in the files that start with `biome-ignore-all assist/source/organizeImports` (`main.ts` and the others whose import order decides which module evaluates first, and with it the order things register: the `?` sheet, restore within a phase, Ctrl+K kinds). Keep their imports in the order they are; a new import in a sorted file can still move a module's first evaluation, so check that registration order still matches when you add one. Compact one-liners (`list.forEach(f => f())`, `x ??= load()`) are house style, so the rules against them are off. After touching `main.go` or `internal/`, also run `go build ./...` and `go test ./...` from the repo root.
2. Look at what you changed. For anything visible, take a screenshot in headless Chromium in **both** light and dark themes (`Emulation.setEmulatedMedia` with `prefers-color-scheme`). You can import modules straight from the dev server to set up state, e.g. `await import('/src/items/diagram.ts')`.
3. Reload the page and check that your change survives restore from the saved layout.
4. Say plainly what you verified and what you didn't.

## Architecture: where things go

```
web/src/
  main.ts      boot, toolbar, keyboard shortcuts; imports features (importing a feature registers it)
  lib/         no knowledge of the app: api, store (persistence), blobs (IndexedDB), dom helpers, markdown, select (`enhance(select, rich?)`: rich rows, a per-row action button and a search box), fonts, zoom (the figure zoom/pan dialog), connection (server reachability), tabs (which tab owns the stream and the saving), update (the update-available dialog), prefs (your settings file, `~/.drawa/config.json`), settings (the toolbar's Settings panel), symbols (code symbols from universal-ctags: lookups, and their Settings control), codeedit (the code editor, CodeMirror with optional Vim motions, loaded on first edit), theme, uimode (full or minimal interface), tooltip, keys (the shortcut registry), actions (the user's changes as data: the undo/redo history and the action log), help (the ? sheet and launch tips), sendkey (which key sends a message)
  canvas/      the canvas engine
    core/      view (pan, zoom, `changed`), items (the item registry, geometry, stacking, bulk measuring), drag (dragging, resize and edge grips, `track`), itemactions (every item's moves and resizes as actions), placement (free spots, `spawnIn`, fit), window shape, refs (references registry), tools (canvas tools), select, find (Ctrl+K), nav, mode, menu, layers, winkeys, dock, fullview, snapshot
    ink/       stroke (the stroke model, painting, saving, `inkBox`), ink (Draw mode: tools, input, toolbar), inkplace (where a press lands), inktext (text on the drawing), inkrows, inksel, inkactions (the drawing's changes as actions), shapes, shapegeom
    graph/     graph (a session's edges), links (your arrows), sessionwins (a session's Files and commands windows)
  session/     session cards
    card/      session (create, focus, close), render (header, status, appending to the log), saved (layout slices, referable, removable), live (the connection), history, gen (model and effort), mode, notify
    composer/  composer (the message box), drafts, recall, images, uploads, shell
    stream/    stream (rendering the agent's output), asks, notices, tasks
  items/       one folder per kind of canvas item that spans several files, one file for the rest (agent: a sub-agent's window; diagram; doc: a Markdown window, its source edited in lib/codeedit's editor; notes; sketch)
    git/       git (the window), gitrepo (one repository's lists and commit box, a group each for repos in subfolders), gitwt (a repo's worktree dropdown and removal), gitgh (a repo's pull request strip)
    github/    github (the window and its lists), gh (its data, Send to Claude and `publish()`), ghpr, ghissue, ghruns (a pull request, an issue, Actions and checks)
    group/     group (a frame holding windows and drawings), groupgeom (its geometry; groupgeom.check runs without a browser), groupink (the drawings it holds), groupselect (grouping from the selection)
    plan/      plan (plan review), plandiff (what changed between versions)
    image/     image, crop
    snippet/   snippet, pinmarks (a snippet's source stays marked)
    preview/   preview (a project file opened from Ctrl+K), fileedit (editing it in place, saved through `POST /api/file`, and the Vim setting)
  panels/      side panels: file tree + inspector, diffs, defs (a diff's names: go to definition, or in the Git and GitHub windows find references, `/api/refs` with the clicked diff's `repo` (its `data-repo`: a nested repo's or a worktree's commits search that repo), picked ones opening in a small window stuck to the screen), expand (a diff's "show 10 more lines" around its hunks, from the file's new side: `/api/file`, `/api/git/blob` or `/api/gh/blob`)
  types/       data shapes, one file per feature: session (`Session`), canvas (every item's actions), ink (the drawing's actions), notes (a note, and its actions)
  styles/      index.css imports tokens.css, then one stylesheet per area
```

The dependency direction is `lib` ← `canvas` ← `items` / `session` / `panels` ← `main`.
- `lib/` never imports from other folders.
- `canvas/` never imports from `items/`. It only imports *types* from `session/` and `panels/`.
- If you need to import upward, add a registry or callback in the lower layer instead (see `onDrop`, `persist`, `referable`).
- `types/` sits outside that order: it holds only types and enums, imports only types (`import type`), and any folder may import from it (its enums are plain values with nothing behind them). A type goes there when it's a data shape: an action kind's (what the log and, later, the server read), a saved one, or one more than one file uses (`Session`). One module's private shapes (`WindowOpts` in `window.ts`) stay in it. Write each type out one field per line.

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
| A change the user makes to the canvas (undo and redo it, log it, replay it) | `defineAction(type, { apply, invert })` registers a kind of action: plain JSON (`{ type: ItemActionType.Rename, id, from, to }`), its `type` a member of its feature's enum in `types/` (`ItemActionType`, `InkActionType`, `NoteActionType`; the values are what the log holds, so never change one), items by `data-id` and strokes by `id`, never elements. `doActions(...a)` makes the change and records it; `recordActions(...a)` records one that already happened (a drag that ended); `together(fn)` makes everything recorded inside one undo step. Undo applies the inverses, and every applied action (undo, redo and `replay` included) is appended to the log (`actionLog()`) that `onAction` listeners read. The log is saved with the layout (key `actions`: the newest that fit in 500k characters); the undo history isn't. `apply` returns false when its target is gone for good, and undo passes over a step like that | `lib/actions.ts` |
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

- **Match the surrounding code:** short functions, early returns, `make()` / `iconButton()` / `button()` from `lib/dom.ts` rather than hand-built buttons, and `confirmBox()` rather than `confirm()`. Messages go through `toast()` (a few seconds) or `notice()` (stays until you remove it: for states that last); both stack, so never position one by hand. Reuse the small helpers there before writing another: `shortcutOk(e)` / `typing(t)` for keyboard guards, `keepOnScreen()` for anything floating, `revealIn()` to scroll a marked line (`data-reveal`) into view, `closestAt()` for hit-testing through overlays, `focusedIn()` to hand focus back after moving a window in the page, `perFrame()` for once-a-frame work; `watched(el)` in `canvas/core/items.ts` before polling for a window (page visible, not collapsed, on screen); and `edgeGrip()` / `track()` in `canvas/core/drag.ts` for drag handles. No native browser dialogs or `alert`.
- **Keep modules small.** When a file passes about 350 lines or does two jobs, split it by responsibility the way `session/` is split: card, composer, stream, asks and live are separate modules.
- **No new dependency** for what a few lines or the platform can do. Big libraries (Mermaid, Excalidraw, html-to-image) are loaded with dynamic `import()` on first use. Keep it that way.
- **Comments say why,** not what. A deliberate shortcut gets a `ponytail:` comment naming its limit and the upgrade path.
- **Loose typing only where the CLI owns the schema.** Claude's stream-json messages are `Record<string, any>`. Type everything else.
- **Don't touch the private stuff:** no hard-coded paths, and no secrets or user data in the repo.

## Styling rules

- **Themes and color schemes:**
  - `lib/theme.ts` puts light/dark on `<html data-theme>` and the chosen scheme on `data-scheme`, saved in your settings file through `lib/prefs.ts`. The inline script in `index.html` does the same before first paint from `lib/prefs.ts`'s last copy, so keep its defaults in sync.
  - A scheme is 13 base colors (`--c-*`) in `styles/schemes.css`. `tokens.css` derives every UI color from them.
  - To add a scheme: one block in `schemes.css` plus one line in `SCHEMES` in `theme.ts`. Keep `--c-muted` at 4.5:1 or better against `--c-bg`, `--sel`, `--hover` and `--code`. `cd web && npm run contrast` checks every scheme's text, button, focus-ring and field-border pairs, and fails if one is under its minimum.
  - Feature CSS uses only the derived tokens, never `--c-*` and never a `prefers-color-scheme` query.
  - Anything drawn with colors baked in (Mermaid, Excalidraw previews) reads `isDark()` and redraws in `onTheme()`.
- **All values come from `styles/tokens.css`:**
  - Colors: derived from the active scheme, including the code highlighting colors (`--syn-*`).
  - Radius scale: `--r-tab`, `--r-box`, `--r-ctl`, and `--r-tag` for small labels (inline code, badges, swatches).
  - z scale: `--z-float`, `--z-panel`, `--z-menu` for overlays; `--z-under`, `--z-sticky`, `--z-over` for stacking inside a window or panel.
  - Kind colors: `--k-*`.
  - Palette hues as text (`--read`, `--edit`, `--write`, `--run`, `--add`, `--del`, `--warn`, `--danger`, `--accent-text`, `--syn-*`) have their lightness clamped to stay 4.5:1 on `--bg`. Strokes and fills (arrows, dots, pen colors) use the raw `--*-hue` tokens; text on an accent or danger fill uses `--on-accent` / `--on-danger`.
  - Input borders use `--field-edge` (3:1 on `--bg`), their focus state `--focus`; `--line` and `--line-2` are dividers.
  - Don't write raw colors, radii or z-index numbers in feature CSS.
- **Shape language:**
  - Windows are folders. A tab on the top-left carries the title and buttons, and a concave shoulder joins it to a nearly square body.
  - Surfaces are square-cut (`--r-box`). The tab curve is the only prominent round corner.
  - Don't bring back 8–14px rounded cards, rounded boxes nested in rounded boxes, or pills. The user has rejected these repeatedly.
- **Window states change `--edge` only;** `window.css` draws the outline from it (no blurred shadows on windows). Don't restyle `.win-h` or `.win-b` per feature beyond what's in the kind's own section.
- **In the minimal interface (`ui` in the settings file, `lib/uimode.ts`), a window's tab shows only when you reach for it** (hovered, focused, selected, dragged; always when collapsed, pinned, floating or in full view). A state that waits on the user keeps its tab up, in the kind's own section, as `.card[data-state=asking]` does in `session.css`; don't show tabs for states that don't need the user.
- **Color carries meaning:** read, edit, write and run are the action colors, and everything else is neutral. Mix tints with `color-mix(in oklab, …)`; oklch mixing shifts hues.
- **Input fields must look like input fields:** a visible border, a text cursor, and a clear focus state.
- **No native-looking controls:** `<select>` goes through `enhance()` from `lib/select.ts`.
- **Every animation has a `prefers-reduced-motion` fallback.** CSS ones live at the end of `index.css`; animations started from script check `reducedMotion()` from `lib/dom.ts`.
- **Layouts must work from phone width up.** Check at 390px.

## Performance rules

These are measured, not guessed. Reopening a 27MB transcript went from 7.6s to 0.5s, and streaming went from about 30fps to 60fps, by following them. Re-measure with a real large transcript after touching these paths.

- **Never read layout inside a loop** (`scrollHeight`, `offsetWidth`, `getBoundingClientRect`, `getComputedStyle` for sizes). Bulk work such as replaying a transcript sets `S.replaying` and `bulk(true)` from `canvas/core/items.ts` (new windows get spots from one measurement): `appendToLog()`, `follow()` and `renderCard()` skip their layout reads, and one final pass settles everything. `quietPings(true)` does the same for attention flashes.
- **Streaming renders incrementally.** Complete markdown blocks are rendered once; only the unfinished tail re-renders each frame (`streamText` in `session/stream/stream.ts`). Don't go back to re-rendering the whole buffer.
- **Animations must not force layout.** Use the Web Animations API (`el.animate`), as `ping()` does, not the remove-class/`offsetWidth`/add-class trick.
- **No decorative glows or big blurred shadows** on canvas windows. They cost paint on every pan and zoom frame, and the user rejected them visually too. Show state with `--edge` and the tab's top line.
- **Long lists skip what's off-screen:** log entries use `content-visibility: auto`. Keep new per-entry elements as direct children of `.log`.
- **The server sends only what the page shows.** `Clip()` in `internal/sessions/sessions.go` drops images returned by tools and thinking signatures, trims tool outputs and tool inputs to 20k characters, and turns images you sent into `/api/images` addresses. It runs on transcripts and on big live lines (`Trimmed()`, which also drops the CLI's duplicate `tool_use_result`). The live buffer per card is capped by lines and bytes (`live.Keep`/`live.KeepBytes`). New fields should be trimmed the same way.
- **One stream per page.** Browsers allow ~6 connections per host over HTTP/1.1, so never add a long-lived request per card or per window: the page reads every card over one `/api/events` stream (`session/card/live.ts`).
- **Big libraries load on first use** (Mermaid, Excalidraw, html-to-image, CodeMirror) with a dynamic `import()`.

## Server (`main.go`, `internal/`)

`main.go` is the thin entry point (the self-restart loop and `main()`; the project folder argument is read in `internal/config`; a GitHub URL there maps to a cached clone that `internal/remote` makes, and sets `config.Cloned`; unless the user answers y to the trust prompt, `config.Untrusted()` makes every agent call skip the project's own settings (`--setting-sources user`, `OPENCODE_DISABLE_PROJECT_CONFIG`, Codex's `projectArgs()`), so gate any new agent spawn on it). Everything it does lives in `internal/`, one file (or small file group) per responsibility. Add a new domain the same way: one new package in `internal/`, imported where its routes or callers need it. `go test ./...` covers the riskiest small pieces (GitHub check merging, session/transcript loading, the canvas MCP endpoint, the multiplexed event stream) the way `test_server.py` used to.

- Stdlib only (`net/http`). No third-party Go modules — `go.mod` should stay dependency-free the same way the old `server.py` was.
- **Security checks are not optional:**
  - Every request checks `Host` (`config.Hosts`).
  - POSTs require a matching `Origin` (`config.Origins`).
  - Every file path goes through `config.Inside()` so it can't escape the project root.
  - POST bodies must be `application/json` (anything else gets 415), so a plain cross-site form can't post.
  - Cross-site GETs to `/api/*` (`Sec-Fetch-Site: cross-site`) are refused.
  - The Vite dev origin (`:5173`) is trusted only when `DRAWA_DEV=1`.
  - Any new endpoint needs the same checks.
- **Your settings** (`~/.drawa/config.json`, the same for every project) are `internal/prefs`: `Defaults` and one check per key, read and changed through `/api/prefs`. A new setting is a key in `Defaults` and `checks` there and in `DEFAULTS` in `lib/prefs.ts`; its module reads `prefs()` and reacts in `onPrefs()`. A file that doesn't parse is never written over, and keys it doesn't know are kept (people edit it by hand). Per-browser choices (fonts, the send key) stay in localStorage.
- **Repos in subfolders:** `gitx.Repos()` lists the project's own repo and the ones found below it (`gitx.Nested()`). Every git and gh call takes one of them (`gitx.Opts.Repo`, `github.Gh(repo, …)`, a `repo` query or body field from the page) and refuses any other folder (`gitx.Check`); gh runs inside that repo's folder, so it reads that repo's remote. Their linked worktrees are accepted as `repo` too (id relative to Root, or absolute outside it): listed by `git worktree list` and kept only when they check out against the main repo's git dir, as git's own validation does (`validWorktree`); their file paths are checked with `config.Within` against the worktree. The status marks a repo `worktreesFailed` when its list couldn't be read. Removal is the `worktree-remove` op, never the main checkout, a nested repo or a locked worktree (`dirty` in its reply when git refused over changes).
- **Code symbols** are `internal/symbols`: universal-ctags run over git's file list (`filesx.List()`), cached like the file list and rebuilt in the background when stale, served by `/api/symbols` (`?q=` fuzzy, `?def=` exact, neither: whether it's installed). ctags is optional and found at runtime; without it, or with `symbols: "off"` in your settings, every lookup is an empty list, so callers never branch on "not installed". It always runs with `--options=NONE` first, so a cloned project's `.ctags.d` can't change what it does.
- **GitHub writes** are ops in the `ops` map in `internal/github/ops.go` (op name to handler, one file per area). A new one validates every number, branch, label and login before `gh` runs, and passes free text on stdin or as a single `--flag=value` argument. On the page every write goes through `publish()` in `items/github/gh.ts`, a confirm that says what gets published, as whom and where. They're not canvas tools: letting Claude publish under the user's account is a separate trust decision.
- **Canvas tools:** each card's Claude gets an MCP server at `/mcp/<card>/<token>` (in `live.Live`). The token is per process, and requests carrying an `Origin` are refused, so only that process can call it. Calls are relayed to the newest page reading the card's stream and answered via `/api/canvas`. Tool definitions live in `canvastools.Tools`, and `canvastools.Instructions` (sent as the MCP server's `instructions`, which Claude Code puts in the system prompt) tells the agent when to reach for the canvas unprompted; reading is auto-allowed with `--allowedTools`, while changing things goes through the normal approval flow.
- One long-lived `claude -p` process per card (`live.Live`), speaking the stream-json protocol over merged stdout/stderr pipes, read with a buffered line scanner. The page reads all its cards' output over one `/api/events?page=…&c=cid:line:gen,…` stream (lines tagged `_c` with the card, in `server/events.go`) and answers control requests via `/api/respond`. Don't break re-attaching: a reload must pick up a running session where it left off, including the message being streamed (`Live.openMsg`, via `Live.Snapshot()`). `live.Start` (`internal/live/registry.go`) is the one way to get or spawn a card's process: with `DRAWA_MAX_LIVE` set it caps live processes, closing the least recently used idle one. A card with a turn, an open approval or a background agent still running is never idle (`Live.working()`), for the cap or the reaper. Lines the page must not count toward its position carry `"_r":1` (re-sent asks, `_gap`). GET routes live in the `getRoutes` table in `server/handler.go`; add new ones there.
- **Agent backends:** a card's agent is a backend registered with `live.Register(name, live.Kind{...})` (`internal/live/backend.go`); `claude.go` is the first. A new backend is one package that registers from its `init()` and is imported from `main.go`. It emits the wire format described in `live/wire.go` (the subset of Claude's stream-json the page reads, with Claude's tool names and input fields) through its `Sink`, so the page and `/api/events` never branch on backend; its golden tests run translated fixtures through `live.CheckWire`. A backend that translates its own events reuses `live.Turn` (`internal/live/turn.go`) for the message, block and result bookkeeping. An error that means the agent turned the request down while its process is fine is a `live.Refused` (anything else marks the process gone). `Kind.Blurb` is its line in menus. The page closes an ask when the backend sends `control_cancel_request` for it. Reasoning effort reaches a backend as `Spec.Effort`; one that takes it per turn implements `live.EffortSetter` (Codex's `turn/start` `effort`, OpenCode's model `variant`), otherwise `live.Start` replaces the idle process on a change. Non-Claude levels are per model: each model entry in its meta may carry `efforts`, and a send whose effort the model doesn't list goes without one (`live.Accepts`). A backend that can't take one at all sets `Kind.NoEffort` to a link saying why; the page shows a disabled effort picker with a Read more link to it. One that can't take images sets `Kind.TextOnly`; its cards refuse pasted, dropped and referenced pictures with a toast. If it can take back a queued message it hasn't read yet (Claude's `cancel_async_message`), it implements `live.Unsender` and sets `Kind.Unsend`; the page then shows edit and delete on queued bubbles (`/api/unsend`). It gets the card's canvas MCP URL in `Spec.MCPURL` and must hand it over without putting it in argv (the URL carries the card's token). The page knows the agents only through `lib/agents.ts` (`GET /api/agents`, and each one's models from `/api/meta?backend=`): a card carries its `backend` (saved only when it isn't claude, so older layouts load unchanged), menus list installed agents and hide themselves while there's only one, and copy names the card's agent with `who()`. Commit messages and PR descriptions go through `live.Write` (a backend's `OneShot`), never a hard-coded CLI. Card ops, the Git window's `message` op, the GitHub window's `draft` op, `/api/meta`, `/api/sessions` and `/api/session` take an optional `backend` (none means `live.Default`, what pages from before backends send); preflight requires at least one registered backend's CLI.
- **Concurrency:** a `Live`'s buffer is guarded by its own mutex; `live.Changed` (a `Broadcaster`, in `internal/live/broadcast.go`) is the one global wakeup signal, bumped by every `Live.Push()`. It stands in for Python's `threading.Condition` and is what the `/api/events` stream and `live.Meta()` block on — reuse it rather than adding another signaling mechanism.
- The server rebuilds (`go build`) and re-execs itself (`syscall.Exec`) when a `.go` file changes; a build that fails to compile keeps the old server running, same spirit as the old syntax-check-before-restart. Test changes against a separate port rather than killing the user's running instance.

## When a request is vague

- Prefer the smallest change that fits these rules. When a request needs a new abstraction, add it as a registry in the lower layer, and move the existing cases onto it in the same change, so the codebase never has two ways of doing one thing.
- Update this file whenever you add a folder, a registry, or a rule, and the architecture diagram in `CONTRIBUTING.md` if the big picture changes.
