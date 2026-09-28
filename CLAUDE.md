# Guidelines for agents working on Drawa

Drawa is a browser canvas around coding agents: the Claude Code CLI, OpenCode for any other provider, and OpenAI's Codex CLI. `main.go` + `internal/` run their processes (one per session card, behind the backend registry in `internal/live`) and serve a JSON API. `web/` is a Vite + TypeScript frontend with no framework: plain DOM modules. Read `README.md` for how to run it, `CONTRIBUTING.md` for the development setup and an architecture overview, and `PRODUCT.md` for the design brief. This file covers how to change the code without making it harder to change next time.

## Before you finish any change

1. `cd web && npm run build`. This runs `tsc` and the Vite build. Both must pass with no new errors. After touching `main.go` or `internal/`, also run `go build ./...` and `go test ./...` from the repo root.
2. Look at what you changed. For anything visible, take a screenshot in headless Chromium in **both** light and dark themes (`Emulation.setEmulatedMedia` with `prefers-color-scheme`). You can import modules straight from the dev server to set up state, e.g. `await import('/src/items/diagram.ts')`.
3. Reload the page and check that your change survives restore from the saved layout.
4. Say plainly what you verified and what you didn't.

## Architecture: where things go

```
web/src/
  main.ts      boot, toolbar, keyboard shortcuts; imports features (importing a feature registers it)
  lib/         no knowledge of the app: api, store (persistence), blobs (IndexedDB), dom helpers, markdown, select, fonts, zoom (the figure zoom/pan dialog), connection (server reachability), update (the update-available dialog), theme, tooltip
  canvas/      the canvas engine: view, items, window shape, graph edges, ink, references registry
  session/     session cards: card, composer, stream rendering, asks, live connection, history
  items/       one file per kind of canvas item: notes, sketch, diagram, plan, snippet, git, image, github (+ gh.ts, its data and Send to Claude), agent (a sub-agent's window), doc (a Markdown window), preview (a project file opened from Ctrl+K), group (a frame holding windows; + groupgeom.ts, its geometry)
  panels/      side panels: file tree + inspector, diffs
  styles/      index.css imports tokens.css, then one stylesheet per area
```

The dependency direction is `lib` ← `canvas` ← `items` / `session` / `panels` ← `main`.
- `lib/` never imports from other folders.
- `canvas/` never imports from `items/`. It only imports *types* from `session/` and `panels/`.
- If you need to import upward, add a registry or callback in the lower layer instead (see `onDrop`, `persist`, `referable`).

Import cycles between feature modules are tolerated only when every cross-use happens inside functions, never at module top level. Don't add top-level code that reads another module's exports.

## The registries: extend by adding, not by editing

The app scales through these registration points. A new feature should plug into them rather than add special cases elsewhere.

