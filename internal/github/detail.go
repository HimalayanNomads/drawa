package github

import (
	"regexp"
	"strings"
	"sync"
	"time"

	"drawa/internal/gitx"
)

// Pr fetches one pull request in full: its diff, comments, reviews and inline (line) comments. The three `gh`
// calls are independent (none needs another's result), so they run concurrently rather than one after another.
func Pr(n string) (map[string]any, error) {
	n, err := Num(n)
	if err != nil {
		return nil, err
	}
	var p map[string]any
	var pages []any
	var diff string
	var viewErr, pagesErr error
	var derr error
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		fields := PRList + ",url,body,additions,deletions,changedFiles,reviews,comments,mergeable,createdAt"
		viewErr = GhJSON(0, "", &p, "pr", "view", n, "--json", fields)
	}()
	go func() {
		defer wg.Done()
		// comments on lines of code (reviews' inline comments): not in `pr view`. --slurp: every page, as one list of pages.
		pagesErr = GhJSON(0, "", &pages, "api", "--paginate", "--slurp", "repos/{owner}/{repo}/pulls/"+n+"/comments?per_page=100")
	}()
	go func() {
		defer wg.Done()
		diff, derr = Gh(0, "", "pr", "diff", n)
	}()
	wg.Wait()
	if viewErr != nil {
		return nil, viewErr
	}
	var inline []map[string]any
	inlineError := ""
	if pagesErr != nil {
		inlineError = strings.SplitN(pagesErr.Error(), "\n", 2)[0]
	} else {
		for _, page := range pages {
			if items, ok := page.([]any); ok {
				for _, it := range items {
					if m, ok := it.(map[string]any); ok {
						inline = append(inline, m)
					}
				}
			}
		}
	}
	if derr != nil {
		diff = "(no diff: " + derr.Error() + ")"
	}
	diffTrunc := len(diff) > DiffMax
	if diffTrunc {
		diff = diff[:DiffMax]
	}
	var comments, reviews []map[string]any
	for _, c := range asList(p["comments"]) {
		comments = append(comments, Comment(c))
	}
	for _, r := range asList(p["reviews"]) {
		if body, _ := r["body"].(string); body != "" || s(r["state"]) != "COMMENTED" {
			row := Comment(r)
			row["state"] = r["state"]
			reviews = append(reviews, row)
		}
	}
	var inlineOut []map[string]any
	for _, c := range inline {
		row := Comment(c)
		row["path"] = c["path"]
		line := c["line"]
		if line == nil {
			line = c["original_line"]
		}
		row["line"] = line
		hunk := s(c["diff_hunk"])
		if len(hunk) > 600 {
			hunk = hunk[len(hunk)-600:]
		}
		row["hunk"] = hunk
		inlineOut = append(inlineOut, row)
	}
	row := PrRow(p)
	row["url"] = p["url"]
	row["body"] = s(p["body"])
	row["additions"] = p["additions"]
	row["deletions"] = p["deletions"]
	row["files"] = p["changedFiles"]
	row["mergeable"] = p["mergeable"]
	row["created"] = p["createdAt"]
	row["comments"] = gitx.NonNil(comments)
	row["reviews"] = gitx.NonNil(reviews)
	row["inline"] = gitx.NonNil(inlineOut)
	row["inline_error"] = inlineError
	row["diff"] = diff
	row["diff_truncated"] = diffTrunc
	return row, nil
}

func asList(v any) []map[string]any {
	raw, _ := v.([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, x := range raw {
		if m, ok := x.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func Issue(n string) (map[string]any, error) {
	nn, err := Num(n)
	if err != nil {
		return nil, err
	}
	var i map[string]any
	if err := GhJSON(0, "", &i, "issue", "view", nn, "--json", "number,title,body,author,state,labels,url,comments,createdAt,updatedAt"); err != nil {
		return nil, err
	}
	row := IssueRow(i)
	row["body"] = s(i["body"])
	row["url"] = i["url"]
	row["created"] = i["createdAt"]
	var comments []map[string]any
	for _, c := range asList(i["comments"]) {
		comments = append(comments, Comment(c))
	}
	row["comments"] = gitx.NonNil(comments)
	return row, nil
}

var runJobRe = regexp.MustCompile(`/actions/runs/(\d+)/job/(\d+)`)

// Log is the failing steps' log of a GitHub Actions job (from a check's details URL), for Claude to read.
func Log(url string) (map[string]any, error) {
	m := runJobRe.FindStringSubmatch(url)
	if m == nil {
		return nil, errf("Only GitHub Actions checks have logs here; open the check's page for others.")
	}
	out, err := Gh(120*time.Second, "", "run", "view", m[1], "--job", m[2], "--log-failed")
	if err != nil {
		// ponytail: matched on gh's error text; GitHub answers 410 Gone once a run's logs have expired
		if strings.Contains(err.Error(), "HTTP 410") {
			return nil, errf("GitHub no longer keeps this run's logs (they expire).")
		}
		return nil, err
	}
	if len(out) > 20_000 {
		out = out[len(out)-20_000:]
	}
	return map[string]any{"log": out}, nil
}
