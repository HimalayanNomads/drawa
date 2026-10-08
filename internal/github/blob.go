package github

import (
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"drawa/internal/gitx"
)

const blobMax = 1 << 20

// Blob is a file's text at a pull request's head commit (path from the repo's top), for its diff's "show more lines".
// From the local repo when the commit is there, else from GitHub: a pull request nobody fetched is the usual case.
// The text is nil when the file isn't there (deleted), is binary or is over 1 MB.
func Blob(repo, sha, path string) (map[string]any, error) {
	local, err := gitx.Blob(repo, sha, path, true)
	if err != nil || local["text"] != nil {
		return local, err
	}
	segs := strings.Split(filepath.ToSlash(path), "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	out, err := Gh(repo, 30*time.Second, "", "api", "-H", "Accept: application/vnd.github.raw",
		"repos/{owner}/{repo}/contents/"+strings.Join(segs, "/")+"?ref="+sha)
	if err != nil || len(out) > blobMax || strings.IndexByte(out, 0) >= 0 {
		return map[string]any{"text": nil}, nil
	}
	return map[string]any{"text": out}, nil
}
