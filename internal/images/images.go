// Package images stores pictures on the canvas as files, outside the project (no repo noise), named by their
// content's hash.
package images

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"claude-ui/internal/config"
)

const Max = 15_000_000

var magic = []struct {
	sig  []byte
	kind string
}{
	{[]byte("\x89PNG\r\n\x1a\n"), "image/png"},
	{[]byte("\xff\xd8\xff"), "image/jpeg"},
	{[]byte("GIF8"), "image/gif"},
}

func Type(data []byte) string {
	if len(data) >= 12 && bytes.HasPrefix(data, []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")) {
		return "image/webp"
	}
	for _, m := range magic {
		if bytes.HasPrefix(data, m.sig) {
			return m.kind
		}
	}
	return ""
}

// Store lives outside the project so every address (127.0.0.1:8765, the Vite dev server) sees the same pictures.
var Store_ = storeDir()

func storeDir() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "claude-ui", "images")
}

var HashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Store keeps image bytes in the store -> their key (the hash). ponytail: never garbage-collected; files are
// small and shared by content, so removing a window can't tell whether another layout still shows the same picture.
func Store(data []byte) string {
	sum := sha256.Sum256(data)
	key := hex.EncodeToString(sum[:])
	f := filepath.Join(Store_, key)
	if _, err := os.Stat(f); err != nil {
		os.MkdirAll(Store_, 0o755)
		tmp := f + ".part"
		if os.WriteFile(tmp, data, 0o644) == nil {
			os.Rename(tmp, f) // never a half-written picture
		}
	}
	return key
}

// Save stores an image the page sends (base64) -> its key.
func Save(b64 string) map[string]any {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return map[string]any{"error": "not base64"}
	}
	if len(data) > Max || Type(data) == "" {
		return map[string]any{"error": "not a PNG, JPEG, GIF or WebP image under 15MB"}
	}
	return map[string]any{"key": Store(data)}
}

// Stash stores an image Claude named (absolute, or relative to the project) -> its key.
func Stash(path string) (string, error) {
	if len(path) > 0 && path[0] == '~' {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, path[1:])
		}
	}
	f := path
	if !filepath.IsAbs(f) {
		f = filepath.Join(config.Root, f)
	}
	info, err := os.Stat(f)
	if err != nil || info.IsDir() {
		return "", fmt.Errorf("No file at %s.", f)
	}
	if info.Size() > Max {
		return "", fmt.Errorf("%s is over %dMB.", f, Max/1_000_000)
	}
	data, err := os.ReadFile(f)
	if err != nil {
		return "", err
	}
	if Type(data) == "" {
		return "", fmt.Errorf("%s isn't a PNG, JPEG, GIF or WebP image.", f)
	}
	return Store(data), nil
}
