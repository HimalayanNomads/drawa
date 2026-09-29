// Package github wraps the gh CLI: its login, its permissions. Nothing GitHub-related is stored here.
package github

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"drawa/internal/gitx"
	"drawa/internal/procx"
)

type Error struct{ msg string }

func (e *Error) Error() string { return e.msg }
func errf(format string, a ...any) *Error {
	return &Error{fmt.Sprintf(format, a...)}
}

var ghEnv = append(os.Environ(), "GH_PROMPT_DISABLED=1", "NO_COLOR=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_PAGER=")

// Gh runs gh in the project; returns its output or a *Error with gh's own message.
func Gh(timeout time.Duration, stdin string, args ...string) (string, error) {
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	r, err := procx.RunEnv(timeout, stdin, ghEnv, append([]string{"gh"}, args...)...)
	if err != nil {
		var execErr *exec.Error
		if errors.As(err, &execErr) {
			return "", errf("The GitHub CLI (gh) isn't installed. Get it from https://cli.github.com, then run `gh auth login`.")
		}
		return "", &Error{err.Error()}
	}
	if r.Code != 0 {
		msg := r.Stderr
		if msg == "" {
			msg = r.Stdout
		}
		msg = strings.TrimSpace(msg)
		if len(msg) > 2000 {
			msg = msg[:2000]
		}
		if msg == "" {
			msg = fmt.Sprintf("gh exited with %d", r.Code)
		}
		return "", &Error{msg}
	}
	return r.Stdout, nil
}

func GhJSON(timeout time.Duration, stdin string, v any, args ...string) error {
	out, err := Gh(timeout, stdin, args...)
	if err != nil {
		return err
	}
	if strings.TrimSpace(out) == "" {
		out = "null"
	}
	return json.Unmarshal([]byte(out), v)
}

func Num(v any) (string, error) {
	s := fmt.Sprint(v)
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n <= 0 {
		return "", errf("bad number")
	}
	return strconv.Itoa(n), nil
}

// Checks merges GitHub's two kinds of status (check runs and commit statuses) into one list: name, state, url.
// The same check run runs again on re-runs and on push + pull_request events, so keep only the newest per name.
func Checks(rollup []any) []map[string]any {
	type row struct {
		newness [2]any
		val     map[string]any
	}
	out := map[string]row{}
	order := []string{}
	for _, ci := range rollup {
		c, ok := ci.(map[string]any)
		if !ok {
			continue
		}
		var r map[string]any
		var st string
		if s(c["__typename"]) == "StatusContext" {
			st = map[string]string{"SUCCESS": "pass", "PENDING": "pending", "EXPECTED": "pending"}[s(c["state"])]
			if st == "" {
				st = "fail"
			}
			r = map[string]any{"name": s(c["context"]), "state": st, "url": s(c["targetUrl"])}
		} else {
			done := s(c["status"]) == "COMPLETED"
			if !done {
				st = "pending"
			} else {
				st = map[string]string{"SUCCESS": "pass", "NEUTRAL": "skip", "SKIPPED": "skip"}[s(c["conclusion"])]
				if st == "" {
					st = "fail"
				}
			}
			name := s(c["workflowName"])
			if n := s(c["name"]); n != "" {
				if name != "" {
					name += " / " + n
				} else {
					name = n
				}
			}
			r = map[string]any{"name": name, "state": st, "url": s(c["detailsUrl"])}
		}
		ts := cmp.Or(s(c["startedAt"]), s(c["completedAt"]), s(c["createdAt"]))
		newness := [2]any{ts, st == "pending"}
		name, _ := r["name"].(string)
		prev, exists := out[name]
		if !exists {
			order = append(order, name)
		}
		if !exists || newnessGE(newness, prev.newness) {
			out[name] = row{newness, r}
		}
	}
	res := make([]map[string]any, 0, len(order))
	for _, name := range order {
		res = append(res, out[name].val)
	}
	return res
}

