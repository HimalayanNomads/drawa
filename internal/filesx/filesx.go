// Package filesx serves the file tree panel and @ mention search.
package filesx

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"claude-ui/internal/config"
	"claude-ui/internal/gitx"
)

type TreeItem struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
}

func Tree(rel string) ([]TreeItem, error) {
	p, err := config.Inside(rel)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		return nil, err
	}
	items := make([]TreeItem, 0, len(entries))
	for _, e := range entries {
		if e.Name() == ".git" {
			continue
		}
		items = append(items, TreeItem{Name: e.Name(), Dir: e.IsDir()})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Dir != items[j].Dir {
			return items[i].Dir // dirs first
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	return items, nil
}

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "build": true, ".venv": true,
	"venv": true, "__pycache__": true, ".next": true, "target": true,
}

var filesCache = struct {
	sync.Mutex
	at    time.Time
	index time.Time
	list  []string
	low   []string
}{}

// projectFiles lists every file in the project (git's view when it's a repo, so .gitignore applies), cached for
// 30s or until the git index changes. ponytail: a brand-new untracked file can take up to 30s to show up in @ search.
func projectFiles() ([]string, []string) {
	filesCache.Lock()
	defer filesCache.Unlock()
	var index time.Time
	if info, err := os.Stat(filepath.Join(config.Root, ".git", "index")); err == nil {
		index = info.ModTime()
	}
	if time.Since(filesCache.at) < 30*time.Second && index.Equal(filesCache.index) {
		return filesCache.list, filesCache.low
	}
	ok, out := gitx.Git("ls-files", "-co", "--exclude-standard")
	var files []string
	if ok {
		if out != "" {
			files = strings.Split(out, "\n")
		} else {
			files = []string{}
		}
	} else { // not a git repo: walk it, skipping the usual heavy folders
		filepath.WalkDir(config.Root, func(path string, d os.DirEntry, err error) error {
			if err != nil || len(files) > 50_000 { // ponytail: huge trees get cut off; a real index if that bites
				return nil
			}
			if d.IsDir() {
				if path != config.Root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
					return filepath.SkipDir
				}
				return nil
			}
			rel, err := filepath.Rel(config.Root, path)
			if err == nil {
				files = append(files, rel)
			}
			return nil
		})
	}
	low := make([]string, len(files))
	for i, f := range files {
		low[i] = strings.ToLower(f)
	}
	filesCache.at, filesCache.index, filesCache.list, filesCache.low = time.Now(), index, files, low
	return files, low
}

// spread: query letters in order inside text -> how spread out the tightest left-anchored match is (-1 if none).
func spread(q, text string) int {
	best := -1
	starts := 0
	for i, ch := range text {
		if starts >= 20 { // ponytail: first 20 starts is plenty for paths
			break
		}
		if byte(ch) != q[0] {
			continue
		}
		starts++
		pos := i
		ok := true
		for k := 1; k < len(q); k++ {
			idx := strings.IndexByte(text[pos+1:], q[k])
			if idx < 0 {
				ok = false
				break
			}
			pos = pos + 1 + idx
		}
		if ok {
			span := pos - i + 1 - len(q)
			if best < 0 || span < best {
				best = span
			}
		}
	}
	return best
}

type scored struct {
	score float64
	plen  int
	path  string
}

// Find is fuzzy file search for @ mentions. Ranks: substring of the file name, substring of the path, letters in
// order within the file name, then within the path; tighter matches and shorter paths first.
func Find(q string, limit int) []string {
	q = strings.ToLower(strings.ReplaceAll(q, " ", ""))
	files, low := projectFiles()
	var scores []scored
	for i, f := range files {
		l := low[i]
		slash := strings.LastIndex(l, "/")
		name := l
		if slash >= 0 {
			name = l[slash+1:]
		}
		var s float64
		if q == "" {
			s = float64(strings.Count(f, "/"))
		} else if idx := strings.Index(name, q); idx >= 0 {
			s = float64(idx) / 100
		} else if strings.Contains(l, q) {
			s = 10
		} else if g := spread(q, name); g >= 0 {
			s = float64(20 + g)
		} else if g := spread(q, l); g >= 0 {
			s = float64(40 + g)
		} else {
			continue
		}
		scores = append(scores, scored{s, len(f), f})
	}
	sort.Slice(scores, func(i, j int) bool {
		if scores[i].score != scores[j].score {
			return scores[i].score < scores[j].score
		}
		return scores[i].plen < scores[j].plen
	})
	if len(scores) > limit {
		scores = scores[:limit]
	}
	out := make([]string, len(scores))
	for i, s := range scores {
		out[i] = s.path
	}
	return out
}

// Get reads a file for the viewer. ponytail: 1MB cap, viewer not an editor.
func Get(rel string) (map[string]any, error) {
	p, err := config.Inside(rel)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 1_000_000)) // ponytail: 1MB cap, viewer not an editor
	if err != nil {
		return nil, err
	}
	if hasNul(data) {
		return map[string]any{"text": nil}, nil
	}
	return map[string]any{"text": toUTF8(data)}, nil
}

func hasNul(b []byte) bool {
	for _, c := range b {
		if c == 0 {
			return true
		}
	}
	return false
}

func toUTF8(b []byte) string {
	return strings.ToValidUTF8(string(b), "�")
}
