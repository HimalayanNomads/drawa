package gitx

import (
	"regexp"
	"strconv"
	"strings"
)

// Ref is one line in the project that uses a name.
type Ref struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

var refName = regexp.MustCompile(`^[A-Za-z_$][\w$]{0,99}$`)

const (
	refsMax    = 200
	refTextMax = 200
)

// Refs lists the lines in the project's files that use `name` as a whole word (find references from a diff's
// names), up to 20 a file. Paths are relative to Root. ponytail: a word match with git grep in the project's own repo, not a
// language server: it finds comments and strings too, and skips nested repos and projects that aren't repos.
func Refs(name string) []Ref {
	out := []Ref{}
	if !refName.MatchString(name) {
		return out
	}
	ok, text := GitOpts(Opts{}, "grep", "-n", "-I", "-w", "-F", "--no-color", "--max-count=20", "--untracked", "-e", name, "--", ".")
	if !ok { // exit 1 is "no match"; anything else (not a repo) is nothing to show either
		return out
	}
	for _, l := range strings.Split(text, "\n") {
		path, rest, ok1 := strings.Cut(l, ":")
		num, line, ok2 := strings.Cut(rest, ":")
		n, err := strconv.Atoi(num)
		if !ok1 || !ok2 || err != nil {
			continue
		}
		line = strings.TrimSpace(line)
		if len(line) > refTextMax {
			line = strings.ToValidUTF8(line[:refTextMax], "") + "…"
		}
		out = append(out, Ref{Path: path, Line: n, Text: line})
		if len(out) == refsMax {
			break
		}
	}
	return out
}
