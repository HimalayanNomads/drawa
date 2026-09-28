// Browser UI for Claude Code.
//
//	drawa [--net] [project-folder]   (default: the current folder, like `code .`); opens http://127.0.0.1:8765
//	drawa [--net] <github-url>       clones into the cache and opens it
//	drawa --clean [github-url]       removes cached clones with no unsaved work
//	drawa --update                   installs the latest release over this binary
//	drawa --version
//
// --net also listens on the machine's network address, so another device on the same network can open it;
// without it the server only answers on localhost. Builds web/ on first run (needs npm); after UI changes run
// `npm run build` in web/, or use `npm run dev` for UI work. DRAWA_PORT overrides the port; CLAUDE_CONFIG_DIR
// overrides where Claude Code's own config/sessions live (see internal/config).
package main

import (
	"bufio"
	"fmt"
	"io/fs"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"time"

	_ "drawa/internal/codex" // registers the codex backend
	"drawa/internal/config"
	"drawa/internal/live"
	_ "drawa/internal/opencode" // registers the opencode backend
	"drawa/internal/qr"
	"drawa/internal/remote"
	"drawa/internal/server"
	"drawa/internal/update"
	"drawa/internal/webassets"
)

var binPath = filepath.Join(config.Repo, ".bin", "drawa-server")

const banner = `
██████╗  ██████╗  █████╗ ██╗    ██╗ █████╗
██╔══██╗██╔══██╗██╔══██╗██║    ██║██╔══██╗
██║  ██║██████╔╝███████║██║ █╗ ██║███████║
██║  ██║██╔══██╗██╔══██║██║███╗██║██╔══██║
██████╔╝██║  ██║██║  ██║╚███╔███╔╝██║  ██║
╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝  ╚═╝
`

const (
	green  = "\033[32m"
	yellow = "\033[33m"
	red    = "\033[31m"
	reset  = "\033[0m"
)

// askTrust asks whether a cloned repo's own agent settings may load; their hooks and plugins run commands with no
// approval. The answer rides DRAWA_TRUST through self-restarts, tagged with Root: every child (agents, shells, git)
// inherits the variable, and a drawa started from one on another repo must still ask. No terminal means untrusted.
func askTrust() bool {
	if v, ok := os.LookupEnv(config.TrustEnv); ok {
		if trust, ok := config.TrustFor(v, config.Root); ok {
			return trust
		}
	}
	trust := false
	// the terminal itself, like sudo: stdin may be /dev/null or a pipe, and stdout may be redirected to a log
	if tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0); err == nil {
		fmt.Fprint(tty, "Trust this repo's agent settings? Its hooks and plugins can run commands on your machine. [y/N] ")
		line, _ := bufio.NewReader(tty).ReadString('\n')
		tty.Close()
		answer := strings.ToLower(strings.TrimSpace(line))
		trust = answer == "y" || answer == "yes"
	}
	os.Setenv(config.TrustEnv, map[bool]string{true: "1", false: "0"}[trust]+":"+config.Root)
	return trust
}

// preflight checks the external tools this app shells out to and prints a pass/fail line for each. At least one
// agent backend's CLI is required (every card is one of their processes); the others, and git and gh, are optional
// (the Git/GitHub windows and their per-call code already degrade gracefully without them), so those only warn.
func preflight() {
	if st, err := os.Stat(config.Root); err != nil || !st.IsDir() { // claude can't start in it: every send would fail
		if arg := firstArg(); strings.Contains(arg, "://") || strings.HasPrefix(arg, "git@") {
			fmt.Printf("%s isn't a supported GitHub repo URL (https://github.com/owner/repo, …/tree/<branch>, or git@github.com:owner/repo.git).\n", arg)
			os.Exit(1)
		}
		fmt.Printf("%s isn't a folder.\n", config.Root)
		if len(os.Args) > 1 && strings.Contains(os.Args[1], "=") {
			fmt.Printf("Environment variables go before the command: %s drawa\n", os.Args[1])
		}
		os.Exit(1)
	}
	type check struct {
		cmd, label, help string
		agent            bool
		warn             func() string
	}
	var checks []check
	for _, name := range live.Names() {
		k, _ := live.Lookup(name)
		checks = append(checks, check{k.Bin, k.Label, k.Install, true, k.Warn})
	}
	checks = append(checks,
		check{"git", "git", "the Git window and file history won't work", false, nil},
		check{"gh", "gh (GitHub CLI)", "the GitHub window won't work — get it: https://cli.github.com", false, nil},
	)
	agents, missing := 0, false
	var lines []string
	for _, c := range checks {
		if _, err := exec.LookPath(c.cmd); err != nil {
			lines = append(lines, fmt.Sprintf("  [x] %s — not found (%s)", c.label, c.help))
			missing = true
		} else if w := warnOf(c.warn); w != "" {
			lines = append(lines, fmt.Sprintf("  [!] %s — %s", c.label, w))
			agents, missing = agents+1, true
		} else {
			lines = append(lines, fmt.Sprintf("  [✓] %s", c.label))
			if c.agent {
				agents++
			}
		}
	}
	ok := agents > 0
	color, symbol := green, "✓"
	if !ok {
		color, symbol = red, "✗" // no agent CLI at all: can't run
	} else if missing {
		color, symbol = yellow, "!" // git, gh or another backend's CLI missing: degraded, but drawa still runs
	}
	fmt.Printf("%s%s%s Prerequisites\n%s\n\n", color, symbol, reset, strings.Join(lines, "\n"))
	if !ok {
		os.Exit(1)
	}
}

// firstArg is the first non-flag argument anywhere, as config.rootDir reads it ("" if none).
func firstArg() string {
	for _, a := range os.Args[1:] {
		if !strings.HasPrefix(a, "-") {
			return a
		}
	}
	return ""
}