func newnessGE(a, b [2]any) bool {
	as, bs := a[0].(string), b[0].(string)
	if as != bs {
		return as >= bs
	}
	return truthy(a[1]) == truthy(b[1]) || truthy(a[1])
}
func truthy(v any) bool { b, _ := v.(bool); return b }
func s(v any) string    { x, _ := v.(string); return x }

func who(a any) string {
	m, ok := a.(map[string]any)
	if !ok {
		return ""
	}
	return s(m["login"])
}

func labels(r map[string]any) []string {
	raw, _ := r["labels"].([]any)
	out := make([]string, 0, len(raw))
	for _, l := range raw {
		if m, ok := l.(map[string]any); ok {
			out = append(out, s(m["name"]))
		}
	}
	return out
}

const PRList = "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,updatedAt,statusCheckRollup,labels,state"
const ListMax = 50 // rows the lists show; they fetch one more to know there are more
const DiffMax = 400_000

func PrRow(p map[string]any) map[string]any {
	checks, _ := p["statusCheckRollup"].([]any)
	return map[string]any{
		"number": p["number"], "title": p["title"], "author": who(p["author"]),
		"head": p["headRefName"], "base": p["baseRefName"], "draft": p["isDraft"],
		"review": orEmpty(p["reviewDecision"]), "updated": p["updatedAt"], "state": p["state"],
		"labels": labels(p), "checks": Checks(checks),
	}
}

func orEmpty(v any) any {
	if v == nil {
		return ""
	}
	return v
}

var repoCache = struct {
	sync.Mutex
	val map[string]any
}{}

// Repo is the repo's name, url and default branch: asked once (a slow call); an error isn't cached, so it's retried.
func Repo() (map[string]any, error) {
	repoCache.Lock()
	defer repoCache.Unlock()
	if repoCache.val != nil {
		return repoCache.val, nil
	}
	var v map[string]any
	if err := GhJSON(0, "", &v, "repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"); err != nil {
		return nil, err
	}
	repoCache.val = v
	return v, nil
}

var meCache = struct {
	sync.Mutex
	login string
}{}

// Me is the login gh acts as and the repo it acts on: what every confirm names before something is published.
func Me() (map[string]any, error) {
	repo, err := Repo()
	if err != nil {
		return nil, err
	}
	meCache.Lock()
	defer meCache.Unlock()
	if meCache.login == "" {
		out, err := Gh(0, "", "api", "user", "--jq", ".login")
		if err != nil {
			return nil, err
		}
		meCache.login = strings.TrimSpace(out)
	}
	return map[string]any{"login": meCache.login, "repo": repo["nameWithOwner"]}, nil
}

// State is the repo on GitHub, and the pull request for the branch you're on (if any).
func State() map[string]any {
	_, branch := gitx.Git("branch", "--show-current") // empty on detached HEAD: no pull request to look for
	repo, err := Repo()
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	var prs []map[string]any
	if branch != "" {
		if err := GhJSON(0, "", &prs, "pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", PRList+",url"); err != nil {
			return map[string]any{"ok": false, "error": err.Error()}
		}
	}
	var pr any
	if len(prs) > 0 {
		row := PrRow(prs[0])
		row["url"] = prs[0]["url"]
		pr = row
	}
	def := ""
	if br, ok := repo["defaultBranchRef"].(map[string]any); ok {
		def = s(br["name"])
	}
	return map[string]any{
		"ok": true, "repo": repo["nameWithOwner"], "url": repo["url"], "default": def, "branch": branch, "pr": pr,
	}
}

func IssueRow(i map[string]any) map[string]any {
	return map[string]any{
		"number": i["number"], "title": i["title"], "author": who(i["author"]),
		"updated": i["updatedAt"], "state": i["state"], "labels": labels(i),
	}
}

func Comment(c map[string]any) map[string]any {
	author := c["author"]
	if author == nil {
		author = c["user"]
	}
	when := cmp.Or(s(c["createdAt"]), s(c["submittedAt"]), s(c["created_at"]))
	return map[string]any{"author": who(author), "body": s(c["body"]), "when": when}
}
