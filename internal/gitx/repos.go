package gitx

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
)

const (
	maxRepos  = 40 // nested repositories the Git window lists; each one is a git status per poll
	repoDepth = 4  // folders below Root searched for them
)

// folders never searched for repositories: dependencies and build output (hidden folders, .git among them, are skipped too)
var skipDirs = map[string]bool{"node_modules": true, "vendor": true, "dist": true, "build": true, "target": true, "venv": true, "__pycache__": true}

var ErrNoRepo = errors.New("not a repository in this project")

var nestedCache = struct {
	sync.Mutex
	at   time.Time
	list []string
}{}

// Nested lists the git repositories in folders below Root (slash-separated, relative to Root, sorted): cloned repos
// side by side in a workspace folder, or repos inside the project's own. Root's own repo isn't one of them, nor is a
// linked worktree of a listed repo (it's listed under its repo). A worktree whose listing failed shows as a repo of its
// own until git answers.
func Nested() []string {
	found := found()
	// Ordering: found() walks folders under nestedCache's lock but runs no git; the worktree lists come from
	// worktreeLists' own cache (one refresh in flight, failures cached), read after that lock is released. Its refresh
	// asks candidates(), never Nested, so neither waits on the other.
	var wts []string
	for _, l := range allWorktrees() {
		wts = append(wts, real(Path(l.id)))
	}
	if len(wts) == 0 {
		return found
	}
	return slices.DeleteFunc(slices.Clone(found), func(f string) bool { return slices.Contains(wts, real(Path(f))) })
}

// found is every folder below Root holding a .git, worktrees included. Searched again every 30 seconds at most, so a
// repo cloned meanwhile shows up soon after.
func found() []string {
	nestedCache.Lock()
	defer nestedCache.Unlock()
	if nestedCache.list == nil || time.Since(nestedCache.at) > 30*time.Second {
		nestedCache.list = findRepos(config.Root)
		nestedCache.at = time.Now()
	}
	return nestedCache.list
}

func findRepos(root string) []string {
	found := []string{}
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		// symlinked folders aren't followed (d.IsDir is false for them): a repo found here is really inside Root
		if err != nil || !d.IsDir() || p == root {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") || skipDirs[d.Name()] {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(root, p)
		if strings.Count(rel, string(filepath.Separator)) >= repoDepth {
			return filepath.SkipDir
		}
		if hasGit(p) {
			found = append(found, filepath.ToSlash(rel))
			if len(found) >= maxRepos {
				return filepath.SkipAll
			}
		}
		return nil // keep looking inside: a repo may hold repos of its own
	})
	slices.Sort(found)
	return found
}

// hasGit says dir holds a repo: a .git folder, or a .git file (submodules, worktrees) whose gitdir still exists. A
// worktree left behind after git worktree prune keeps a .git file pointing at nothing; git calls it not a repository,
// so listing it would only show an unreadable group.
func hasGit(dir string) bool {
	p := filepath.Join(dir, ".git")
	fi, err := os.Lstat(p)
	if err != nil || fi.IsDir() {
		return err == nil
	}
	b, err := os.ReadFile(p)
	target, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir: ")
	if err != nil || !ok {
		return false
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(dir, target)
	}
	fi, err = os.Stat(target)
	return err == nil && fi.IsDir()
}

// Repos are the repositories the Git and GitHub windows offer: "" (Root's own) when Root is in one, then Nested.
func Repos() []string { return repos(Nested()) }

// candidates are the repos whose worktrees are listed: Repos before worktrees are left out of it.
func candidates() []string { return repos(found()) }

func repos(nested []string) []string {
	prefix()
	prefixCache.Lock()
	own := prefixCache.ok // known once git answered: Root is in a repo (a failure isn't cached, so a git init shows up)
	prefixCache.Unlock()
	if own {
		return append([]string{""}, nested...)
	}
	return nested
}

// Check is repoDir's verdict alone, for callers that run other programs in a repo (gh).
func Check(repo string) error { _, err := repoDir(repo); return err }

// Path is repo's folder (Root for ""); check it first.
// A worktree outside Root has its absolute path as its id.
func Path(repo string) string {
	if p := filepath.FromSlash(repo); filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(config.Root, filepath.FromSlash(repo))
}

// repoDir checks repo names Root ("") or one of the Nested repos, or a linked worktree of one of them: the page can
// only point git at a folder Drawa found.
func repoDir(repo string) (string, error) {
	if repo == "" || slices.Contains(Nested(), repo) || isWorktree(repo) {
		return repo, nil
	}
	return "", ErrNoRepo
}

// pathIn turns p from the page into a path relative to repo's folder. A worktree's paths are already relative to it
// (it may be outside Root); anyone else's are relative to Root.
func pathIn(repo, p string, wt bool) (string, error) {
	if wt {
		return config.Within(Path(repo), p)
	}
	rel, err := rootRel(p)
	if err != nil {
		return "", err
	}
	return inRepo(repo, rel)
}

// inRepo turns rel (relative to Root, from rootRel) into a path relative to repo, the folder git runs in for it. A path
// outside that repo is refused: staging it there would name a file of another repo, or none.
func inRepo(repo, rel string) (string, error) {
	if repo == "" {
		return rel, nil
	}
	dir := filepath.FromSlash(repo)
	r, err := filepath.Rel(dir, rel)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", config.ErrOutside
	}
	return r, nil
}
