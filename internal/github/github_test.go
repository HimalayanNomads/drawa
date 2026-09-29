package github

import (
	"reflect"
	"strings"
	"testing"
)

func TestNewestRunPerName(t *testing.T) {
	rollup := []any{
		map[string]any{"__typename": "CheckRun", "workflowName": "CI", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE",
			"startedAt": "2026-01-01T10:00:00Z", "detailsUrl": "old"},
		map[string]any{"__typename": "CheckRun", "workflowName": "CI", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS",
			"startedAt": "2026-01-01T11:00:00Z", "detailsUrl": "rerun"}, // a re-run: the old failure must not stay
		map[string]any{"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SKIPPED", "startedAt": "2026-01-01T10:00:00Z"},
		map[string]any{"__typename": "StatusContext", "context": "deploy", "state": "PENDING", "targetUrl": "d"},
	}
	got := Checks(rollup)
	want := []map[string]any{
		{"name": "CI / test", "state": "pass", "url": "rerun"},
		{"name": "lint", "state": "skip", "url": ""},
		{"name": "deploy", "state": "pending", "url": "d"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Checks() = %#v, want %#v", got, want)
	}
}

// Bad input is turned away before gh runs: with no gh on PATH, any other answer than the validation's means it ran.
func TestOpsValidate(t *testing.T) {
	t.Setenv("PATH", "")
	cases := []struct {
		body map[string]any
		want string
	}{
		{map[string]any{"op": "merge", "n": "-1", "method": "squash"}, "bad number"},
		{map[string]any{"op": "merge", "n": "3; rm -rf /", "method": "squash"}, "bad number"},
		{map[string]any{"op": "merge", "n": 3, "method": "--admin"}, "Merge by squash"},
		{map[string]any{"op": "checkout", "n": "0"}, "bad number"},
		{map[string]any{"op": "create", "title": "t", "base": "--upload-pack=x"}, "isn't a branch name"},
		{map[string]any{"op": "state", "kind": "issue", "n": 2, "action": "ready"}, "bad action"},
		{map[string]any{"op": "state", "kind": "pr", "n": 2, "action": "delete"}, "bad action"},
		{map[string]any{"op": "review", "n": 2, "event": "request-changes"}, "Say what should change"},
		{map[string]any{"op": "linecomment", "n": 2, "line": 4, "side": "UP", "path": "a.go", "body": "x"}, "bad side"},
		{map[string]any{"op": "linecomment", "n": 2, "line": "x", "side": "LEFT", "path": "a.go", "body": "x"}, "bad number"},
		{map[string]any{"op": "newissue", "title": "t", "labels": []any{"bug,wontfix"}}, "isn't a label name"},
		{map[string]any{"op": "newissue", "title": "t", "labels": []any{""}}, "isn't a label name"},
		{map[string]any{"op": "edit", "n": 5, "add_assignees": []any{"--repo=evil/x"}}, "isn't a GitHub login"},
		{map[string]any{"op": "edit", "n": 5}, "Nothing to change"},
		{map[string]any{"op": "rerun", "run": "abc"}, "bad number"},
		{map[string]any{"op": "nope"}, "unknown op"},
	}
	for _, c := range cases {
		got := Op(c.body)
		if got["ok"] != false || !strings.Contains(s(got["out"]), c.want) {
			t.Errorf("Op(%v) = %v, want a refusal with %q", c.body, got, c.want)
		}
	}
}

func TestListArgs(t *testing.T) {
	got := ListArgs("bogus", " --repo=evil/x ", "review", "9999").args("pr", "open", "closed")
	want := []string{"pr", "list", "--state", "open", "--limit", "501", "--search=--repo=evil/x review-requested:@me"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %q, want %q", got, want)
	}
	if got := ListArgs("closed", "", "mine", "").args("issue", "open", "closed"); !reflect.DeepEqual(got, []string{"issue", "list", "--state", "closed", "--limit", "51", "--author", "@me"}) {
		t.Fatalf("args = %q", got)
	}
}
