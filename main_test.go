package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A taken port names DRAWA_PORT, and only a drawa serving this same folder counts as the one to open.
func TestPortTaken(t *testing.T) {
	root := "/projA"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"root":"` + root + `"}`))
	}))
	defer srv.Close()
	_, err := net.Listen("tcp", srv.Listener.Addr().String()) // taken: the real EADDRINUSE
	if err == nil {
		t.Fatal("second listen on one port succeeded")
	}
	if msg, same := portTaken(err, srv.URL, "/projA"); !same || !strings.Contains(msg, "already running") {
		t.Errorf("same project: %q %v", msg, same)
	}
	if msg, same := portTaken(err, srv.URL, "/projB"); same || !strings.Contains(msg, "/projA") || !strings.Contains(msg, "DRAWA_PORT=") {
		t.Errorf("other project: %q %v", msg, same)
	}
	root = ""
	if msg, same := portTaken(err, srv.URL, "/projB"); same || !strings.Contains(msg, "another program") || !strings.Contains(msg, "DRAWA_PORT=") {
		t.Errorf("not drawa: %q %v", msg, same)
	}
}
