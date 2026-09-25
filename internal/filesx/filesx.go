// Package filesx serves the file tree panel and @ mention search.
package filesx

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

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
		items = append(items, TreeItem{Name: e.Name(), Dir: isDir(filepath.Join(p, e.Name()), e)})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Dir != items[j].Dir {
			return items[i].Dir // dirs first
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	return items, nil
}

// isDir follows a symlink, like Python's is_dir(): a linked folder is a folder.
func isDir(path string, e os.DirEntry) bool {
	if e.Type()&os.ModeSymlink == 0 {
		return e.IsDir()
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
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
	var index time.Time
	if info, err := os.Stat(filepath.Join(config.Root, ".git", "index")); err == nil {
		index = info.ModTime()
	}
	filesCache.Lock()
	if time.Since(filesCache.at) < 30*time.Second && index.Equal(filesCache.index) {
		defer filesCache.Unlock()
		return filesCache.list, filesCache.low
	}
	filesCache.Unlock() // not held while listing: a big walk mustn't stall every search behind it
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
			if len(files) > 50_000 { // ponytail: huge trees get cut off; a real index if that bites
				return filepath.SkipAll
			}
			if err != nil {
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 && isDir(path, d) { // like os.walk: a linked folder, not entered
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
	filesCache.Lock()
	filesCache.at, filesCache.index, filesCache.list, filesCache.low = time.Now(), index, files, low
	filesCache.Unlock()
	return files, low
}

// spread: query letters in order inside text -> how spread out the tightest left-anchored match is (-1 if none).
func spread(q, text string) int {
	best := -1
	starts := 0
	first, size := utf8.DecodeRuneInString(q)
	for i, ch := range text { // in characters throughout, like Python, so non-ASCII names match and measure right
		if starts >= 20 { // ponytail: first 20 starts is plenty for paths
			break
		}
		if ch != first {
			continue
		}
		starts++
		end := i + size // just past the last matched character
		ok := true
		for _, c := range q[size:] {
			idx := strings.IndexRune(text[end:], c)
			if idx < 0 {
				ok = false
				break
			}
			end += idx + utf8.RuneLen(c)
		}
		if ok {
			span := utf8.RuneCountInString(text[i:end]) - utf8.RuneCountInString(q)
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
		if scores[i].plen != scores[j].plen {
			return scores[i].plen < scores[j].plen
		}
		return scores[i].path < scores[j].path
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

// Get reads a file for the viewer.
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
	if bytes.IndexByte(data, 0) >= 0 {
		return map[string]any{"text": nil}, nil
	}
	return map[string]any{"text": toUTF8(data)}, nil
}

func toUTF8(b []byte) string {
	return strings.ToValidUTF8(string(b), "�")
}
