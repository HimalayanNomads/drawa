// Package symbols is a project-wide index of code definitions (name -> file, line, kind) for Ctrl+K's Symbols and
// a diff's go to definition. It is read from universal-ctags when that's installed (one binary, every language
// built in); without it every lookup is simply empty. This is name-based lookup, not a language server: no types,
// no references. ponytail: ctags' scanners are regexes per language; swap in tree-sitter tags behind Fuzzy/Exact if
// their accuracy bites.
package symbols

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/filesx"
)

// Symbol is one definition: its name, where it is, and ctags' own per-language kind ("func", "class", "method"...).
type Symbol struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Line  int    `json:"line"`
	Kind  string `json:"kind"`
	Scope string `json:"scope,omitempty"` // what it's defined in: a class, a package, a struct
	local bool   // inside a function: kept for a diff's go to definition, left out of Ctrl+K
}

// skipLanguages are data and prose rather than code: ctags tags every JSON key and Markdown heading, which would
// bury the definitions. Filtered here rather than with --languages, which fails on names an older ctags lacks.
var skipLanguages = map[string]bool{
	"JSON": true, "Markdown": true, "Yaml": true, "XML": true, "SVG": true, "PlistXML": true, "Iniconf": true,
	"Asciidoc": true, "ReStructuredText": true, "Man": true, "Tex": true, "BibTeX": true, "Org": true,
	"FrontMatter": true, "JavaProperties": true, "RMarkdown": true, "Quarto": true, "Txt2tags": true, "Passwd": true,
}

// in a function: these scopes' tags are its locals (and helpers nested in it)
var functionScopes = map[string]bool{"function": true, "func": true, "method": true, "subroutine": true, "procedure": true}

// maxSymbols caps the index. ponytail: a huge monorepo past this loses the rest; a per-folder index if that bites.
const maxSymbols = 500_000

var found = struct {
	sync.Mutex
	bin     string
	checked time.Time
}{}

// ctags is the universal-ctags binary, "" when there isn't one. Apple's and Exuberant ctags answer to the same name
// but can't write JSON, so the binary has to say it can. A miss is checked again after a few seconds: installing it
// shouldn't need a restart.
func ctags() string {
	found.Lock()
	defer found.Unlock()
	if found.bin != "" || time.Since(found.checked) < 10*time.Second {
		return found.bin
	}
	found.checked = time.Now()
	for _, name := range []string{"ctags", "uctags", "universal-ctags"} {
		p, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		out, _ := exec.Command(p, "--list-features").Output()
		if slices.ContainsFunc(strings.Split(string(out), "\n"), func(l string) bool { return strings.HasPrefix(l, "json ") }) {
			found.bin = p
			break
		}
	}
	return found.bin
}

// Installed says whether lookups can answer: universal-ctags with JSON output is on the PATH.
func Installed() bool { return ctags() != "" }

// managers is each package manager and its command for universal-ctags, in the order Install tries them.
var managers = [][2]string{
	{"brew", "brew install universal-ctags"},
	{"pacman", "sudo pacman -S ctags"},
	{"apt-get", "sudo apt install universal-ctags"},
	{"dnf", "sudo dnf install ctags"},
	{"zypper", "sudo zypper install ctags"},
	{"apk", "sudo apk add ctags"},
	{"nix-env", "nix-env -iA nixpkgs.universal-ctags"},
	{"winget", "winget install UniversalCtags.Ctags"},
}

// Install is the command that installs universal-ctags here, from the first package manager on PATH; "" when
// none is, and the page then points to the project's site.
func Install() string {
	for _, m := range managers {
		if _, err := exec.LookPath(m[0]); err == nil {
			return m[1]
		}
	}
	return ""
}

var building sync.Mutex // one ctags run at a time

var cache = struct {
	sync.Mutex
	at    time.Time
	index time.Time
	syms  []Symbol
	low   []string
}{}

// all is the index, built on first use and kept for 30s or until the git index changes, like @ search's file list.
// A stale index is answered right away while a fresh one is built in the background: re-reading a big project
// mustn't stall typing in Ctrl+K. ponytail: an edit that isn't staged shows up after 30s at the earliest.
func all() ([]Symbol, []string) {
	if !Installed() {
		return nil, nil
	}
	var index time.Time
	if info, err := os.Stat(filepath.Join(config.Root, ".git", "index")); err == nil {
		index = info.ModTime()
	}
	cache.Lock()
	syms, low, built := cache.syms, cache.low, !cache.at.IsZero()
	fresh := built && time.Since(cache.at) < 30*time.Second && index.Equal(cache.index)
	cache.Unlock()
	if fresh {
		return syms, low
	}
	if built {
		go func() {
			if building.TryLock() { // already rebuilding: that one will do
				defer building.Unlock()
				rebuild(index)
			}
		}()
		return syms, low
	}
	building.Lock()
	defer building.Unlock()
	cache.Lock()
	if !cache.at.IsZero() { // built while this waited
		defer cache.Unlock()
		return cache.syms, cache.low
	}
	cache.Unlock()
	return rebuild(index)
}

