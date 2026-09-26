package filesx

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"drawa/internal/config"
)

func useRoot(t *testing.T) string {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	old := config.Root
	t.Cleanup(func() { config.Root = old })
	config.Root = root
	return root
}

func TestGetRefusesFIFO(t *testing.T) {
	root := useRoot(t)
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o600); err != nil {
		t.Skip("no FIFOs here:", err)
	}
	done := make(chan error, 1)
	go func() { _, err := Get("pipe"); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Error("Get read a FIFO")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Get hung on a FIFO")
	}
}

func TestTreeCapsBigFolders(t *testing.T) {
	root := useRoot(t)
	for i := 0; i < maxTree+5; i++ {
		os.WriteFile(filepath.Join(root, fmt.Sprintf("f%05d", i)), nil, 0o600)
	}
	items, err := Tree("")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != maxTree+1 || items[maxTree].More != 5 || items[maxTree].Name != "" {
		t.Errorf("got %d items, last %+v; want %d + a {More: 5} marker", len(items), items[len(items)-1], maxTree)
	}
}
