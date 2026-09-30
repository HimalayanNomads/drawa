package prefs

import (
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"testing"
)

// home points ~ at a fresh folder and returns where the settings file goes.
func home(t *testing.T) string {
	t.Helper()
	h := t.TempDir()
	t.Setenv("HOME", h)
	return filepath.Join(h, ".drawa", "config.json")
}

func onDisk(t *testing.T, p string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("%s: %v", data, err)
	}
	return m
}

func TestFirstLoadWritesDefaults(t *testing.T) {
	p := home(t)
	got, err := Load()
	if err != nil || !maps.Equal(got, Defaults) {
		t.Fatalf("Load() = %v, %v", got, err)
	}
	if m := onDisk(t, p); !maps.Equal(m, Defaults) {
		t.Fatalf("saved %v, want the defaults", m)
	}
}

// A file from before a setting existed gets it added; what's already there, known or not, stays.
func TestLoadAddsMissingKeepsTheRest(t *testing.T) {
	p := home(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte(`{"mine": [1, 2]}`), 0o644)
	if got, err := Load(); err != nil || got["ui"] != "full" || got["mine"] != nil {
		t.Fatalf("Load() = %v, %v (only known settings reach the page)", got, err)
	}
	if m := onDisk(t, p); m["ui"] != "full" || m["mine"] == nil {
		t.Fatalf("saved %v, want ui added and mine kept", m)
	}
}

// A hand edit that doesn't parse is left for the user to fix; the defaults apply meanwhile.
func TestBrokenFileNeverOverwritten(t *testing.T) {
	p := home(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	for _, broken := range []string{`{"ui": "minimal",}`, `null`, `[1]`} {
		os.WriteFile(p, []byte(broken), 0o644)
		if got, err := Load(); err == nil || got["ui"] != "full" {
			t.Errorf("%s: Load() = %v, %v; want the defaults and an error", broken, got, err)
		}
		if _, err := Set(map[string]any{"ui": "minimal"}); err == nil {
			t.Errorf("%s: Set wrote over a file it couldn't read", broken)
		}
		if data, _ := os.ReadFile(p); string(data) != broken {
			t.Errorf("file changed to %s", data)
		}
	}
}

func TestSet(t *testing.T) {
	p := home(t)
	got, err := Set(map[string]any{"ui": "minimal"})
	if err != nil || got["ui"] != "minimal" {
		t.Fatalf("Set = %v, %v", got, err)
	}
	if m := onDisk(t, p); m["ui"] != "minimal" {
		t.Fatalf("saved %v", m)
	}
	if got, _ := Load(); got["ui"] != "minimal" {
		t.Fatalf("Load() after Set = %v", got)
	}
	if got, err := Set(map[string]any{"theme": "dark", "darkScheme": "rose-pine-moon"}); err != nil || got["theme"] != "dark" || got["darkScheme"] != "rose-pine-moon" || got["ui"] != "minimal" {
		t.Fatalf("Set theme = %v, %v", got, err)
	}
	for _, bad := range []map[string]any{{"ui": "tiny"}, {"ui": 1}, {"nope": "full"}, {"ui": "full", "nope": "x"},
		{"theme": "auto"}, {"lightScheme": "../x"}, {"darkScheme": "Rose Pine"}, {"darkScheme": ""}} {
		if _, err := Set(bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("Set(%v) = %v, want ErrInvalid", bad, err)
		}
	}
	if m := onDisk(t, p); m["ui"] != "minimal" {
		t.Fatalf("an invalid change touched the file: %v", m)
	}
}

// A value a hand edit got wrong reads as the default, and stays in the file until changed.
func TestInvalidValueReadsAsDefault(t *testing.T) {
	p := home(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte(`{"ui": "Minimal"}`), 0o644)
	if got, err := Load(); err != nil || got["ui"] != "full" {
		t.Fatalf("Load() = %v, %v", got, err)
	}
	if m := onDisk(t, p); m["ui"] != "Minimal" {
		t.Fatalf("saved %v", m)
	}
}
