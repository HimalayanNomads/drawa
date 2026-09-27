package live

import (
	"strings"
	"testing"
)

// Write uses the named backend's OneShot, and says why when that backend is unknown, can't, or isn't installed.
func TestWrite(t *testing.T) {
	Register("test-writer", Kind{Bin: "sh", OneShot: func(prompt, text string) (bool, string) { return true, prompt + "|" + text }})
	Register("test-missing", Kind{Bin: "no-such-cli-here", Label: "missing", OneShot: func(string, string) (bool, string) { return true, "" }})
	Register("test-mute", Kind{Bin: "sh"})
	t.Cleanup(func() { delete(kinds, "test-writer"); delete(kinds, "test-missing"); delete(kinds, "test-mute") })

	if ok, out := Write("test-writer", "p", "t"); !ok || out != "p|t" {
		t.Fatalf("named backend: %v %q", ok, out)
	}
	for name, want := range map[string]string{"nope": "No agent", "test-mute": "No agent", "test-missing": "isn't installed"} {
		if ok, out := Write(name, "p", "t"); ok || !strings.Contains(out, want) {
			t.Errorf("%s: %v %q, want an error containing %q", name, ok, out, want)
		}
	}
}
