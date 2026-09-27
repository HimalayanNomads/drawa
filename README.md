<div align="center">

<img src="web/public/favicon.svg" width="72" alt="">

# Drawa

**A canvas workspace for Claude Code.**

Run several Claude sessions side by side, watch every file they read, edit and run as a live map, and review every change without leaving the browser.

[![Latest release](https://img.shields.io/github/v/release/probablysamir/drawa)](https://github.com/probablysamir/drawa/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)

[Install](#install) · [Quick start](#quick-start) · [Features](#features) · [Shortcuts](#keyboard-shortcuts) · [Contributing](CONTRIBUTING.md)

</div>

---

## Why Drawa

In a terminal, Claude Code's work scrolls past as a transcript. Drawa lays it out as a map instead. Each session is a card on a canvas. The files it touches appear in a window wired to that card, colored by what happened to them (read, edited, written). The commands it runs collect beside it. You can see at a glance what Claude did, and click any file to see exactly how it changed.

Drawa runs entirely on your machine. It drives the `claude` CLI you already have, with your login, settings, skills and MCP servers, and serves the UI on `127.0.0.1`.

## Features

- **Parallel sessions.** Each card is a live Claude process. Type any time; messages queue while Claude or its sub-agents work.
- **Your work, drawn as a map.** Files Claude reads, edits and writes are linked to its card and colored by action. Commands it runs collect in their own window.
- **Diffs everywhere.** Click a file for its changes from every session, plus the file itself with Markdown and Mermaid preview.
- **Sub-agents in the open.** Each sub-agent gets its own window showing its work as it happens, and you can message it directly.
- **Claude can use the canvas too.** Claude can read, create, edit and link canvas items through built-in tools, with changes going through the normal approval flow.
- **A whiteboard around your code.** Sticky notes, a Markdown scratchpad, Mermaid diagrams, pictures, pinned snippets, shapes, arrows and freehand ink. `@`-reference any of them in a message, or drop them on a card.
- **Git and GitHub built in.** Browse status and history. Open pull requests and issues through `gh`, and send a PR, its failing checks or its reviews straight to Claude.
- **Picks up where you left off.** Resume past sessions from history. The whole layout survives a reload, and a reload re-attaches to sessions that are still running.
- **Themes.** Light and dark, with Rosé Pine, Catppuccin, Tokyo Night, Gruvbox, Nord, Kanagawa, Everforest, Solarized and GitHub color schemes.

## Requirements

| | |
|---|---|
| [Claude Code](https://claude.com/claude-code) | **Required.** `claude` must be on `PATH` and logged in. |
| `git` | Optional. Powers the Git window and file history. |
| [`gh`](https://cli.github.com) | Optional. Powers the GitHub window. |
| OS | macOS or Linux. Windows isn't supported yet. |

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/probablysamir/drawa/main/install.sh | sh
```

This downloads the right [release binary](https://github.com/probablysamir/drawa/releases/latest) for your OS and architecture and installs it to `~/.local/bin/drawa`. You don't need Go or Node.

For manual downloads, custom install locations, updating and uninstalling, see [INSTALL.md](INSTALL.md).

<details>
<summary><b>Build from source</b></summary>

Needs Go 1.22+ and Node 20+.

```sh
git clone https://github.com/probablysamir/drawa.git
cd drawa/web && npm install && npm run build
cd .. && go build -o drawa .
```

</details>

## Quick start

```sh
cd ~/my/project
drawa
```

Drawa opens http://127.0.0.1:8765 in your browser, and Claude works in that folder. Press `N` for a new session and start typing.

```sh
drawa                  # the current folder
drawa ~/some/project   # any other folder
drawa --net .          # also reachable from other devices on the network
```

In the message box, `/` opens skills and slash commands and `@` references files or canvas items. The toolbar picks the model and permission mode.

By default Drawa only answers on localhost. Pass `--net` (in any position) and, like a Vite or Next.js dev server, it also listens on the machine's network address and prints both:

```
  - Local:   http://127.0.0.1:8765
  - Network: http://192.168.1.23:8765/?token=fpKZrzCN
```

The Network link lets another device on the same network — a laptop, a phone — open the same workspace. It only works with its `?token=` (a fresh one each run, checked once, then kept in a cookie and dropped from the address), and an address that guesses wrong 5 times locks out for a few minutes. See [Security](#security).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DRAWA_PORT` | `8765` | Port to serve on. Set it to run two projects at once. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config directory, if you keep a separate login or set of skills for Drawa. |
| `DRAWA_NET_TOKEN` | a fresh one per run | The `--net` token. Drawa sets it itself so the token survives its self-restarts; set it only to pick your own. |
| `DRAWA_MAX_LIVE` | unset (no cap) | Most `claude` processes kept running at once (each takes a few hundred MB). Past it, the least recently used idle session is closed; its next message resumes it. Idle sessions close after 30 minutes either way. |
| `DRAWA_DEV` | unset | `1` trusts the Vite dev server's origin (port 5173). `npm run dev` sets it; see `CONTRIBUTING.md`. |

```sh
DRAWA_PORT=8766 CLAUDE_CONFIG_DIR=$HOME/.claude-work drawa ~/other/project
```

## Keyboard shortcuts

Shortcuts follow Excalidraw's where the tool exists, and don't fire while you're typing.

| Area | Keys |
|---|---|
| **Canvas** | `V`/`1` select · `H` hand (hold `Space` to pan) · `Shift+1` fit all · `Shift+2` zoom to selection · `Shift+0` zoom 100% · `F` fit · `+`/`-` zoom in/out · arrows pan (`Shift`: bigger steps; with a selection they nudge it instead) |
| **Items** | `N` new session · `C`/`Shift+C` next/previous session (`Enter` to type) · `T` sticky note · `S` scratchpad · `9` insert picture · `G` Git · `Shift+G` GitHub · `Shift+H` history & files · `Ctrl+K` find a window |
| **Draw** | `D` toggle Draw mode · `P`/`7` pen · `A`/`5` arrow between items · `E`/`0` eraser · `T`/`8` text · `R`/`2` rectangle · `3` diamond · `O`/`4` ellipse · `L`/`6` line (`Shift` for square, circle, 45°) · `Ctrl+Z` undo · `Esc` stop |
| **Selection** | `Ctrl/Cmd+A` select all · arrows nudge (`Shift`: 10px) · `Delete` remove · `Esc` clear |
| **Message box** | `Ctrl+Enter` send · `Enter` new line · `Esc` leave the box · `↑` at the start / `↓` at the end: previous/next message or `!` command you sent in this session (past the newest: your draft) |

**Mouse:** drag the background to select (Select mode) or pan (Hand mode). The middle button and the wheel always pan. `Ctrl/Cmd+scroll` or pinch zooms; `Shift+scroll` scrolls sideways. The zoom is saved with the canvas. Jumping to a window (`Ctrl+K`, `C`, a notification) keeps the zoom unless the window would be under 50% or wouldn't fit, then it zooms to fit that window (at most 100%). Click a picture or diagram for full view, and click it again to zoom and pan it. Phones start in Hand mode.

## Security

Drawa is built to run locally for one user:

- The server listens on `127.0.0.1` only, unless you pass `--net` (see [Quick start](#quick-start)), and checks the `Host` header on every request either way.
- With `--net`, the network address additionally needs its one-time `?token=`; wrong guesses lock that address out after 5 tries. Still only pass `--net` on a network you trust, and treat the printed link like a password — don't post it anywhere public.
- Changing requests must come from Drawa's own page (a matching `Origin`).
- File access is confined to the project folder you opened.
- Claude's canvas tools use a per-process token, so only that session's own `claude` process can call them.

To report a vulnerability, please open a [private security advisory](https://github.com/probablysamir/drawa/security/advisories/new) rather than a public issue.

## Contributing

Issues and pull requests are welcome. Maintainers cut the releases; a merged pull request ships in the next one. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and a map of the code, and [CLAUDE.md](CLAUDE.md) for the conventions the codebase follows.

## License

Drawa is licensed under the [GNU Affero General Public License v3.0](LICENSE).
