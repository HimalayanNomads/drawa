package github

import (
	"encoding/base64"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"drawa/internal/gitx"
)

// Blob is a file's text at a pull request's head commit (path from the repo's top), for its diff's "show more lines".
// From the local repo when the commit is there, else from GitHub: a pull request nobody fetched is the usual case.
// The text is nil when the file isn't there (deleted), isn't a file (a submodule), is binary or is over 1 MB.
func Blob(repo, sha, path string) (map[string]any, error) {
	if sha == "" { // gitx.Blob would read the index, not the pull request
		return nil, errors.New("no commit")
	}
	local, err := gitx.Blob(repo, sha, path, true)
	if err != nil || local["text"] != nil || gitx.HasCommit(repo, sha) { // a commit we have: GitHub can't know more
		return local, err
	}
	segs := strings.Split(filepath.ToSlash(path), "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	// the JSON, not the raw media type: GitHub ignores that for directories and submodules and lists them instead
	var f struct{ Type, Encoding, Content string }
	err = GhJSON(repo, 30*time.Second, "", &f, "api", "repos/{owner}/{repo}/contents/"+strings.Join(segs, "/")+"?ref="+sha)
	if err != nil || f.Type != "file" || f.Encoding != "base64" {
		return gitx.BlobText(nil), nil
	}
	b, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(f.Content, "\n", ""))
	if err != nil {
		return gitx.BlobText(nil), nil
	}
	return gitx.BlobText(b), nil
}
