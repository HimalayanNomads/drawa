package gitx

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"drawa/internal/procx"
)

// Ref is one line in the project that uses a name.
type Ref struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

var refName = regexp.MustCompile(`^[A-Za-z_$][\w$]{0,99}$`)

const (
	refsMax     = 200
	refsPerFile = 20
	refTextMax  = 200
	refsOutMax  = 1 << 20
)

// Refs lists the lines in the project's files that use `name` as a whole word (find references from a diff's
// names), up to 20 a file. Paths are relative to Root. ponytail: a word match with git grep in the project's own repo, not a
// language server: it finds comments and strings too, and skips nested repos and projects that aren't repos.
func Refs(name string) []Ref {
	out := []Ref{}
	if !refName.MatchString(name) {
		return out
	}
	// no --max-count (git 2.38+): the cap per file is counted here, and RunLimit keeps a common name's output bounded
	env, argv := command("", []string{"grep", "-n", "-z", "-I", "-w", "-F", "--no-color", "--untracked", "-e", name, "--", "."})
	r, err := procx.RunLimit(30*time.Second, refsOutMax, "", env, argv...)
	if err != nil || (r.Code != 0 && !r.Truncated) { // exit 1 is "no match"; anything else (not a repo) is nothing to show either
		return out
	}
	lines := strings.Split(r.Stdout, "\n")
	if r.Truncated {
		lines = lines[:len(lines)-1] // the last one was cut off
	}
	per := map[string]int{}
	for _, l := range lines {
		f := strings.SplitN(l, "\x00", 3) // -z: path\0line\0text, so a path with a colon still splits right
		if len(f) < 3 {
			continue
		}
		n, err := strconv.Atoi(f[1])
		if err != nil || per[f[0]] == refsPerFile {
			continue
		}
		per[f[0]]++
		line := strings.TrimSpace(f[2])
		if len(line) > refTextMax {
			line = strings.ToValidUTF8(line[:refTextMax], "") + "…"
		}
		out = append(out, Ref{Path: f[0], Line: n, Text: line})
		if len(out) == refsMax {
			break
		}
	}
	return out
}
