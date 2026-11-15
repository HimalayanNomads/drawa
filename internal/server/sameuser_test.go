package server

import (
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

// serveSameUser runs a tiny server behind SameUser (owners found by `owner`) and returns its address.
func serveSameUser(t *testing.T, owner func(from, to *net.TCPAddr) (int, error)) string {
	t.Helper()
	if !peerCheck() {
		t.Skip("socket owners can't be checked here")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go http.Serve(sameUser{ln, owner}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))
	return ln.Addr().String()
}

// The kernel's table names this test as the owner of its own connection, and it's served.
func TestSameUserServesYou(t *testing.T) {
	addr := serveSameUser(t, peerUID)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	uid, err := peerUID(c.LocalAddr().(*net.TCPAddr), c.RemoteAddr().(*net.TCPAddr))
	c.Close()
	if err != nil || uid != myUID {
		t.Fatalf("owner %d (%v), want %d", uid, err, myUID)
	}
	resp, err := http.Get("http://" + addr)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "ok" {
		t.Fatalf("got %q", body)
	}
}

// A connection another user owns is closed unanswered, and so is one whose owner can't be found.
func TestSameUserRefusesOthers(t *testing.T) {
	for name, lookup := range map[string]func(from, to *net.TCPAddr) (int, error){
		"another user": func(from, to *net.TCPAddr) (int, error) { return myUID + 1, nil },
		"unknown":      func(from, to *net.TCPAddr) (int, error) { return 0, errors.New("not found") },
	} {
		addr := serveSameUser(t, lookup)
		c, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		c.SetDeadline(time.Now().Add(2 * time.Second))
		io.WriteString(c, "GET / HTTP/1.1\r\nHost: x\r\n\r\n")
		if n, _ := c.Read(make([]byte, 64)); n != 0 {
			t.Errorf("%s: answered", name)
		}
		c.Close()
	}
}