func warnOf(f func() string) string {
	if f == nil {
		return ""
	}
	return f()
}

// watchedFiles is every non-test .go source file plus go.mod in the repo (skipping web/ and dot-directories: no reason to walk
// node_modules or .git for a change that can never affect the server).
func watchedFiles() []string {
	var files []string
	filepath.WalkDir(config.Repo, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != config.Repo && (d.Name() == "web" || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		// tests can't change the running server, and a restart kills every live session
		if (strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go")) || d.Name() == "go.mod" {
			files = append(files, path)
		}
		return nil
	})
	return files
}

func mtimeSnapshot() map[string]time.Time {
	m := map[string]time.Time{}
	for _, f := range watchedFiles() {
		if info, err := os.Stat(f); err == nil {
			m[f] = info.ModTime()
		}
	}
	return m
}

func rebuild() error {
	if err := os.MkdirAll(filepath.Dir(binPath), 0o755); err != nil {
		return err
	}
	cmd := exec.Command("go", "build", "-o", binPath, ".")
	cmd.Dir = config.Repo
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return nil
}

// restartOnChange rebuilds and replaces this process (exec) whenever a source file changes. A build that fails
// to compile keeps the old server running rather than replacing it with nothing.
func restartOnChange() {
	seen := mtimeSnapshot()
	for {
		time.Sleep(time.Second)
		now := mtimeSnapshot()
		if maps.EqualFunc(seen, now, time.Time.Equal) {
			continue
		}
		seen = now
		if err := rebuild(); err != nil {
			fmt.Println("not restarting:", err, "\n(fix the build to pick this up)")
			continue
		}
		fmt.Println("server changed, restarting")
		live.KillAll() // exec would orphan them; the page resumes each session on its next message
		exe, err := filepath.Abs(binPath)
		if err != nil {
			continue
		}
		if err := syscall.Exec(exe, append([]string{exe}, os.Args[1:]...), os.Environ()); err != nil {
			fmt.Println("restart failed:", err)
		}
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		return
	}
	// its own session: a browser this starts would otherwise sit in the terminal's foreground group, and the
	// Ctrl+C or hangup that stops drawa would close it too
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if cmd.Start() == nil {
		go cmd.Wait() // reap xdg-open so it doesn't linger as a zombie
	}
}

func main() {
	if slices.Contains(os.Args[1:], "--version") {
		fmt.Println("drawa", config.Version)
		return
	}
	if slices.Contains(os.Args[1:], "--update") { // before preflight: updating doesn't need claude
		if err := update.CLI(); err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		return
	}
	if slices.Contains(os.Args[1:], "--clean") { // before preflight: cleaning doesn't need claude
		if err := remote.Clean(firstArg()); err != nil { // `drawa <url> --clean` cleans only <url>
			fmt.Println(err)
			os.Exit(1)
		}
		return
	}
	fmt.Print(banner)
	if config.Cloned { // before preflight, which needs Root to exist
		if _, err := exec.LookPath("git"); err != nil {
			fmt.Println("git is needed to open a GitHub URL.")
			os.Exit(1)
		}
		if config.CloneURL != "" { // empty: a clone's folder opened directly, nothing to clone
			if err := remote.Ensure(config.Root, config.CloneURL, config.CloneRef); err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}
		config.Trusted = askTrust()
		if config.Untrusted() {
			fmt.Println("Opening untrusted: the repo's own agent settings (hooks, permissions, MCP servers, plugins) are ignored.")
		}
	}
	preflight()
	if _, err := os.Stat(filepath.Join(config.Dist, "index.html")); err != nil && !webassets.Available() {
		// first run from a fresh clone: build the UI so there is one command to learn. A standalone release
		// binary skips this: its UI is embedded, and config.Repo (baked in at its own build time) names a path
		// that only existed on the machine that built it.
		fmt.Println("Building the UI (first run only)...")
		cmd := exec.Command("sh", "-c", "npm install && npm run build")
		cmd.Dir = filepath.Join(config.Repo, "web")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			fmt.Println("UI build failed. Needs Node.js 18+ (npm on PATH).")
			os.Exit(1)
		}
	}
	go restartOnChange()
	go func() { // each claude runs in its own process group, so Ctrl+C in this terminal no longer reaches it
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
		<-sig
		live.KillAll()
		os.Exit(130)
	}()
	go live.Reap()
	url := fmt.Sprintf("http://127.0.0.1:%d", config.Port)
	fmt.Printf("Opening drawa UI for %s\n\n", config.Root)
	fmt.Printf("  - Local:   %s\n", url)
	addr := fmt.Sprintf("127.0.0.1:%d", config.Port) // localhost only unless --net: this endpoint runs Claude Code with your permissions
	if config.Net {
		for _, ip := range config.LocalIPs() {
			link := fmt.Sprintf("http://%s:%d/?token=%s", ip, config.Port, config.NetToken)
			fmt.Printf("  - Network: %s\n\n%s", link, qr.Terminal(link))
		}
		fmt.Println("\nThat Network link's token lasts until you stop drawa (restarts after code changes keep it), and a browser that opens the link keeps it in a cookie. Anyone who has it can run commands as you, so don't share it beyond people you trust on this network.")
		addr = fmt.Sprintf(":%d", config.Port) // every interface, not just loopback; config.Hosts still keeps DNS rebinding and outside hosts out
	} else {
		fmt.Println()
	}
	if os.Getenv("DRAWA_OPENED") == "" { // set before exec, so self-restarts don't open another tab
		os.Setenv("DRAWA_OPENED", "1")
		openBrowser(url)
	}
	if err := http.ListenAndServe(addr, server.Handler()); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
