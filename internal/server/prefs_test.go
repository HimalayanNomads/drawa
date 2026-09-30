package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// The page reads and changes ~/.drawa/config.json through /api/prefs; a change outside a setting's choices is refused.
func TestPrefsRoutes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	for _, c := range []struct {
		method, body string
		code         int
		want         string
	}{
		{"GET", "", 200, `"ui":"full"`},
		{"POST", `{"ui":"minimal"}`, 200, `"ui":"minimal"`},
		{"POST", `{"ui":"huge"}`, 400, `invalid setting`},
		{"POST", `{}`, 400, `nothing to change`},
		{"GET", "", 200, `"ui":"minimal"`},
	} {
		if code, body := call(t, srv, c.method, "/api/prefs", c.body); code != c.code || !strings.Contains(body, c.want) {
			t.Errorf("%s %s: %d %s, want %d with %s", c.method, c.body, code, body, c.code, c.want)
		}
	}
}
