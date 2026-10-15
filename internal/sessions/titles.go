package sessions

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
)

// MaxListed is how many sessions the history list and a search return.
const MaxListed = 50

type Info struct {
	ID      string  `json:"id"`
	Title   string  `json:"title"`
	Mtime   float64 `json:"mtime"`
	Backend string  `json:"backend,omitempty"` // which agent backend it belongs to (set by the server's merged list)
}

// titles is what a transcript is called, gathered as it's read: the CLI appends a `custom-title` line on /rename
// and an `ai-title` line when it names the session itself, again and again as it goes (the last one counts).
type titles struct {
	offset    int64     // how far the file has been read: transcripts only grow, so the next read starts here
	modified  time.Time // the file's mtime at that read: the same size with a newer one means it was rewritten
	prompt    string    // the first thing typed
	replied   bool      // the model answered: a transcript without that (Drawa's /usage probe) isn't listed
	custom    string    // the user's /rename
	generated string    // the CLI's own name for it
}

// title is what the list calls a session: your /rename first, then the CLI's name for it, then your first prompt.
func (t *titles) title() string {
	if !t.replied {
		return ""
	}
	for _, name := range []string{t.custom, t.generated, t.prompt} {
		if name != "" {
			return name
		}
	}
	return "(no prompt)"
}

// matches: every word of query is in one of the session's names or its id.
func (t *titles) matches(id, query string) bool {
	return Matches(strings.Join([]string{t.custom, t.generated, t.prompt, id}, "\n"), query)
}

// Matches: every word of query (case-insensitive) is somewhere in text. Backends without a search of their own
// filter their list with it.
func Matches(text, query string) bool {
	text = strings.ToLower(text)
	for _, word := range strings.Fields(strings.ToLower(query)) {
		if !strings.Contains(text, word) {
			return false
		}
	}
	return true
}

var (
	customMark    = []byte(`"custom-title"`)
	generatedMark = []byte(`"ai-title"`)
)

// A first read of a long transcript skips its middle: the first prompt and reply are near the start, and the CLI
// writes its title lines again and again as it goes, so the newest is near the end. ponytail: a /rename followed by
// more than tailBytes without another title line is missed (the list falls back to the generated name or prompt).
const (
	headBytes   = 1 << 20 // read the lines starting in this much of a long transcript's start for its first prompt and reply
	tailBytes   = 1 << 20 // and then this much of its end for its titles
	maxHeadLine = 8 << 20 // a line crossing headBytes is read whole up to this (a first message with a pasted picture)
)

// read takes in the lines written since the last read. A last line without its newline is still being written:
// it's left for next time.
func (t *titles) read(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return
	}
	switch size := info.Size(); {
	case size < t.offset, size == t.offset && !info.ModTime().Equal(t.modified):
		*t = titles{} // rewritten, not appended to: start over
	case size == t.offset:
		return // nothing written since: the list asks after every turn, mostly of files that haven't changed
	}
	defer func() { t.modified = info.ModTime() }()
	if t.offset == 0 && info.Size() > headBytes+tailBytes {
		t.skim(f, info.Size())
		return
	}
	t.readFrom(f)
}

// readFrom takes in every whole line from t.offset on.
func (t *titles) readFrom(f *os.File) {
	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return
	}
	eachLine(f, func(line []byte) bool {
		if line[len(line)-1] != '\n' {
			return false
		}
		t.offset += int64(len(line))
		t.take(line)
		return true
	})
}

// skim is a long transcript's first read: its start until the first prompt and reply are found (lines starting in
// its first headBytes; the one crossing it is read whole if it ends within maxHeadLine more), then its last
// tailBytes.
func (t *titles) skim(f *os.File, size int64) {
	eachLine(f, func(line []byte) bool {
		end := t.offset + int64(len(line))
		if line[len(line)-1] != '\n' || t.offset >= headBytes || end > headBytes+maxHeadLine {
			return false
		}
		t.offset += int64(len(line))
		t.take(line)
		return t.prompt == "" || !t.replied
	})
	tail := size - tailBytes
	if tail <= t.offset {
		t.readFrom(f)
		return
	}
	// the tail starts mid-line: step past that line's end, then read on as usual
	if _, err := f.Seek(tail, io.SeekStart); err != nil {
		return
	}
	partial, err := bufio.NewReader(f).ReadBytes('\n')
	if err != nil {
		return
	}
	t.offset = tail + int64(len(partial))
	t.readFrom(f)
}

