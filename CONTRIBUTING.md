# Contributing to Drawa

Thanks for helping out. This page covers running Drawa from source and finding your way around the code. [`CLAUDE.md`](CLAUDE.md) holds the rules the codebase follows (where things go, the registries, styling and performance rules). Read it before a non-trivial change, whether you write the code yourself or an agent does.

## Development setup

You need Go 1.22+, Node 20+ and [Claude Code](https://claude.com/claude-code) on `PATH`.

```sh
git clone https://github.com/probablysamir/drawa.git
cd drawa/web && npm install && npm run build
cd .. && go run . /path/to/project
```

When run from source, the server rebuilds and restarts itself whenever a `.go` file changes. A build that fails to compile keeps the old server running.

For hot reload of the UI:

```sh
cd web && DRAWA_ROOT=/path/to/project npm run dev
```

Open http://localhost:5173. This also builds and starts the Go server, unless one is already running on port 8765. It starts it with `DRAWA_DEV=1`, which makes the server trust the Vite dev origin (port 5173); without it the server refuses requests from that page. If you run the Go server yourself for dev, set `DRAWA_DEV=1` too.

## Before you open a pull request

```sh
cd web && npm run build   # tsc + Vite build, must pass with no new errors
go vet ./... && go test ./...
```

For anything visible, check it in both the light and dark themes, at phone width (390px), and after a page reload (the layout restores from saved state). See "Before you finish any change" in [`CLAUDE.md`](CLAUDE.md).

## Layout

- `main.go`: the entry point (the self-restart loop, `main()`); it doesn't parse arguments, `internal/config` does. `internal/` holds one package per responsibility (`go test ./...` covers GitHub check merging, session/transcript loading, the canvas MCP endpoint and the multiplexed event stream): `config/` (the project folder and flags, port, paths, allowed hosts and origins, `Inside()`), `procx/` (running `git`/`gh`/`claude` subprocesses), `gitx/`, `github/` (`github.go` + `detail.go` + `ops.go`: state/lists, single PR/issue reads, write operations), `filesx/` (the file tree and `@` search), `images/`, `sessions/` (transcript loading, `Clip`/`Trimmed`), `canvastools/` (the `Tools` schema Claude sees), `live/` (`live.go` + `meta.go`: the `Live` type, one long-running `claude` process per card; `registry.go`: `Start`, the optional `DRAWA_MAX_LIVE` cap, reaping idle processes, `KillAll` before a restart; `broadcast.go`: `Changed`, the one wakeup signal), `webassets/` (the built UI embedded for standalone release binaries, empty in a normal checkout), and `server/` (`handler.go` routing, `events.go` the `/api/events` stream, `mcp.go` the canvas MCP server, `shell.go` the `!` shell command, `cardops.go` send/respond/mode/canvas/interrupt/close, `netauth.go` the `--net` token check and lockout). Serves `web/dist` (falling back to `webassets` when it's absent) and the file/session/git/GitHub API.
- `web/src/`, by feature:
  - `main.ts`: boot, toolbar, shortcuts.
  - `lib/`: `api.ts` (server calls), `store.ts` (saved layout: each feature `persist()`s its own slice; loaders restore lists with `each()`, so one bad entry doesn't stop the rest), `dom.ts` (element and button helpers, `reducedMotion()`), `markdown.ts` (rendering; `onRendered()` lets a feature post-process rendered Markdown, as diagrams do), `select.ts` (custom dropdowns), `fonts.ts`, `blobs.ts` (IndexedDB for binary data such as canvas images), `zoom.ts` (the zoom/pan dialog for diagrams and pictures), `connection.ts` (server reachability, `onReconnect()`), `theme.ts` (light/dark and color schemes), `tooltip.ts` (app-styled tooltips from `title`).
  - `canvas/`: `canvas.ts` (the view, items, dragging, placing new windows, `track()`, `bulk()`), `window.ts` (the shared folder-tab window: drag, collapse, resize), `graph.ts` (edges between a session and its windows), `sessionwins.ts` (each session's Files and commands windows, files pinned from the tree; `setInspector()` is how the file panel plugs in), `nav.ts` (panning, zooming, the minimap and zoom buttons), `ink.ts` (draw mode), `inksel.ts` (which strokes are in an area or under the pointer; moving strokes with the selection), `inkrows.ts` (ink that follows chat rows), `shapes.ts` (rectangle, ellipse, diamond and line; moving and resizing drawn shapes and text), `shapegeom.ts` (the shapes' pure geometry), `refs.ts` (what can be @-referenced: each kind registers with `referable()`), `tools.ts` (Claude's canvas tools: list, read, create, update and link items, served over MCP by the Go server), `links.ts` (arrows you or Claude draw between items), `snapshot.ts` (a picture of a window with its ink, for Claude), `find.ts` (Ctrl+K window search), `dock.ts` (pin to the sidebar, or stick to the screen), `fullview.ts` (a window filling the screen), `select.ts` (selecting several items: drag on empty canvas in Select mode, or double-tap and drag / Shift+drag in either mode, Shift/Ctrl+click a tab; drag them together, arrow keys nudge, Delete removes them), `mode.ts` (Select and Hand modes; Space held is a temporary hand).
  - `session/`: `session.ts` (cards), `composer.ts` (message box, / and @ menu, reference chips), `stream.ts` (rendering Claude's output), `asks.ts` (permission prompts, questions), `live.ts` (send, stream connection), `history.ts`, `recall.ts` (Up/Down through sent messages), `images.ts` (pasted or dropped images), `uploads.ts` (dropped text files), `mode.ts` (per-card permission mode), `notify.ts` (tab-title count and system notifications), `shell.ts` (`!` shell commands), `tasks.ts` (Claude's task checklist).
  - `items/`: `notes.ts`, `doc.ts` (the Scratchpad: a Markdown window rendered with code blocks, Mermaid and callouts, double-click or the pencil to edit; S or the toolbar, or Claude's canvas_create kind "doc"), `sketch.ts` (Whiteboard: an Excalidraw window; no longer created, existing ones still load), `diagram.ts` (Mermaid + zoom), `plan.ts` (plan review) with `plandiff.ts` (what changed since the last version, marked by word, list item or block), `snippet.ts` (plus `pinmarks.ts`: pinned text stays highlighted where it came from; click it to jump to the snippet), `git.ts`, `image.ts` (pictures: paste or drop them on the canvas, or Claude puts a screenshot there), `agent.ts` (a window per sub-agent: its work as it happens, a box to message it through its session; it leaves the canvas when the agent finishes, and the card's Agent row reopens it), `github.ts` (pull requests and issues through the `gh` CLI; Shift+G) with `gh.ts` (their data, and sending a PR, its failing checks, its reviews or an issue to Claude).
  - `panels/`: `files.ts` (tree, inspector), `diff.ts`.
  - `styles/`: `index.css` imports `tokens.css` (colors, radius and z scales) then one file per area.
- A new kind of canvas item is one file in `items/`: build it with `makeWindow()` (or `addItem()` for a bare node), then call `persist()` to save it and `referable()` if messages can reference it.
- `PRODUCT.md`: design direction.
- `CLAUDE.md`: the rules for changing the code.
