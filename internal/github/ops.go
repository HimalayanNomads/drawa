package github

import (
	"cmp"
	"regexp"
	"strings"
	"time"

	"drawa/internal/gitx"
	"drawa/internal/live"
)

// branchRe matches a branch name, never something git or gh would read as an option (no leading -).
var branchRe = regexp.MustCompile(`^[\w./][\w./-]*$`)

func BranchArg(b string) (string, error) {
	if !branchRe.MatchString(b) {
		return "", errf("%q isn't a branch name.", b)
	}
	return b, nil
}

// Draft writes a pull request title and description for this branch against base, via a one-off call to the named
// agent backend ("": the first installed one).
func Draft(base, backend string) map[string]any {
	base, err := BranchArg(base)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	ref := base
	if ok, _ := gitx.Git("rev-parse", "--verify", "-q", "origin/"+base); ok {
		ref = "origin/" + base
	} else if ok, errOut := gitx.Git("rev-parse", "--verify", base); !ok {
		return map[string]any{"error": "No branch " + base + " here or on origin: " + errOut}
	}
	ok1, log := gitx.Git("log", "--format=%s%n%b", ref+"..HEAD")
	ok2, diff := gitx.Git("diff", "--stat", "--patch", ref+"...HEAD")
	if !ok1 || !ok2 || strings.TrimSpace(diff) == "" {
		return map[string]any{"error": "No changes between " + base + " and this branch to describe."}
	}
	prompt := "Write a GitHub pull request for these commits and diff. First line: the title (imperative, under 70 characters). " +
		"Then a blank line, then the description in Markdown: what changed and why, and anything a reviewer should check. " +
		"Keep it short. Reply with the title and description only, no code fences."
	text := "Commits:\n" + log + "\n\nDiff:\n" + diff
	if len(text) > 100_000 {
		text = text[:100_000]
	}
	ok, out := live.Write(backend, prompt, text)
	if !ok {
		return map[string]any{"error": out}
	}
	title, body, _ := strings.Cut(out, "\n")
	title = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(title), "# "))
	return map[string]any{"title": title, "body": strings.TrimSpace(body)}
}

// ops are the GitHub window's writes, by name. Each validates its own input before anything reaches gh, and gh gets
// its arguments as argv (never through a shell); free text (bodies, titles) goes on stdin or as one --flag=value.
var ops = map[string]func(map[string]any) map[string]any{
	"checkout": checkout,
	"draft": func(b map[string]any) map[string]any {
		return Draft(cmp.Or(strings.TrimSpace(s(b["base"])), "main"), s(b["backend"]))
	},
	"create":      createPr,
	"comment":     comment,
	"review":      review,
	"linecomment": lineComment,
	"merge":       merge,
	"state":       setState,
	"newissue":    newIssue,
	"edit":        edit,
	"rerun":       rerun,
}

// Op carries out a write operation from the GitHub window.
func Op(body map[string]any) map[string]any {
	op := s(body["op"])
	if f, ok := ops[op]; ok {
		return f(body)
	}
	return map[string]any{"ok": false, "out": "unknown op " + op}
}

func fail(err error) map[string]any { return map[string]any{"ok": false, "out": err.Error()} }

// reply is gh's answer as the page reads it: ok, and what gh printed (a URL, usually) or its error.
func reply(out string, err error) map[string]any {
	if err != nil {
		return fail(err)
	}
	return map[string]any{"ok": true, "out": strings.TrimSpace(out)}
}

// kind is "pr" or "issue": which gh command a shared op (comment, state, edit) runs.
func kind(b map[string]any) string {
	if s(b["kind"]) == "pr" {
		return "pr"
	}
	return "issue"
}

func checkout(b map[string]any) map[string]any {
	n, err := Num(b["n"])
	if err != nil {
		return fail(err)
	}
	return reply(Gh(120*time.Second, "", "pr", "checkout", n))
}

func createPr(b map[string]any) map[string]any {
	title, base := strings.TrimSpace(s(b["title"])), strings.TrimSpace(s(b["base"]))
	if title == "" || base == "" {
		return map[string]any{"ok": false, "out": "A pull request needs a title and a base branch."}
	}
	if _, err := BranchArg(base); err != nil {
		return fail(err)
	}
	ok, out := gitx.GitOpts(gitx.Opts{Timeout: 120 * time.Second}, "push", "-u", "origin", "HEAD")
	if !ok { // gh can't open a PR for a branch GitHub doesn't have
		if len(out) > 2000 {
			out = out[len(out)-2000:]
		}
		return map[string]any{"ok": false, "out": out}
	}
	args := []string{"pr", "create", "--title=" + title, "--base=" + base, "--body-file", "-"}
	if truthy(b["draft"]) {
		args = append(args, "--draft")
	}
	return reply(Gh(120*time.Second, s(b["body"]), args...))
}

func comment(b map[string]any) map[string]any {
	text := strings.TrimSpace(s(b["body"]))
	if text == "" {
		return map[string]any{"ok": false, "out": "Write a comment first."}
	}
	n, err := Num(b["n"])
	if err != nil {
		return fail(err)
	}
	return reply(Gh(0, text, kind(b), "comment", n, "--body-file", "-"))
}
