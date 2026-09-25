// Browser UI for Claude Code.
//
//	claude-ui [project-folder]   (default: current folder); opens http://127.0.0.1:8765
//
// Builds web/ on first run (needs npm); after UI changes run `npm run build` in web/, or use `npm run dev` for
// UI work.
package main

import (
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"claude-ui/internal/config"
	"claude-ui/internal/live"
	"claude-ui/internal/server"
)

var binPath = filepath.Join(config.Repo, ".bin", "claude-ui-server")

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

func mapsEqual(a, b map[string]time.Time) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if !b[k].Equal(v) {
			return false
		}
	}
	return true
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
		if mapsEqual(seen, now) {
			continue
		}
		seen = now
		if err := rebuild(); err != nil {
			fmt.Println("not restarting:", err, "\n(fix the build to pick this up)")
			continue
		}
		fmt.Println("server changed, restarting")
		live.Mu.Lock()
		for _, lv := range live.Registry { // exec would orphan them; the page resumes each session on its next message
			lv.Kill()
		}
		live.Mu.Unlock()
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
	cmd.Start()
}

func main() {
	if _, err := os.Stat(filepath.Join(config.Dist, "index.html")); err != nil {
		// first run from a fresh clone: build the UI so there is one command to learn
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
	go live.Reap()
	url := fmt.Sprintf("http://127.0.0.1:%d", config.Port)
	fmt.Printf("Claude UI for %s -> %s\n", config.Root, url)
	if os.Getenv("CLAUDE_UI_OPENED") == "" { // set before exec, so self-restarts don't open another tab
		os.Setenv("CLAUDE_UI_OPENED", "1")
		openBrowser(url)
	}
	// Localhost only: this endpoint runs Claude Code with your permissions.
	addr := fmt.Sprintf("127.0.0.1:%d", config.Port)
	if err := http.ListenAndServe(addr, server.Handler()); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
