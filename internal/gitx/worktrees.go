package gitx

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/procx"
)

const maxWorktrees = 40 // listed per repo; each is a git status per poll

// Worktree is a linked worktree of a repository: its folder, the branch checked out there ("" when detached), and
// whether it's locked (git worktree lock: not to be removed).
type Worktree struct {
	Path   string
	Branch string
	Locked bool
}

// worktrees lists the linked worktrees of the repository whose folder is dir, from `git worktree list --porcelain -z`
// (run through command(), so untrusted-mode flags apply; not GitOpts, whose Check would ask for this very list). The
// first entry is the main worktree: left out, and if it isn't dir, dir is itself a linked worktree, which lists none
// of its own. Bare and prunable (folder gone) entries are left out, and so is any entry that fails validWorktree: git
// lists whatever a .git/worktrees/<name>/gitdir file names. A folder that isn't a repo lists none; the error is for
// git not answering (the timeout), when the list is unknown rather than empty.
func worktrees(dir string) ([]Worktree, error) {
	env, argv := command(dir, []string{"worktree", "list", "--porcelain", "-z"})
	r, err := procx.RunEnv(10*time.Second, "", env, argv...)
	if err != nil {
		return nil, err
	}
	if r.Code != 0 {
		return nil, nil
	}
	list := parseWorktrees(r.Stdout, dir)
	if len(list) == 0 {
		return nil, nil
	}
	env, argv = command(dir, []string{"rev-parse", "--git-common-dir"})
	c, err := procx.RunEnv(10*time.Second, "", env, argv...)
	if err != nil {
		return nil, err
	}
	common := strings.TrimSpace(c.Stdout)
	if c.Code != 0 || common == "" {
		return nil, errors.New("no git dir")
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	admin := filepath.Join(real(common), "worktrees")
	return slices.DeleteFunc(list, func(w Worktree) bool { return !validWorktree(w.Path, admin) }), nil
}

// validWorktree is git's own validate_worktree: path/.git is a file (not a folder, not a link) whose gitdir is one of
// admin's entries, and that entry's gitdir file points back at it. A forged entry naming any other folder fails.
func validWorktree(path, admin string) bool {
	dotgit := filepath.Join(path, ".git")
	if fi, err := os.Lstat(dotgit); err != nil || !fi.Mode().IsRegular() {
		return false
	}
	b, err := os.ReadFile(dotgit)
	if err != nil {
		return false
	}
	g, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
	if !ok {
		return false
	}
	entry := realIn(path, strings.TrimSpace(g))
	if filepath.Dir(entry) != admin {
		return false
	}
	back, err := os.ReadFile(filepath.Join(entry, "gitdir"))
	return err == nil && realIn(entry, strings.TrimSpace(string(back))) == real(dotgit)
}

// realIn resolves p, relative to dir when it isn't absolute (worktree.useRelativePaths).
func realIn(dir, p string) string {
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	return real(p)
}

// parseWorktrees reads porcelain -z output: attribute lines end in NUL, an entry ends in an empty one.
func parseWorktrees(out, dir string) []Worktree {
	var list []Worktree
	var w Worktree
	first, skip, started := true, false, false
	for _, line := range strings.Split(out, "\x00") {
		key, val, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			w, skip, started = Worktree{Path: filepath.Clean(val)}, false, true
		case "branch":
			w.Branch = strings.TrimPrefix(val, "refs/heads/")
		case "locked":
			w.Locked = true
		case "bare", "prunable":
			skip = true
		case "":
			if !started {
				continue
			}
			started = false
			if first {
				first = false
				if !samePath(w.Path, dir) {
					return nil
				}
				continue
			}
			if !skip {
				list = append(list, w)
			}
		}
	}
	return list
}

func samePath(a, b string) bool { return real(a) == real(b) }

