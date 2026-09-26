package images

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStoreIsPrivate(t *testing.T) {
	old := Store_
	t.Cleanup(func() { Store_ = old })
	Store_ = filepath.Join(t.TempDir(), "images")
	key, err := Store([]byte("\x89PNG\r\n\x1a\nfake"))
	if err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(Store_); info.Mode().Perm() != 0o700 {
		t.Errorf("store folder mode %v, want 0700", info.Mode().Perm())
	}
	if info, _ := os.Stat(filepath.Join(Store_, key)); info.Mode().Perm() != 0o600 {
		t.Errorf("image mode %v, want 0600", info.Mode().Perm())
	}
	if left, _ := filepath.Glob(filepath.Join(Store_, "*.part")); len(left) > 0 {
		t.Errorf("temp files left behind: %v", left)
	}
}
