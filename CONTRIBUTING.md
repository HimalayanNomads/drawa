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

Open http://localhost:5173. This also builds and starts the Go server, unless one is already running on port 8765.

## Before you open a pull request

```sh
cd web && npm run build   # tsc + Vite build, must pass with no new errors
go vet ./... && go test ./...
```

For anything visible, check it in both the light and dark themes, at phone width (390px), and after a page reload (the layout restores from saved state). See "Before you finish any change" in [`CLAUDE.md`](CLAUDE.md).

## Releasing

Only maintainers release. As a contributor or reviewer, your part ends at the pull request: once it's merged, it ships in the next release a maintainer cuts. The rest of this section is for maintainers.

Merging a pull request doesn't release anything. A version tag (`v*.*.*`) does: it runs `.github/workflows/release.yml`, which builds the macOS and Linux binaries and publishes them, with `checksums.txt`, as a GitHub Release. `install.sh` always fetches the newest one.

**From GitHub:** Releases → **Draft a new release** → under **Choose a tag** type the version (e.g. `v0.1.3`) and pick **Create new tag on publish**, target `main` → title it the same, optionally **Generate release notes** → **Publish release**. The workflow then uploads the binaries into that release within a minute or so.

**From a terminal**, on an up-to-date `main`:

```sh
git tag -a v0.1.3 -m v0.1.3
git push origin v0.1.3
```

The workflow creates the release itself. Either way, follow the run under Actions → Release.

## Layout

- `main.go`: the entry point (arg parsing, the self-restart loop, `main()`). `internal/`, one file per responsibility (`go test ./...` covers GitHub check merging, session/transcript loading, the canvas MCP endpoint and the multiplexed event stream): `config.go` (paths, constants, `Inside()`), `procx.go` (running `git`/`gh`/`claude` subprocesses), `gitx.go`, `github.go` + `detail.go` + `ops.go` (state/lists, single PR/issue reads, write operations), `filesx.go` (the file tree and `@` search), `images.go`, `sessions.go` (transcript loading, `Clip`/`Trimmed`), `canvastools.go` (the `Tools` schema Claude sees), `live.go` + `meta.go` (the `Live` type: one long-running `claude` process per card), `webassets/` (the built UI embedded for standalone release binaries, empty in a normal checkout), and `server/` (`handler.go` routing, `events.go` the `/api/events` stream, `mcp.go` the canvas MCP server, `shell.go` the `!` shell command, `cardops.go` send/respond/mode/canvas/interrupt/close, `netauth.go` the `--net` token check and lockout). Serves `web/dist` (falling back to `webassets` when it's absent) and the file/session/git/GitHub API.
- `web/src/`, by feature:
  - `main.ts`: boot, toolbar, shortcuts.
  - `lib/`: `api.ts` (server calls), `store.ts` (saved layout: each feature `persist()`s its own slice), `dom.ts`, `markdown.ts`, `select.ts` (custom dropdowns), `fonts.ts`, `blobs.ts` (IndexedDB for binary data such as canvas images).
  - `canvas/`: `canvas.ts` (pan/zoom, items, dragging, minimap), `window.ts` (the shared folder-tab window: drag, collapse, resize), `graph.ts` (edges, each session's Files and commands windows, files pinned from the tree), `ink.ts` (draw mode), `shapes.ts` (rectangle, ellipse, diamond and line; moving and resizing drawn shapes and text), `refs.ts` (what can be @-referenced: each kind registers with `referable()`), `tools.ts` (Claude's canvas tools: list, read, create, update and link items, served over MCP by the Go server), `links.ts` (arrows you or Claude draw between items), `snapshot.ts` (a picture of a window with its ink, for Claude), `find.ts` (Ctrl+K window search), `dock.ts` (pin to the sidebar, or stick to the screen), `fullview.ts` (a window filling the screen), `select.ts` (selecting several items: drag on empty canvas in Select mode, or double-tap and drag / Shift+drag in either mode, Shift/Ctrl+click a tab; drag them together, arrow keys nudge, Delete removes them), `mode.ts` (Select and Hand modes; Space held is a temporary hand).
  - `session/`: `session.ts` (cards), `composer.ts` (message box, / and @ menu, reference chips), `stream.ts` (rendering Claude's output), `asks.ts` (permission prompts, questions), `live.ts` (send, stream connection), `history.ts`.
  - `items/`: `notes.ts`, `doc.ts` (the Scratchpad: a Markdown window rendered with code blocks, Mermaid and callouts, double-click or the pencil to edit; S or the toolbar, or Claude's canvas_create kind "doc"), `sketch.ts` (Whiteboard: an Excalidraw window; no longer created, existing ones still load), `diagram.ts` (Mermaid + zoom), `plan.ts` (plan review), `snippet.ts` (plus `pinmarks.ts`: pinned text stays highlighted where it came from; click it to jump to the snippet), `git.ts`, `image.ts` (pictures: paste or drop them on the canvas, or Claude puts a screenshot there), `agent.ts` (a window per sub-agent: its work as it happens, a box to message it through its session; it leaves the canvas when the agent finishes, and the card's Agent row reopens it), `github.ts` (pull requests and issues through the `gh` CLI; Shift+G) with `gh.ts` (their data, and sending a PR, its failing checks, its reviews or an issue to Claude).
  - `panels/`: `files.ts` (tree, inspector), `diff.ts`.
  - `styles/`: `index.css` imports `tokens.css` (colors, radius and z scales) then one file per area.
- A new kind of canvas item is one file in `items/`: build it with `makeWindow()` (or `addItem()` for a bare node), then call `persist()` to save it and `referable()` if messages can reference it.
- `PRODUCT.md`: design direction.
- `CLAUDE.md`: the rules for changing the code.