func real(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

// linked is a listed repo's worktree: id is its repo id (slash path relative to Root, or absolute outside it), main
// the id of the repo it belongs to ("" for Root's).
type linked struct {
	id, main string
	locked   bool
}

var wtCache = struct {
	sync.Mutex
	at     time.Time
	list   []linked // nil: not read, or forgotten
	failed []string
	good   map[string][]linked // each repo's last list read
	busy   chan struct{}       // the refresh in flight, closed when it's done
	gen    int                 // bumped by forgetWorktrees, so a refresh begun before it isn't kept
}{}

// allWorktrees lists the worktrees of Root's repo and of the Nested ones. Kept as long as the status cache (3s), so
// Check and the status poll don't run git per request; one the agent just added is usable a few seconds later. A repo
// whose listing fails keeps its last good list; failures are cached too, so a hung repo costs one timeout per 3s, not
// one per caller.
func allWorktrees() []linked {
	l, _ := worktreeLists()
	return l
}

// worktreeLists is allWorktrees, with the repos whose list is unknown (it failed and was never read). git runs without
// the lock held: a fresh cache answers at once, and callers that miss wait for the one refresh in flight.
func worktreeLists() ([]linked, []string) {
	for {
		wtCache.Lock()
		if wtCache.list != nil && time.Since(wtCache.at) <= 3*time.Second {
			l, f := wtCache.list, wtCache.failed
			wtCache.Unlock()
			return l, f
		}
		if ch := wtCache.busy; ch != nil {
			wtCache.Unlock()
			<-ch
			continue
		}
		ch, gen := make(chan struct{}), wtCache.gen
		wtCache.busy = ch
		wtCache.Unlock()
		return refreshWorktrees(ch, gen)
	}
}

// refreshWorktrees reads the lists and stores them; busy is cleared in a defer, so a panic can't leave waiters stuck.
func refreshWorktrees(ch chan struct{}, gen int) ([]linked, []string) {
	defer func() {
		wtCache.Lock()
		wtCache.busy = nil
		close(ch)
		wtCache.Unlock()
	}()
	list, failed := readWorktrees()
	wtCache.Lock()
	if gen == wtCache.gen {
		wtCache.list, wtCache.failed, wtCache.at = list, failed, time.Now()
	}
	wtCache.Unlock()
	return list, failed
}

// readWorktrees runs git worktree list for every candidate repo, four at a time.
func readWorktrees() ([]linked, []string) {
	repos := candidates()
	lists := make([][]linked, len(repos))
	errs := make([]error, len(repos))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, repo := range repos {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			wts, err := worktrees(top(repo))
			errs[i] = err
			mine := []linked{}
			for j, w := range wts {
				if j >= maxWorktrees {
					break
				}
				mine = append(mine, linked{wtID(w.Path), repo, w.Locked})
			}
			lists[i] = mine
		}()
	}
	wg.Wait()
	wtCache.Lock()
	defer wtCache.Unlock()
	if wtCache.good == nil {
		wtCache.good = map[string][]linked{}
	}
	list, failed := []linked{}, []string(nil)
	for i, repo := range repos {
		if errs[i] == nil {
			wtCache.good[repo] = lists[i]
		} else if last, ok := wtCache.good[repo]; ok {
			lists[i] = last
		} else {
			failed = append(failed, repo)
			continue
		}
		list = append(list, lists[i]...)
	}
	return list, failed
}

// forgetWorktrees drops the cached lists, after a worktree was removed.
func forgetWorktrees() {
	wtCache.Lock()
	wtCache.list = nil
	wtCache.gen++
	wtCache.Unlock()
	nestedCache.Lock()
	nestedCache.list = nil // a worktree inside Root may have been hidden from it
	nestedCache.Unlock()
}

func isWorktree(id string) bool { _, ok := worktreeOf(id); return ok }

// worktreeOf is the listed worktree whose id is id; false if it isn't one.
func worktreeOf(id string) (linked, bool) {
	for _, l := range allWorktrees() {
		if id != "" && l.id == id {
			return l, true
		}
	}
	return linked{}, false
}

func wtID(path string) string {
	if r, err := filepath.Rel(config.Root, path); err == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return filepath.ToSlash(r)
	}
	return filepath.ToSlash(path)
}

// top is repo's top folder: Root may be a subfolder of its own repo, whose worktrees are listed in the top's git dir.
func top(repo string) string {
	if repo != "" {
		return Path(repo)
	}
	dir := config.Root
	for _, seg := range strings.Split(strings.Trim(prefix(), "/"), "/") {
		if seg != "" {
			dir = filepath.Dir(dir)
		}
	}
	return dir
}
