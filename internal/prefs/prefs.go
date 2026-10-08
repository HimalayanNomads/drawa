// Package prefs is your own Drawa settings, the same for every project and every browser: ~/.drawa/config.json.
// Drawa writes it with the defaults the first time it starts, and adds a setting that's missing from it (one a
// newer version introduced) the next time it reads it. People edit the file by hand, so keys it doesn't know are
// kept as they are, and a file that doesn't parse is never written over: the defaults apply until it's fixed.
package prefs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sync"
)

// Defaults are every setting, as it is until you change it (web/src/lib/prefs.ts has the same). "ui": "full"
// shows every window's tab, "minimal" a window's tab only when you reach for the window. "theme": "system" follows
// the computer's light or dark mode; each mode has its color scheme (the ids in web/src/lib/theme.ts). "symbols":
// "auto" reads code symbols with universal-ctags when it's installed (internal/symbols), "off" never runs it.
// "vim": "on" gives the file editor and scratchpads Vim motions.
var Defaults = map[string]any{"ui": "full", "theme": "system", "lightScheme": "claude-light", "darkScheme": "claude-dark", "symbols": "auto", "vim": "off"}

// checks say which values each setting may take. A scheme is only checked for shape: the page falls back to the
// first scheme when the file names one it doesn't have, so the list of schemes lives in one place.
var checks = map[string]func(string) bool{
	"ui":          oneOf("full", "minimal"),
	"theme":       oneOf("system", "light", "dark"),
	"lightScheme": schemeRe.MatchString,
	"darkScheme":  schemeRe.MatchString,
	"symbols":     oneOf("auto", "off"),
	"vim":         oneOf("off", "on"),
}

var schemeRe = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

func oneOf(values ...string) func(string) bool {
	return func(s string) bool { return slices.Contains(values, s) }
}

// ErrInvalid is a change to a setting that doesn't exist, or to a value it can't take.
var ErrInvalid = errors.New("invalid setting")

var mu sync.Mutex // one read-modify-write of the file at a time

// Path is the settings file, ~/.drawa/config.json.
func Path() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".drawa", "config.json"), nil
}

// Load reads the settings, saving the defaults of any the file doesn't have yet (all of them on the first run).
// It always returns a full set; the error says why the file couldn't be read or saved.
func Load() (map[string]any, error) {
	mu.Lock()
	defer mu.Unlock()
	file, err := read()
	if err != nil {
		return effective(nil), err
	}
	if withDefaults(file) {
		err = write(file)
	}
	return effective(file), err
}

// Set changes some settings and saves them, refusing the lot if any of them is invalid.
func Set(changes map[string]any) (map[string]any, error) {
	if len(changes) == 0 {
		return nil, fmt.Errorf("%w: nothing to change", ErrInvalid)
	}
	for k, v := range changes {
		if !valid(k, v) {
			return nil, fmt.Errorf("%w: %s", ErrInvalid, k)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	file, err := read()
	if err != nil {
		return nil, err
	}
	maps.Copy(file, changes)
	withDefaults(file)
	if err := write(file); err != nil {
		return nil, err
	}
	return effective(file), nil
}

func valid(k string, v any) bool {
	s, isStr := v.(string)
	check, known := checks[k]
	return isStr && known && check(s)
}

// withDefaults adds the settings the file is missing, and says whether there were any.
func withDefaults(file map[string]any) bool {
	added := false
	for k, v := range Defaults {
		if _, ok := file[k]; !ok {
			file[k], added = v, true
		}
	}
	return added
}

// effective is what the page gets: every setting, from the file where it holds a valid value.
func effective(file map[string]any) map[string]any {
	out := maps.Clone(Defaults)
	for k := range out {
		if v, ok := file[k]; ok && valid(k, v) {
			out[k] = v
		}
	}
	return out
}

// read returns the file's settings, none when it doesn't exist yet.
func read() (map[string]any, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	var file map[string]any
	if err := json.Unmarshal(data, &file); err != nil || file == nil {
		return nil, fmt.Errorf("%s isn't a JSON object, so the defaults apply until it's fixed", p)
	}
	return file, nil
}

// write saves the settings through a temporary file, so a crash mid-write can't leave half a file behind.
func write(file map[string]any) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".config-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // gone after the rename; cleans up if anything before it failed
	_, err = tmp.Write(append(data, '\n'))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o644)
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
