package update

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v0.2.0", "v0.1.0", true},
		{"v0.1.0", "v0.2.0", false},
		{"v0.1.0", "v0.1.0", false},
		{"v0.10.0", "v0.9.0", true}, // component-wise, not lexicographic
		{"v1.0.0", "v0.99.99", true},
		{"v1.2.3", "dev", true}, // any real tag beats the dev sentinel
	}
	for _, c := range cases {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestResolveTag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/probablysamir/drawa/releases/latest" {
			http.Redirect(w, r, "/probablysamir/drawa/releases/tag/v1.2.3", http.StatusFound)
			return
		}
	}))
	defer srv.Close()

	tag, url, err := resolveTag(srv.URL + "/probablysamir/drawa/releases/latest")
	if err != nil {
		t.Fatal(err)
	}
	if tag != "v1.2.3" {
		t.Errorf("tag = %q, want v1.2.3", tag)
	}
	if url == "" {
		t.Error("url is empty")
	}
}

func TestResolveTagNoRelease(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	if _, _, err := resolveTag(srv.URL + "/x/releases/latest"); err == nil {
		t.Error("want an error when there's no release to redirect to")
	}
}
