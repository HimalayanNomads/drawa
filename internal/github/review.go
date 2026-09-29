package github

import (
	"encoding/json"
	"strings"
	"time"
	"unicode"
)

var reviewFlags = map[string]string{"approve": "--approve", "request-changes": "--request-changes", "comment": "--comment"}

// review submits a review of a pull request: approve (a comment is optional), request changes or comment (one needed).
func review(b map[string]any) map[string]any {
	n, err := Num(b["n"])
	if err != nil {
		return fail(err)
	}
	flag, ok := reviewFlags[s(b["event"])]
	if !ok {
		return fail(errf("A review approves, requests changes or comments."))
	}
	text := strings.TrimSpace(s(b["body"]))
	args := []string{"pr", "review", n, flag}
	if text != "" {
		args = append(args, "--body-file", "-")
	} else if flag != "--approve" {
		return fail(errf("Say what should change (or what you're commenting) first."))
	}
	return reply(Gh(0, text, args...))
}

// lineComment comments on one line of a pull request's diff, on its newest commit. RIGHT is the line as it is now
// (added or unchanged), LEFT as it was (removed).
func lineComment(b map[string]any) map[string]any {
	n, err := Num(b["n"])
	if err != nil {
		return fail(err)
	}
	line, err := Num(b["line"])
	if err != nil {
		return fail(err)
	}
	path, side, text := s(b["path"]), s(b["side"]), strings.TrimSpace(s(b["body"]))
	if side != "LEFT" && side != "RIGHT" {
		return fail(errf("bad side"))
	}
	if path == "" || len(path) > 1000 || strings.ContainsFunc(path, unicode.IsControl) {
		return fail(errf("bad path"))
	}
	if text == "" {
		return fail(errf("Write a comment first."))
	}
	head, err := Gh(0, "", "pr", "view", n, "--json", "headRefOid", "--jq", ".headRefOid")
	if err != nil {
		return fail(err)
	}
	req, _ := json.Marshal(map[string]any{"body": text, "commit_id": strings.TrimSpace(head), "path": path, "line": json.Number(line), "side": side})
	out, err := Gh(0, string(req), "api", "-X", "POST", "repos/{owner}/{repo}/pulls/"+n+"/comments", "--input", "-", "--jq", ".html_url")
	return reply(out, err)
}

var mergeFlags = map[string]string{"squash": "--squash", "merge": "--merge", "rebase": "--rebase"}

func merge(b map[string]any) map[string]any {
	n, err := Num(b["n"])
	if err != nil {
		return fail(err)
	}
	flag, ok := mergeFlags[s(b["method"])]
	if !ok {
		return fail(errf("Merge by squash, merge or rebase."))
	}
	return reply(Gh(120*time.Second, "", "pr", "merge", n, flag))
}

// setState closes or reopens a pull request or issue, or marks a draft pull request ready for review.
func setState(b map[string]any) map[string]any {
	n, err := Num(b["n"])
	if err != nil {
		return fail(err)
	}
	act, k := s(b["action"]), kind(b)
	if act != "close" && act != "reopen" && !(act == "ready" && k == "pr") {
		return fail(errf("bad action %q", act))
	}
	return reply(Gh(0, "", k, act, n))
}
