// Package update checks GitHub Releases for a newer drawa and installs it in place: `drawa --update` in a
// terminal, or the page's update dialog (POST /api/update, which then restarts the server on the new binary). It
// mirrors install.sh's recipe (same repo, asset names and checksum file) so the two paths never disagree. Only
// release binaries update themselves: a source build reports config.Version "dev" and is updated with git.
package update

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
)

const repo = "probablysamir/drawa" // matches install.sh's $repo
const ttl = 6 * time.Hour

var (
	checkClient    = &http.Client{Timeout: 5 * time.Second}
	downloadClient = &http.Client{Timeout: 5 * time.Minute} // a release archive is ~10MB; never hang forever
)

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

type Info struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	URL       string `json:"url"`
	Available bool   `json:"available"`
	Installed string `json:"installed,omitempty"` // on disk, waiting for a restart ("Restart later")
}

var cache struct {
	sync.Mutex
	latest, url string
	checked     time.Time
	installed   string
}

// Check is what the page and `drawa --update` ask: GitHub is asked at most every 6 hours; a failed check is
// retried on the next call (they're rare: the page asks every few hours and when you come back to the tab).
func Check() (Info, error) {
	if config.Version == "dev" { // no meaningful "current version" to compare, so never nag a source checkout
		return Info{Current: config.Version}, nil
	}
	cache.Lock()
	defer cache.Unlock()
	if time.Since(cache.checked) >= ttl {
		latest, url, err := resolveTag("https://github.com/" + repo + "/releases/latest")
		if err != nil {
			return Info{Current: config.Version, Installed: cache.installed}, err
		}
		cache.latest, cache.url, cache.checked = latest, url, time.Now()
	}
	// once installed, only a still newer release is worth offering again
	avail := newer(cache.latest, config.Version) && cache.latest != cache.installed
	return Info{Current: config.Version, Latest: cache.latest, URL: cache.url, Available: avail, Installed: cache.installed}, nil
}

// progress counts the release archive's bytes while Install downloads it, for the page's dialog to poll.
var progress struct{ got, total atomic.Int64 }

type counted struct{}

func (counted) Write(p []byte) (int, error) { progress.got.Add(int64(len(p))); return len(p), nil }

// Progress is how much of the archive Install has downloaded so far (total is 0 until GitHub says the size).
func Progress() (got, total int64) { return progress.got.Load(), progress.total.Load() }

// Pending reports whether an installed update is waiting for a restart.
func Pending() bool {
	cache.Lock()
	defer cache.Unlock()
	return cache.installed != ""
}

// resolveTag reads releases/latest's redirect target (install.sh's trick): no API call, so no rate limit or auth.
func resolveTag(latestURL string) (tag, url string, err error) {
	resp, err := checkClient.Head(latestURL)
	if err != nil {
		return "", "", err
	}
	resp.Body.Close()
	loc := resp.Request.URL.String()
	tag = loc[strings.LastIndexByte(loc, '/')+1:]
	if !strings.HasPrefix(tag, "v") {
		return "", "", errors.New("no release found")
	}
	return tag, loc, nil
}

