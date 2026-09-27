// Package update checks GitHub for a newer release and installs it over the running binary: `drawa --update` in
// a terminal, or the page's update notice (POST /api/update, which then restarts the server on the new binary).
// Only release binaries update themselves; a source build reports config.Version "dev" and is updated with git.
package update

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
)

const repo = "probablysamir/drawa"

// no redirects followed: /releases/latest answers with a redirect to /releases/tag/<version>, which is all we need
var client = &http.Client{
	Timeout:       15 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// exe is this binary's path, read before an update replaces the file.
var exe = executable()

func executable() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}

var (
	mu      sync.Mutex
	latest  string
	checked time.Time
)

// Latest is the newest release's tag (e.g. v0.1.7), asked of GitHub at most every 6 hours; "" for a source build
// or when GitHub hasn't answered yet. Reads the redirect like install.sh does: no API call, so no rate limit.
func Latest() string {
	if config.Version == "dev" {
		return ""
	}
	mu.Lock()
	defer mu.Unlock()
	if time.Since(checked) < 6*time.Hour {
		return latest
	}
	checked = time.Now() // ponytail: a failed check waits the full 6h too; retry sooner if offline starts matter
	resp, err := client.Head("https://github.com/" + repo + "/releases/latest")
	if err != nil {
		return latest
	}
	resp.Body.Close()
	if tag := path.Base(resp.Header.Get("Location")); strings.HasPrefix(tag, "v") {
		latest = tag
	}
	return latest
}

// Run installs the latest release over this binary with the project's own install.sh (so an update checks the
// same SHA-256 sums as a fresh install). Its progress goes to the server's terminal.
func Run() error {
	if config.Version == "dev" {
		return errors.New("this drawa was built from source: update it with git pull and a rebuild")
	}
	if exe == "" {
		return errors.New("can't tell where this drawa is installed")
	}
	resp, err := client.Get("https://raw.githubusercontent.com/" + repo + "/main/install.sh")
	if err != nil {
		return fmt.Errorf("couldn't reach GitHub: %w", err)
	}
	defer resp.Body.Close()
	script, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != 200 {
		return fmt.Errorf("couldn't download install.sh (%s)", resp.Status)
	}
	cmd := exec.Command("sh", "-s")
	cmd.Stdin = strings.NewReader(string(script))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), "DRAWA_INSTALL_DIR="+filepath.Dir(exe))
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("install.sh failed (%v): see the terminal drawa runs in", err)
	}
	return nil
}

// CLI is `drawa --update`.
func CLI() error {
	l := Latest()
	switch {
	case config.Version == "dev":
		return Run() // says why not
	case l == "":
		return errors.New("couldn't reach GitHub to check for a newer release")
	case l == config.Version:
		fmt.Printf("drawa %s is up to date.\n", l)
		return nil
	}
	fmt.Printf("Updating drawa %s → %s\n", config.Version, l)
	return Run()
}

// Restart replaces this server with the freshly installed binary, the same way main.go's rebuild-on-change does.
// Sessions are killed first (exec would orphan them); the page resumes each one on its next message.
func Restart() {
	live.KillAll()
	err := syscall.Exec(exe, append([]string{exe}, os.Args[1:]...), os.Environ())
	fmt.Println("restart after update failed:", err)
}
