package github

import (
	"strconv"
	"strings"
)

// List is what the GitHub window's lists ask for: a state, GitHub search syntax, one quick filter, and how many.
type List struct {
	State, Search, Filter string
	Limit                 int
}

// ListArgs reads a list request from the query string: unknown states and filters fall back, the limit is clamped.
func ListArgs(state, search, filter, limit string) List {
	n, _ := strconv.Atoi(limit)
	return List{State: state, Search: strings.TrimSpace(search), Filter: filter, Limit: min(max(n, ListMax), ListCap)}
}

const ListCap = 500 // "Load more" stops here; past it, GitHub's own search is the better tool

// args turns a list request into gh flags. Search text always travels as one --search=… argument, so nothing in it
// can be read as another flag.
func (l List) args(kind string, states ...string) []string {
	state := "open"
	for _, s := range states {
		if l.State == s {
			state = s
		}
	}
	search := l.Search
	args := []string{kind, "list", "--state", state, "--limit", strconv.Itoa(l.Limit + 1)}
	switch l.Filter {
	case "mine":
		args = append(args, "--author", "@me")
	case "assigned":
		args = append(args, "--assignee", "@me")
	case "review":
		if kind == "pr" { // no flag for it: a search qualifier
			search = strings.TrimSpace(search + " review-requested:@me")
		}
	}
	if search != "" {
		args = append(args, "--search="+search)
	}
	return args
}

func Prs(l List) ([]map[string]any, error) {
	var raw []map[string]any
	if err := GhJSON(0, "", &raw, append(l.args("pr", "open", "closed", "merged", "all"), "--json", PRList)...); err != nil {
		return nil, err
	}
	out := make([]map[string]any, len(raw))
	for i, p := range raw {
		out[i] = PrRow(p)
	}
	return out, nil
}

func Issues(l List) ([]map[string]any, error) {
	var raw []map[string]any
	if err := GhJSON(0, "", &raw, append(l.args("issue", "open", "closed", "all"), "--json", "number,title,author,labels,updatedAt,state")...); err != nil {
		return nil, err
	}
	out := make([]map[string]any, len(raw))
	for i, x := range raw {
		out[i] = IssueRow(x)
	}
	return out, nil
}

// Labels are the repo's labels, for the new issue form and label editing.
func Labels() ([]map[string]any, error) {
	var raw []map[string]any
	if err := GhJSON(0, "", &raw, "label", "list", "--limit", "200", "--json", "name,color,description"); err != nil {
		return nil, err
	}
	return raw, nil
}
