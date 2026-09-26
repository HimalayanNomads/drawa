package procx

import (
	"testing"
	"time"

	"drawa/internal/config"
)

// A command writing past the limit is cut off (not buffered whole) and marked Truncated; one under it isn't.
func TestRunLimit(t *testing.T) {
	config.Root = t.TempDir()
	r, err := RunLimit(10*time.Second, 1000, "", nil, "head", "-c", "100000", "/dev/zero") // bounded, even if the cap failed
	if err != nil || !r.Truncated || len(r.Stdout) != 1000 {
		t.Fatalf("got %v, truncated=%v, %d bytes", err, r != nil && r.Truncated, len(r.Stdout))
	}
	r, err = RunLimit(10*time.Second, 1000, "", nil, "echo", "hi")
	if err != nil || r.Truncated || r.Stdout != "hi\n" || r.Code != 0 {
		t.Fatalf("small output: %v %#v", err, r)
	}
}