// take reads one line: a prompt or a reply until both are found, and every title line.
func (t *titles) take(line []byte) {
	// most lines are neither: a cheap look before decoding (the marks can also be in a message's text, hence the type check)
	named := bytes.Contains(line, customMark) || bytes.Contains(line, generatedMark)
	if !named && t.prompt != "" && t.replied {
		return
	}
	var entry struct {
		Type        string `json:"type"`
		IsMeta      bool   `json:"isMeta"`
		CustomTitle string `json:"customTitle"`
		AITitle     string `json:"aiTitle"`
		Message     struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &entry) != nil {
		return
	}
	switch {
	case entry.Type == "custom-title" && entry.CustomTitle != "":
		t.custom = truncate(entry.CustomTitle, 120, "")
	case entry.Type == "ai-title" && entry.AITitle != "":
		t.generated = truncate(entry.AITitle, 120, "")
	case entry.Type == "assistant":
		t.replied = true
	case entry.Type == "user" && !entry.IsMeta && t.prompt == "":
		t.prompt = promptText(entry.Message.Content)
	}
}

// promptText is what the user typed in a message's content, or "" if it's only tool results or the CLI's own text.
func promptText(raw json.RawMessage) string {
	var c string
	if json.Unmarshal(raw, &c) != nil {
		var blocks []struct{ Type, Text string }
		json.Unmarshal(raw, &blocks)
		for _, b := range blocks {
			if b.Type == "text" && !strings.HasPrefix(b.Text, "<") {
				c = b.Text
				break
			}
		}
	}
	if strings.HasPrefix(c, "<") {
		return ""
	}
	return truncate(c, 120, "")
}

// titleCache keeps each transcript's titles and how far it was read, so a list or a search reads only what was
// written since. Each entry has its own lock: searches a keystroke apart that both find a transcript unread take
// turns on it, so the second reads only what the first left, rather than both reading it all.
var titleCache = struct {
	sync.Mutex
	byPath map[string]*cachedTitles
}{byPath: map[string]*cachedTitles{}}

type cachedTitles struct {
	sync.Mutex
	titles
}

// titlesOf brings a transcript's titles up to date and returns a copy of them.
func titlesOf(path string) titles {
	titleCache.Lock()
	cached := titleCache.byPath[path]
	if cached == nil {
		cached = &cachedTitles{}
		titleCache.byPath[path] = cached
	}
	titleCache.Unlock()
	cached.Lock()
	defer cached.Unlock()
	cached.read(path)
	return cached.titles
}

// forgetGone drops the cached titles of transcripts that are no longer there, so the cache holds this folder's
// sessions and no more.
func forgetGone(all []transcript) {
	kept := make(map[string]bool, len(all))
	for _, file := range all {
		kept[file.path] = true
	}
	titleCache.Lock()
	defer titleCache.Unlock()
	for path := range titleCache.byPath {
		if !kept[path] {
			delete(titleCache.byPath, path)
		}
	}
}

type transcript struct {
	path  string
	mtime time.Time
}

// transcripts is every saved session of this folder, newest first.
func transcripts() []transcript {
	entries, err := os.ReadDir(config.Sessions)
	if err != nil {
		return nil
	}
	var all []transcript
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		all = append(all, transcript{filepath.Join(config.Sessions, entry.Name()), info.ModTime()})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].mtime.After(all[j].mtime) })
	return all
}

// List returns the newest sessions. ponytail: the newest MaxListed; older ones are found with Search.
func List() []Info {
	return Search("")
}

// Search returns the newest sessions whose title, generated name, first prompt or id has every word of query; ""
// matches all. It reads every transcript once, then only what each one gained since.
func Search(query string) []Info {
	out := []Info{}
	all := transcripts()
	forgetGone(all)
	for _, file := range all {
		if len(out) == MaxListed {
			break
		}
		id := strings.TrimSuffix(filepath.Base(file.path), ".jsonl")
		names := titlesOf(file.path)
		title := names.title()
		if title == "" || !names.matches(id, query) {
			continue
		}
		out = append(out, Info{ID: id, Title: title, Mtime: float64(file.mtime.UnixNano()) / 1e9})
	}
	return out
}