| Need | Use | Where |
|---|---|---|
| Something on the canvas | `addItem(el, kind)` for bare nodes, or `makeWindow({...})` for windows | `canvas/canvas.ts`, `canvas/window.ts` |
| Survive a reload | `persist(key, save, load, phase)` | `lib/store.ts` |
| Referenceable with `@` or by dropping on a card | `referable(kind, { icon, name, label, content })` (`name`: what Ctrl+K calls the kind) | `canvas/refs.ts` |
| Recover after the server comes back | `onReconnect(fn)` | `lib/connection.ts` |
| Post-process rendered Markdown (diagrams, anything drawn from a code block) | `onRendered(fn)` | `lib/markdown.ts` |
| Claude can create or edit it (canvas tools) | `creatable(kind, { size, create, update })` | `canvas/tools.ts` |
| Removed as part of a deleted selection, without its own confirm | `removable(kind, fn, note?)` (`fn` only if its × button asks first or it has none; `null` means its × is clicked; `note` words the selection's delete confirm) | `canvas/select.ts` |
| Moves along when another item is dragged (a selection, a group's windows) | `moveWith(fn)` (`fn(el)` returns what comes with `el`; `movesWith(el)` follows every answer through; items with `data-locked` stay put) | `canvas/canvas.ts` |
| Ctrl+K lists project files, previews the highlighted one and opens a picked one | `fileOpener(open, peek)` (`open(path)` returns the file's window, open or new; `peek(path)` draws its preview) | `canvas/find.ts` |
| A button on the bar by a selection | `selectionAction(label, tip, fn, when?)` (`when(els)`: shown only for selections it applies to) | `canvas/select.ts` |

**Adding a new kind of canvas item** should mean one new file in `items/`, an import in `main.ts`, and CSS in `styles/items.css`. The item file should:
- Build the element with `makeWindow()`, which handles the folder tab, dragging, collapsing and resizing.
- Call `persist()` for its saved state, and restore a list with `each(list, fn)` from `lib/store.ts` so one bad entry doesn't stop the rest. Binary data (images) goes in IndexedDB via `lib/blobs.ts`, keyed by the item's id; localStorage only holds the layout.
- If its content scales with the window (a picture, a drawing), put it in `inkBox()` from `canvas/ink.ts`, so pen strokes on it keep their spot at any size, including full view.
- Something Claude should receive that isn't on the canvas (a GitHub pull request) can still be a reference: `referable()` a kind, then `addRef()` a detached element whose dataset says what to fetch at send time (see `sendToClaude` in `items/gh.ts`). Such chips have no arrow; clicking one runs the element's `onclick`.
- Text marked in place (like pinned snippets' sources in `items/pinmarks.ts`) uses the CSS Custom Highlight API, never wrapper elements: the chat re-renders while streaming and skips off-screen rows.
- Give it a `data-id` that is the same after a reload: arrows, pins and canvas tools find items by it.
- Call `referable()` if Claude should be able to receive it (that also makes it readable with `canvas_read`).
- Call `creatable()` if Claude should be able to create it with `canvas_create` (add the kind to that tool's `enum` in `Tools` in `internal/canvastools/canvastools.go`), with an `update` if Claude should be able to edit it with `canvas_update`.
- Windows get renaming, pinning (sidebar or screen) and full view from `makeWindow()`; don't rebuild these per kind. Anything that asks "where is this item on screen" should use `liveRect()` (handles pinned, floating and collapsed windows); `rect()` is the canvas geometry that gets saved.
- Add a `--k-<kind>` color in `tokens.css` and one `[data-kind=<kind>]` entry in the kind map at the top of `canvas.css` (it colors windows, Ctrl+K rows, chips and minimap boxes alike). The tab's glyph is the kind's `referable` icon; don't add a per-kind `::before` rule.

If you find yourself adding the new kind to a list in `canvas.ts`, the minimap, `main.ts` restore code or a CSS `:not(...)` selector, stop: that list should be a registry or a `data-kind` rule.

Rules for these registries:
- **Persistence keys are a public format.** Existing users have saved layouts in localStorage (`drawa:canvas:<root>`). Never rename or reshape a key without a loader that still reads the old shape.
- **Restore phases:** 0 is settings and positions, 1 is items, 2 is things that attach to items (ink). A loader may be async; the next one waits for it.
- **Item state goes in `data-state`,** not in ad-hoc classes (`busy`, `edit`, `approved`...). The minimap and CSS both key off `data-kind` + `data-state`.
- **Two canvas-wide attributes** belong to no kind, so they sit beside `data-state`: `data-hidden-in` (inside a collapsed group: use `hidden(el)` from `canvas.ts`, which placement, arrows, Ctrl+K and the selection skip) and `data-locked` (stays put: `movesWith()` and selection nudges leave it).

## Code conventions

- **Match the surrounding code:** short functions, early returns, `make()` / `iconButton()` / `button()` from `lib/dom.ts` rather than hand-built buttons, and `confirmBox()` rather than `confirm()`. Reuse the small helpers there before writing another: `shortcutOk(e)` / `typing(t)` for keyboard guards, `keepOnScreen()` for anything floating, `closestAt()` for hit-testing through overlays, `perFrame()` for once-a-frame work; and `edgeGrip()` / `track()` in `canvas.ts` for drag handles. No native browser dialogs or `alert`.
- **Keep modules small.** When a file passes about 350 lines or does two jobs, split it by responsibility the way `session/` is split: card, composer, stream, asks and live are separate modules.
- **No new dependency** for what a few lines or the platform can do. Big libraries (Mermaid, Excalidraw, html-to-image) are loaded with dynamic `import()` on first use. Keep it that way.
- **Comments say why,** not what. A deliberate shortcut gets a `ponytail:` comment naming its limit and the upgrade path.
- **Loose typing only where the CLI owns the schema.** Claude's stream-json messages are `Record<string, any>`. Type everything else.
- **Don't touch the private stuff:** no hard-coded paths, and no secrets or user data in the repo.

## Styling rules

- **Themes and color schemes:**
  - `lib/theme.ts` puts light/dark on `<html data-theme>` and the chosen scheme on `data-scheme`. The inline script in `index.html` does the same before first paint, so keep its defaults in sync.
  - A scheme is 13 base colors (`--c-*`) in `styles/schemes.css`. `tokens.css` derives every UI color from them.
  - To add a scheme: one block in `schemes.css` plus one line in `SCHEMES` in `theme.ts`. Keep `--c-muted` at 4.5:1 or better against `--c-bg`.
  - Feature CSS uses only the derived tokens, never `--c-*` and never a `prefers-color-scheme` query.
  - Anything drawn with colors baked in (Mermaid, Excalidraw previews) reads `isDark()` and redraws in `onTheme()`.
- **All values come from `styles/tokens.css`:**
  - Colors: derived from the active scheme, including the code highlighting colors (`--syn-*`).
  - Radius scale: `--r-tab`, `--r-box`, `--r-ctl`, and `--r-tag` for small labels (inline code, badges, swatches).
  - z scale: `--z-float`, `--z-panel`, `--z-menu` for overlays; `--z-under`, `--z-sticky`, `--z-over` for stacking inside a window or panel.
  - Kind colors: `--k-*`.
  - Don't write raw colors, radii or z-index numbers in feature CSS.
- **Shape language:**
  - Windows are folders. A tab on the top-left carries the title and buttons, and a concave shoulder joins it to a nearly square body.
  - Surfaces are square-cut (`--r-box`). The tab curve is the only prominent round corner.
  - Don't bring back 8–14px rounded cards, rounded boxes nested in rounded boxes, or pills. The user has rejected these repeatedly.
- **Window states change `--edge` only;** `window.css` draws the outline from it (no blurred shadows on windows). Don't restyle `.win-h` or `.win-b` per feature beyond what's in the kind's own section.
- **Color carries meaning:** read, edit, write and run are the action colors, and everything else is neutral. Mix tints with `color-mix(in oklab, …)`; oklch mixing shifts hues.
- **Input fields must look like input fields:** a visible border, a text cursor, and a clear focus state.
- **No native-looking controls:** `<select>` goes through `enhance()` from `lib/select.ts`.
- **Every animation has a `prefers-reduced-motion` fallback.** CSS ones live at the end of `index.css`; animations started from script check `reducedMotion()` from `lib/dom.ts`.
- **Layouts must work from phone width up.** Check at 390px.

## Performance rules

These are measured, not guessed. Reopening a 27MB transcript went from 7.6s to 0.5s, and streaming went from about 30fps to 60fps, by following them. Re-measure with a real large transcript after touching these paths.

- **Never read layout inside a loop** (`scrollHeight`, `offsetWidth`, `getBoundingClientRect`, `getComputedStyle` for sizes). Bulk work such as replaying a transcript sets `S.replaying` and `bulk(true)` from `canvas.ts` (new windows get spots from one measurement): `put()`, `follow()` and `renderCard()` skip their layout reads, and one final pass settles everything. `quietPings(true)` does the same for attention flashes.
- **Streaming renders incrementally.** Complete markdown blocks are rendered once; only the unfinished tail re-renders each frame (`streamText` in `session/stream.ts`). Don't go back to re-rendering the whole buffer.
- **Animations must not force layout.** Use the Web Animations API (`el.animate`), as `ping()` does, not the remove-class/`offsetWidth`/add-class trick.
- **No decorative glows or big blurred shadows** on canvas windows. They cost paint on every pan and zoom frame, and the user rejected them visually too. Show state with `--edge` and the tab's top line.
- **Long lists skip what's off-screen:** log entries use `content-visibility: auto`. Keep new per-entry elements as direct children of `.log`.
- **The server sends only what the page shows.** `Clip()` in `internal/sessions/sessions.go` drops images returned by tools and thinking signatures, trims tool outputs and tool inputs to 20k characters, and turns images you sent into `/api/images` addresses. It runs on transcripts and on big live lines (`Trimmed()`, which also drops the CLI's duplicate `tool_use_result`). The live buffer per card is capped by lines and bytes (`live.Keep`/`live.KeepBytes`). New fields should be trimmed the same way.
- **One stream per page.** Browsers allow ~6 connections per host over HTTP/1.1, so never add a long-lived request per card or per window: the page reads every card over one `/api/events` stream (`session/live.ts`).
- **Big libraries load on first use** (Mermaid, Excalidraw, html-to-image) with a dynamic `import()`.

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
- **Canvas tools:** each card's Claude gets an MCP server at `/mcp/<card>/<token>` (in `live.Live`). The token is per process, and requests carrying an `Origin` are refused, so only that process can call it. Calls are relayed to the newest page reading the card's stream and answered via `/api/canvas`. Tool definitions live in `canvastools.Tools`, and `canvastools.Instructions` (sent as the MCP server's `instructions`, which Claude Code puts in the system prompt) tells the agent when to reach for the canvas unprompted; reading is auto-allowed with `--allowedTools`, while changing things goes through the normal approval flow.
- One long-lived `claude -p` process per card (`live.Live`), speaking the stream-json protocol over merged stdout/stderr pipes, read with a buffered line scanner. The page reads all its cards' output over one `/api/events?page=…&c=cid:line:gen,…` stream (lines tagged `_c` with the card, in `server/events.go`) and answers control requests via `/api/respond`. Don't break re-attaching: a reload must pick up a running session where it left off, including the message being streamed (`Live.openMsg`, via `Live.Snapshot()`). `live.Start` (`internal/live/registry.go`) is the one way to get or spawn a card's process: with `DRAWA_MAX_LIVE` set it caps live processes, closing the least recently used idle one. A card with a turn, an open approval or a background agent still running is never idle (`Live.working()`), for the cap or the reaper. Lines the page must not count toward its position carry `"_r":1` (re-sent asks, `_gap`). GET routes live in the `getRoutes` table in `server/handler.go`; add new ones there.
- **Agent backends:** a card's agent is a backend registered with `live.Register(name, live.Kind{...})` (`internal/live/backend.go`); `claude.go` is the first. A new backend is one package that registers from its `init()` and is imported from `main.go`. It emits the wire format described in `live/wire.go` (the subset of Claude's stream-json the page reads, with Claude's tool names and input fields) through its `Sink`, so the page and `/api/events` never branch on backend; its golden tests run translated fixtures through `live.CheckWire`. A backend that translates its own events reuses `live.Turn` (`internal/live/turn.go`) for the message, block and result bookkeeping. An error that means the agent turned the request down while its process is fine is a `live.Refused` (anything else marks the process gone). `Kind.Blurb` is its line in menus. The page closes an ask when the backend sends `control_cancel_request` for it. If it can take back a queued message it hasn't read yet (Claude's `cancel_async_message`), it implements `live.Unsender` and sets `Kind.Unsend`; the page then shows edit and delete on queued bubbles (`/api/unsend`). It gets the card's canvas MCP URL in `Spec.MCPURL` and must hand it over without putting it in argv (the URL carries the card's token). The page knows the agents only through `lib/agents.ts` (`GET /api/agents`, and each one's models from `/api/meta?backend=`): a card carries its `backend` (saved only when it isn't claude, so older layouts load unchanged), menus list installed agents and hide themselves while there's only one, and copy names the card's agent with `who()`. Commit messages and PR descriptions go through `live.Write` (a backend's `OneShot`), never a hard-coded CLI. Card ops, the Git window's `message` op, the GitHub window's `draft` op, `/api/meta`, `/api/sessions` and `/api/session` take an optional `backend` (none means `live.Default`, what pages from before backends send); preflight requires at least one registered backend's CLI.
- **Concurrency:** a `Live`'s buffer is guarded by its own mutex; `live.Changed` (a `Broadcaster`, in `internal/live/broadcast.go`) is the one global wakeup signal, bumped by every `Live.Push()`. It stands in for Python's `threading.Condition` and is what the `/api/events` stream and `live.Meta()` block on — reuse it rather than adding another signaling mechanism.
- The server rebuilds (`go build`) and re-execs itself (`syscall.Exec`) when a `.go` file changes; a build that fails to compile keeps the old server running, same spirit as the old syntax-check-before-restart. Test changes against a separate port rather than killing the user's running instance.

## When a request is vague

- Prefer the smallest change that fits these rules. When a request needs a new abstraction, add it as a registry in the lower layer, and move the existing cases onto it in the same change, so the codebase never has two ways of doing one thing.
- Update this file whenever you add a folder, a registry, or a rule, and the architecture diagram in `CONTRIBUTING.md` if the big picture changes.
