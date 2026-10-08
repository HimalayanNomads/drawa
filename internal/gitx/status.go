package gitx

import (
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

var stateCache = struct {
	sync.Mutex
	at    time.Time
	state map[string]any
}{}

// GitState is Root's git status, with each nested repo's in "nested", shared by every page for a few seconds: each
// open Git window polls it.
func GitState() map[string]any {
	stateCache.Lock()
	defer stateCache.Unlock()
	if stateCache.state == nil || time.Since(stateCache.at) > 3*time.Second {
		stateCache.state = allStatus()
		stateCache.at = time.Now()
	}
	return stateCache.state
}

// allStatus is Root's status and its nested repos', each with its linked worktrees' in "worktrees", a few at a time. A
// nested repo or worktree that isn't yet tracked by Root's own shows there as an untracked folder: that row is left
// out, it has its own list.
func allStatus() map[string]any {
	repos := Nested()
	wts, failed := worktreeLists()
	// ponytail: one git status per worktree each poll, capped at maxWorktrees (40) per repo but with no total cap across
	// repos; add a global cap, or poll only the checkout picked in the Git window, if many repos each have many.
	all := make([]map[string]any, 1+len(repos)+len(wts))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i := range all {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			switch {
			case i == 0:
				all[i] = gitStatus("", false)
			case i <= len(repos):
				all[i] = gitStatus(repos[i-1], false)
				all[i]["dir"] = repos[i-1]
			default:
				w := wts[i-1-len(repos)]
				all[i] = gitStatus(w.id, true)
				all[i]["dir"], all[i]["main"] = w.id, w.main
				if w.locked {
					all[i]["locked"] = true
				}
			}
		}()
	}
	wg.Wait()
	st, nested := all[0], all[1:1+len(repos)]
	byID := map[string]map[string]any{"": st}
	for i, r := range repos {
		byID[r] = nested[i]
	}
	own := slices.Clone(repos)
	for i, w := range wts {
		m := byID[w.main]
		if m == nil { // Nested was searched again in between
			continue
		}
		list, _ := m["worktrees"].([]map[string]any)
		m["worktrees"] = append(list, all[1+len(repos)+i])
		own = append(own, w.id)
	}
	for _, r := range failed { // the page keeps its pick in a list it couldn't read
		if m := byID[r]; m != nil {
			m["worktreesFailed"] = true
		}
	}
	if files, ok := st["files"].([]map[string]any); ok && len(own) > 0 {
		kept := files[:0]
		for _, f := range files {
			if p := f["path"].(string); f["x"] != "?" || !slices.Contains(own, strings.TrimSuffix(p, "/")) {
				kept = append(kept, f)
			}
		}
		st["total"] = st["total"].(int) - (len(files) - len(kept))
		st["files"] = kept
	}
	st["nested"] = nested
	return st
}

const GitFiles = 500 // files listed in the Git window; the rest are counted

var aheadRe = regexp.MustCompile(`ahead (\d+)`)
var behindRe = regexp.MustCompile(`behind (\d+)`)

type fileRow struct {
	Path             string
	X, Y             string
	Staged, Unstaged [2]int
}

// parseStatus reads `git status --porcelain=v1 -b -z` -> the branch line and the changed files. Porcelain paths are
// relative to the repo's top even when git runs in a subfolder: prefix (`rev-parse --show-prefix`) is cut off so
// they're relative to Root like every other path the page sends back, and anything outside Root is left out.
func parseStatus(out, prefix string) (head string, files []*fileRow) {
	entries := strings.Split(out, "\x00")
	if len(entries) > 0 && strings.HasPrefix(entries[0], "## ") {
		head = entries[0][3:]
	}
	for i := 1; i < len(entries); i++ {
		e := entries[i]
		if len(e) < 4 {
			continue
		}
		x, y, path := string(e[0]), string(e[1]), e[3:]
		if x == "R" || x == "C" {
			i++ // the rename's old path follows
		}
		if !strings.HasPrefix(path, prefix) {
			continue
		}
		files = append(files, &fileRow{Path: path[len(prefix):], X: x, Y: y})
	}
	return head, files
}

// parseNumstat reads `git diff --numstat -z` -> added/deleted per (new) path. A rename is "a\td\t\0old\0new\0";
// -z keeps paths raw (no quoting, no "{a => b}"), so they match status's.
func parseNumstat(out string) map[string][2]int {
	counts := map[string][2]int{}
	tok := strings.Split(out, "\x00")
	for i := 0; i < len(tok); i++ {
		parts := strings.SplitN(tok[i], "\t", 3)
		if len(parts) < 3 {
			continue
		}
		path := parts[2]
		if path == "" && i+2 < len(tok) {
			path = tok[i+2]
			i += 2
		}
		a, _ := strconv.Atoi(parts[0]) // "-" for binary files: 0
		d, _ := strconv.Atoi(parts[1])
		counts[path] = [2]int{a, d}
	}
	return counts
}

