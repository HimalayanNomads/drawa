# Installing drawa

Needs [Claude Code](https://claude.com/claude-code) (`claude`) on `PATH` — `drawa` checks for it at startup and refuses to run without it. `git` and [`gh`](https://cli.github.com) are optional: without them the Git and GitHub windows don't work, but everything else does.

## Quick install (macOS, Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/probablysamir/drawa/main/install.sh | sh
```

Checks your platform, downloads the right release binary, verifies its SHA-256 checksum, and installs it to `~/.local/bin/drawa`. Set `DRAWA_INSTALL_DIR` first to install somewhere else:

```sh
DRAWA_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/probablysamir/drawa/main/install.sh | sh
```

(needs `sudo sh` instead of `sh` if that directory isn't writable by your user). If the install directory isn't already on `PATH`, the script tells you the line to add to your shell's rc file.

## Manual install

Pick the archive matching your machine from the [Releases page](https://github.com/probablysamir/drawa/releases/latest), or with `curl`:

**macOS, Apple Silicon (M1/M2/M3/…):**
```sh
curl -fsSLO https://github.com/probablysamir/drawa/releases/latest/download/drawa-darwin-arm64.tar.gz
tar -xzf drawa-darwin-arm64.tar.gz
```

**macOS, Intel:**
```sh
curl -fsSLO https://github.com/probablysamir/drawa/releases/latest/download/drawa-darwin-amd64.tar.gz
tar -xzf drawa-darwin-amd64.tar.gz
```

**Linux, x86_64:**
```sh
curl -fsSLO https://github.com/probablysamir/drawa/releases/latest/download/drawa-linux-amd64.tar.gz
tar -xzf drawa-linux-amd64.tar.gz
```

**Linux, arm64:**
```sh
curl -fsSLO https://github.com/probablysamir/drawa/releases/latest/download/drawa-linux-arm64.tar.gz
tar -xzf drawa-linux-arm64.tar.gz
```

Not sure which architecture: `uname -m` (`arm64`/`aarch64` → arm64, `x86_64` → amd64). There's no Windows build — `internal/procx/procx.go` kills a subprocess's whole process group with POSIX-only syscalls, which has no Windows equivalent yet.

Each archive extracts to a single `drawa` binary. Put it on `PATH`:

```sh
chmod +x drawa
sudo mv drawa /usr/local/bin/          # or: mkdir -p ~/.local/bin && mv drawa ~/.local/bin/
```

## From source

Needs Go and Node. See [Build from source](README.md#install) in the README — `git clone`, build the UI with `npm`, then `go build -o drawa .`.

## Verify it's installed

```sh
which drawa
drawa .   # opens the current folder; Ctrl+C to stop
```

## Updating

drawa checks GitHub for a newer release in the background and offers to install it (downloads it, verifies its checksum, and restarts) — accept, put it off, or skip that version. You can also re-run the install script (it always fetches the latest release) or repeat the manual steps with a fresh download; either just overwrites the old binary.

## Uninstalling

```sh
rm "$(command -v drawa)"
```

## Troubleshooting

- **`claude (the Claude Code CLI) isn't on PATH`** — install [Claude Code](https://claude.com/claude-code) first; `drawa` won't start without it.
- **Port already in use** — another `drawa` (or something else) is on 8765. Run with `DRAWA_PORT=<port> drawa .` instead.
- **macOS: "drawa cannot be opened because the developer cannot be verified"** — release binaries aren't code-signed or notarized. This only happens when the file carries a quarantine flag (typically from a browser download, not `curl`). Clear it once: `xattr -d com.apple.quarantine /path/to/drawa`.
- **`command not found: drawa` after installing** — the install directory isn't on `PATH` yet; the install script prints the export line to add, or check manually with `echo $PATH`.