// newer reports whether a > b, comparing "vX.Y.Z" tags component-wise (not lexicographically: v0.10.0 > v0.9.0).
func newer(a, b string) bool {
	pa, pb := parts(a), parts(b)
	for i := range 3 {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parts(v string) [3]int {
	var out [3]int
	for i, s := range strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3) {
		out[i], _ = strconv.Atoi(s)
	}
	return out
}

// CLI is `drawa --update`.
func CLI() error {
	if config.Version == "dev" {
		return errors.New("this drawa was built from source: update it with git pull and a rebuild")
	}
	info, err := Check()
	if err != nil {
		return fmt.Errorf("couldn't check GitHub for a newer release: %w", err)
	}
	if !info.Available {
		fmt.Printf("drawa %s is up to date.\n", config.Version)
		return nil
	}
	fmt.Printf("Updating drawa %s → %s\n", config.Version, info.Latest)
	if err := Install(); err != nil {
		return err
	}
	fmt.Printf("Installed %s at %s\n", info.Latest, exe)
	return nil
}

// Install downloads the release matching this machine, verifies its checksum and replaces the running binary
// on disk. It never kills a session or restarts the process: call Restart for that, after answering whoever
// asked for the install.
func Install() error {
	info, err := Check()
	if err != nil {
		return err
	}
	if !info.Available {
		return errors.New("no update available")
	}
	if exe == "" {
		return errors.New("can't tell where this drawa is installed")
	}
	asset := fmt.Sprintf("drawa-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	base := "https://github.com/" + repo + "/releases/download/" + info.Latest

	tmp, err := os.MkdirTemp("", "drawa-update-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	archivePath := filepath.Join(tmp, asset)
	if err := download(base+"/"+asset, archivePath, true); err != nil {
		return fmt.Errorf("downloading %s: %w", asset, err)
	}
	sumsPath := filepath.Join(tmp, "checksums.txt")
	if err := download(base+"/checksums.txt", sumsPath, false); err != nil {
		return fmt.Errorf("downloading checksums.txt: %w", err)
	}
	if err := verify(archivePath, asset, sumsPath); err != nil {
		return err
	}
	bin, err := extractBinary(archivePath, tmp)
	if err != nil {
		return err
	}
	if err := replaceSelf(bin); err != nil {
		return err
	}
	cache.Lock()
	cache.installed = info.Latest
	cache.Unlock()
	return nil
}

func download(url, dest string, track bool) error {
	resp, err := downloadClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	var w io.Writer = f
	if track {
		progress.got.Store(0)
		progress.total.Store(max(resp.ContentLength, 0))
		w = io.MultiWriter(f, counted{})
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

func verify(archivePath, asset, sumsPath string) error {
	sums, err := os.ReadFile(sumsPath)
	if err != nil {
		return err
	}
	var want string
	for _, line := range strings.Split(string(sums), "\n") {
		if sum, name, ok := strings.Cut(line, "  "); ok && name == asset {
			want = sum
			break
		}
	}
	if want == "" {
		return fmt.Errorf("checksums.txt has no entry for %s", asset)
	}
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("checksum mismatch for %s: the download is corrupt or was tampered with", asset)
	}
	return nil
}

// extractBinary pulls the single `drawa` file out of the tar.gz, into the same temp dir as the archive.
func extractBinary(archivePath, dir string) (string, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return "", errors.New("archive has no drawa binary")
		}
		if err != nil {
			return "", err
		}
		if filepath.Base(hdr.Name) != "drawa" {
			continue
		}
		out := filepath.Join(dir, "drawa")
		w, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return "", err
		}
		_, err = io.Copy(w, tr)
		w.Close()
		if err != nil {
			return "", err
		}
		return out, nil
	}
}

// replaceSelf swaps the new binary over the running one: a temp file in the same directory (same filesystem,
// so the rename is atomic), then os.Rename, which replaces the name without writing into the running file.
func replaceSelf(newBinary string) error {
	staged := exe + ".new"
	if err := copyFile(newBinary, staged); err != nil {
		os.Remove(staged)
		return fmt.Errorf("can't write to %s: %w", filepath.Dir(exe), err)
	}
	if err := os.Chmod(staged, 0o755); err != nil {
		os.Remove(staged)
		return err
	}
	if err := os.Rename(staged, exe); err != nil {
		os.Remove(staged)
		return err
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Restart replaces this server with the freshly installed binary, the same way main.go's rebuild-on-change does.
// Sessions are killed first (exec would orphan them); the page resumes each one on its next message.
func Restart() {
	live.KillAll()
	err := syscall.Exec(exe, append([]string{exe}, os.Args[1:]...), os.Environ())
	fmt.Println("restart after update failed:", err)
}