var prefixCache = struct {
	sync.Mutex
	val string
	ok  bool
}{}

// prefix is Root's place in its repo ("" at the top, "sub/dir/" below it). Cached once known: Root never moves.
func prefix() string {
	prefixCache.Lock()
	defer prefixCache.Unlock()
	if !prefixCache.ok {
		if ok, out := Git("rev-parse", "--show-prefix"); ok {
			prefixCache.val, prefixCache.ok = out, true
		}
	}
	return prefixCache.val
}

// gitStatus reports a repo's branch, ahead/behind, changed files (staged / unstaged / untracked with line counts),
// and recent commits. File paths are relative to Root whichever repo they're in, except a worktree's (wt), which may
// be outside Root: relative to the worktree's folder.
func gitStatus(repo string, wt bool) map[string]any {
	if _, err := exec.LookPath("git"); err != nil { // not "no repo": the Git window mustn't offer a git init that can't run
		return map[string]any{"repo": false, "missing": true, "error": "git isn't installed. Get it from https://git-scm.com/downloads, then reopen this window."}
	}
	// "normal", not "all": an untracked folder is one row, not a walk through every file in it (polled every few seconds)
	git := func(args ...string) (bool, string) { return GitOpts(Opts{Repo: repo}, args...) }
	ok, out := git("status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal", "--", ".")
	if !ok {
		return map[string]any{"repo": false, "error": out}
	}
	pre := "" // a nested repo is found at its top, and git runs there
	if repo == "" {
		pre = prefix()
	}
	head, files := parseStatus(out, pre)
	branch := strings.Replace(strings.SplitN(head, "...", 2)[0], "No commits yet on ", "", 1)
	ahead, behind := 0, 0
	if m := aheadRe.FindStringSubmatch(head); m != nil {
		ahead, _ = strconv.Atoi(m[1])
	}
	if m := behindRe.FindStringSubmatch(head); m != nil {
		behind, _ = strconv.Atoi(m[1])
	}
	// line counts only for the sides that have changes: each is a full diff
	var anyStaged, anyUnstaged bool
	for _, f := range files {
		anyStaged = anyStaged || (f.X != " " && f.X != "?")
		anyUnstaged = anyUnstaged || (f.Y != " " && f.X != "?")
	}
	numstat := func(want bool, extra ...string) map[string][2]int {
		if !want {
			return nil
		}
		if ok, out := git(append([]string{"diff", "--numstat", "-z", "--relative"}, extra...)...); ok {
			return parseNumstat(out)
		}
		return nil
	}
	staged, unstaged := numstat(anyStaged, "--cached"), numstat(anyUnstaged)
	for _, f := range files {
		f.Staged, f.Unstaged = staged[f.Path], unstaged[f.Path]
	}
	// %H last: the full hash of HEAD, which a pull request's files are compared against (are they the ones on disk?)
	ok, out = git("log", "-n", "12", "--pretty=format:%h\x1f%s\x1f%cr\x1f%an\x1f%H")
	var log []map[string]string
	headSha := ""
	if ok {
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			p := strings.Split(line, "\x1f")
			for len(p) < 5 {
				p = append(p, "")
			}
			if headSha == "" {
				headSha = p[4]
			}
			log = append(log, map[string]string{"hash": p[0], "subject": p[1], "when": p[2], "author": p[3]})
		}
	}
	fileList := make([]map[string]any, 0, len(files))
	shown := files
	if len(shown) > GitFiles {
		shown = shown[:GitFiles]
	}
	for _, f := range shown {
		if repo != "" && !wt {
			f.Path = repo + "/" + f.Path
		}
		fileList = append(fileList, map[string]any{
			"path": f.Path, "x": f.X, "y": f.Y,
			"staged": []int{f.Staged[0], f.Staged[1]}, "unstaged": []int{f.Unstaged[0], f.Unstaged[1]},
		})
	}
	if branch == "" {
		branch = "(detached)"
	}
	return map[string]any{
		"repo": true, "branch": branch, "upstream": strings.Contains(head, "..."),
		"ahead": ahead, "behind": behind, "files": fileList, "total": len(files), "log": NonNil(log), "head": headSha,
	}
}