func rebuild(index time.Time) ([]Symbol, []string) {
	syms := run(filesx.List())
	low := make([]string, len(syms))
	for i, s := range syms {
		low[i] = strings.ToLower(s.Name)
	}
	cache.Lock()
	cache.at, cache.index, cache.syms, cache.low = time.Now(), index, syms, low
	cache.Unlock()
	return syms, low
}

// run tags the project's files (git's list, so .gitignore applies). --options=NONE comes first so a cloned
// project's .ctags.d can't change what runs, or where it writes; --links=no keeps files linked from outside out.
func run(files []string) []Symbol {
	bin := ctags()
	if bin == "" || len(files) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--options=NONE", "--quiet", "--output-format=json", "--fields=+nl-P",
		"--links=no", "-L", "-", "-f", "-")
	cmd.Dir = config.Root
	cmd.Stdin = strings.NewReader(strings.Join(files, "\n") + "\n")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil
	}
	if cmd.Start() != nil {
		return nil
	}
	syms := parse(out)
	io.Copy(io.Discard, out) // past the cap: let ctags finish rather than block on a full pipe
	cmd.Wait()
	return syms
}

type tag struct {
	Type      string `json:"_type"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Line      int    `json:"line"`
	Kind      string `json:"kind"`
	Language  string `json:"language"`
	Scope     string `json:"scope"`
	ScopeKind string `json:"scopeKind"`
}

// parse reads ctags' JSON lines (ctags-json-output(5)): tags only, code only, up to maxSymbols.
func parse(r io.Reader) []Symbol {
	br := bufio.NewReader(r)
	syms := []Symbol{}
	for len(syms) < maxSymbols {
		line, err := br.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var t tag
			// a name with spaces is a compound CSS selector or a heading, not something code calls by name
			if json.Unmarshal(line, &t) == nil && t.Type == "tag" && t.Line > 0 && !skipLanguages[t.Language] &&
				t.Name != "" && !strings.ContainsAny(t.Name, " \t") {
				syms = append(syms, Symbol{Name: t.Name, Path: filepath.ToSlash(t.Path), Line: t.Line, Kind: t.Kind,
					Scope: t.Scope, local: functionScopes[t.ScopeKind]})
			}
		}
		if err != nil {
			break
		}
	}
	return syms
}

type scored struct {
	score float64
	sym   Symbol
}

func (a scored) less(b scored) bool {
	if a.score != b.score {
		return a.score < b.score
	}
	if len(a.sym.Name) != len(b.sym.Name) {
		return len(a.sym.Name) < len(b.sym.Name)
	}
	if a.sym.Path != b.sym.Path {
		return a.sym.Path < b.sym.Path
	}
	return a.sym.Line < b.sym.Line
}

// Fuzzy finds definitions by name for Ctrl+K, ranked like @ file search: the whole name, its start, inside it, then
// the query's letters in order, not too spread out; tighter matches and shorter names first. Function locals are
// left out.
func Fuzzy(q string, limit int) []Symbol {
	q = strings.ToLower(strings.ReplaceAll(q, " ", ""))
	if q == "" {
		return []Symbol{}
	}
	syms, low := all()
	top := make([]scored, 0, limit+1)
	for i, s := range syms {
		if s.local {
			continue
		}
		var score float64
		n := low[i]
		if n == q {
			score = 0
		} else if strings.HasPrefix(n, q) {
			score = 1
		} else if idx := strings.Index(n, q); idx >= 0 {
			score = 5 + float64(idx)/100
		} else if g := filesx.Spread(q, n); g >= 0 && g <= 2*len(q) { // looser is noise across 100k names
			score = float64(20 + g)
		} else {
			continue
		}
		c := scored{score, s}
		at := sort.Search(len(top), func(j int) bool { return c.less(top[j]) })
		if at >= limit {
			continue
		}
		top = slices.Insert(top, at, c)
		if len(top) > limit {
			top = top[:limit]
		}
	}
	out := make([]Symbol, len(top))
	for i, s := range top {
		out[i] = s.sym
	}
	return out
}

// Exact is every definition with exactly this name, for a diff's go to definition: the project-wide ones first,
// then function locals. Several are normal (a common name); the page lets you pick.
func Exact(name string, limit int) []Symbol {
	if name == "" {
		return []Symbol{}
	}
	syms, _ := all()
	var top, locals []Symbol
	for _, s := range syms {
		if s.Name != name {
			continue
		}
		if s.local {
			locals = append(locals, s)
		} else {
			top = append(top, s)
		}
	}
	out := append(top, locals...)
	return append([]Symbol{}, out[:min(len(out), limit)]...)
}
