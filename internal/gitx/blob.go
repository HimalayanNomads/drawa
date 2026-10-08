package gitx

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"drawa/internal/procx"
)

const blobMax = 1 << 20

// Blob is one file's text at commit rev, or in the index when rev is "": a diff's "show more lines" reads the lines
// around its hunks from it. path is from repo's top when top is set (a commit's or a pull request's diff), else as the
// Git window's file rows give it (from Root, or from a worktree's own folder). The text is nil when the file isn't
// there (deleted, or a commit that was never fetched), is binary or is over 1 MB. cat-file, not show: no textconv or
// filters run on it.
func Blob(repo, rev, path string, top bool) (map[string]any, error) {
	if rev != "" && !hashRe.MatchString(rev) { // never an option or a revision expression
		return nil, errors.New("not a commit hash")
	}
	repo, err := repoDir(repo)
	if err != nil {
		return nil, err
	}
	spec := ""
	if top {
		if !filepath.IsLocal(path) {
			return nil, errors.New("not a path in the repo")
		}
		spec = rev + ":" + filepath.ToSlash(path)
	} else {
		rel, err := pathIn(repo, path, isWorktree(repo))
		if err != nil {
			return nil, err
		}
		spec = rev + ":./" + filepath.ToSlash(rel) // "./": from the folder git runs in, Root, a nested repo or a worktree
	}
	env, argv := command(repo, []string{"cat-file", "blob", spec})
	r, err := procx.RunLimit(30*time.Second, blobMax, "", env, argv...)
	if err != nil || r.Code != 0 || r.Truncated || strings.IndexByte(r.Stdout, 0) >= 0 {
		return map[string]any{"text": nil}, nil
	}
	return map[string]any{"text": string(bytes.ToValidUTF8([]byte(r.Stdout), []byte("�")))}, nil
}
