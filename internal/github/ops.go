package github

import (
	"regexp"
	"strings"
	"time"

	"claude-ui/internal/gitx"
	"claude-ui/internal/procx"
)

// branchRe matches a branch name, never something git or gh would read as an option (no leading -).
var branchRe = regexp.MustCompile(`^[\w./][\w./-]*$`)

func BranchArg(b string) (string, error) {
	if !branchRe.MatchString(b) {
		return "", errf("%q isn't a branch name.", b)
	}
	return b, nil
}

// Draft writes a pull request title and description for this branch against base, via a one-off Claude call.
func Draft(base string) map[string]any {
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
	ok, out := procx.Haiku(prompt, text)
	if !ok {
		return map[string]any{"error": out}
	}
	title, body, _ := strings.Cut(out, "\n")
	title = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(title), "# "))
	return map[string]any{"title": title, "body": strings.TrimSpace(body)}
}

// Op carries out a write operation from the GitHub window (checkout, draft, create a PR, or comment).
func Op(body map[string]any) map[string]any {
	op, _ := body["op"].(string)
	switch op {
	case "checkout":
		n, err := Num(body["n"])
		if err != nil {
			return map[string]any{"ok": false, "out": err.Error()}
		}
		out, err := Gh(120*time.Second, "", "pr", "checkout", n)
		if err != nil {
			return map[string]any{"ok": false, "out": err.Error()}
		}
		return map[string]any{"ok": true, "out": strings.TrimSpace(out)}
	case "draft":
		base := strings.TrimSpace(str(body["base"]))
		if base == "" {
			base = "main"
		}
		return Draft(base)
	case "create":
		title, base := strings.TrimSpace(str(body["title"])), strings.TrimSpace(str(body["base"]))
		if title == "" || base == "" {
			return map[string]any{"ok": false, "out": "A pull request needs a title and a base branch."}
		}
		if _, err := BranchArg(base); err != nil {
			return map[string]any{"ok": false, "out": err.Error()}
		}
		ok, out := gitx.GitOpts(gitx.Opts{Timeout: 120 * time.Second}, "push", "-u", "origin", "HEAD")
		if !ok { // gh can't open a PR for a branch GitHub doesn't have
			if len(out) > 2000 {
				out = out[len(out)-2000:]
			}
			return map[string]any{"ok": false, "out": out}
		}
		args := []string{"pr", "create", "--title=" + title, "--base=" + base, "--body-file", "-"}
		if truthy(body["draft"]) {
			args = append(args, "--draft")
		}
		created, err := Gh(120*time.Second, str(body["body"]), args...)
		if err != nil {
			return map[string]any{"ok": false, "out": err.Error()}
		}
		return map[string]any{"ok": true, "out": strings.TrimSpace(created)}
	case "comment":
		kind := "issue"
		if s(body["kind"]) == "pr" {
			kind = "pr"
		}
		text := strings.TrimSpace(str(body["body"]))
		if text == "" {
			return map[string]any{"ok": false, "out": "Write a comment first."}
		}
		n, err := Num(body["n"])
		if err != nil {
			return map[string]any{"ok": false, "out": err.Error()}
		}
		out, err := Gh(0, text, kind, "comment", n, "--body-file", "-")
		if err != nil {
			return map[string]any{"ok": false, "out": err.Error()}
		}
		return map[string]any{"ok": true, "out": strings.TrimSpace(out)}
	}
	return map[string]any{"ok": false, "out": "unknown op " + op}
}

func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func truthy(v any) bool { b, _ := v.(bool); return b }
