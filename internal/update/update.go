// Package update checks GitHub Releases for a newer drawa and, if asked, installs it in place. It mirrors
// install.sh's own recipe (same repo, same asset names, same checksum file) so the two paths never disagree.
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
	"syscall"
	"time"

	"drawa/internal/live"
)

// Version is "dev" for a plain `go build`; the release workflow overrides it with the release tag via
// -ldflags -X, so only release binaries ever see an update as available.
var Version = "dev"

const repo = "probablysamir/drawa" // matches install.sh's $repo
const ttl = 6 * time.Hour

type Info struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	URL       string `json:"url"`
	Available bool   `json:"available"`
}

var cache = struct {
	sync.Mutex
	val     Info
	checked time.Time
	loading bool
}{}

// Check returns the last-known answer, kicking off a background refresh if it's stale (or missing). The very
// first call after boot blocks (nothing cached yet); every call after that returns immediately.
func Check() (Info, error) {
	if Version == "dev" { // no meaningful "current version" to compare, so never nag a source checkout
		return Info{Current: Version}, nil
	}
	cache.Lock()
	fresh := time.Since(cache.checked) < ttl
	loading := cache.loading
	val := cache.val
	if !fresh && !loading {
		cache.loading = true
	}
	cache.Unlock()

	if fresh {
		return val, nil
	}
	if loading {
		if val.Latest == "" { // first call ever: nothing to return yet, so wait for it
			return refresh()
		}
		return val, nil
	}
	return refresh()
}

func refresh() (Info, error) {
	latest, url, err := latestTag()
	cache.Lock()
	defer cache.Unlock()
	cache.loading = false
	if err != nil {
		return cache.val, err
	}
	cache.checked = time.Now()
	cache.val = Info{Current: Version, Latest: latest, URL: url, Available: newer(latest, Version)}
	return cache.val, nil
}

// latestTag reads releases/latest's redirect target (install.sh:48's trick): no API call, so no rate limit
// or auth needed for a public repo.
func latestTag() (tag, url string, err error) {
	return resolveTag("https://github.com/" + repo + "/releases/latest")
}

func resolveTag(latestURL string) (tag, url string, err error) {
	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest(http.MethodHead, latestURL, nil)
	resp, err := client.Do(req)
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
		if i >= 3 {
			break
		}
		out[i], _ = strconv.Atoi(s)
	}
	return out
}

// Install downloads the release matching this machine, verifies its checksum and replaces the running binary
// on disk. It never kills a session or restarts the process — call Restart for that, after responding to
// whoever asked for the install (the process image is gone the instant that happens).
func Install() error {
	info, err := Check()
	if err != nil {
		return err
	}
	if !info.Available {
		return errors.New("no update available")
	}
	asset := fmt.Sprintf("drawa-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	base := "https://github.com/" + repo + "/releases/download/" + info.Latest

	tmp, err := os.MkdirTemp("", "drawa-update-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	archivePath := filepath.Join(tmp, asset)
	if err := download(base+"/"+asset, archivePath); err != nil {
		return fmt.Errorf("downloading %s: %w", asset, err)
	}
	sumsPath := filepath.Join(tmp, "checksums.txt")
	if err := download(base+"/checksums.txt", sumsPath); err != nil {
		return fmt.Errorf("downloading checksums.txt: %w", err)
	}
	if err := verify(archivePath, asset, sumsPath); err != nil {
		return err
	}
	bin, err := extractBinary(archivePath, tmp)
	if err != nil {
		return err
	}
	return replaceSelf(bin)
}

func download(url, dest string) error {
	resp, err := http.Get(url)
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
	_, err = io.Copy(f, resp.Body)
	return err
}

func verify(archivePath, asset, sumsPath string) error {
	sums, err := os.ReadFile(sumsPath)
	if err != nil {
		return err
	}
	var want string
	for _, line := range strings.Split(string(sums), "\n") {
		if _, name, ok := strings.Cut(line, "  "); ok && name == asset {
			want, _, _ = strings.Cut(line, " ")
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
// so the rename is atomic) then os.Rename, which unlinks the old file's name without needing to write into a
// currently-executing one.
func replaceSelf(newBinary string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return err
	}
	staged := exe + ".new"
	if err := copyFile(newBinary, staged); err != nil {
		return err
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
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// Restart kills every live session (exec would orphan them) and re-execs into the binary Install already put
// in place. Only call this after a caller has been told installation succeeded: nothing after this line runs.
func Restart() {
	live.KillAll()
	exe, err := os.Executable()
	if err != nil {
		return
	}
	syscall.Exec(exe, os.Args, os.Environ())
}
