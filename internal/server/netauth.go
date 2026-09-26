// Guards the network address --net opens up. Only a loopback peer (by RemoteAddr: the Host header is the
// client's to forge) skips it. A valid ?token= is swapped for a cookie so the rest of a browser's own requests
// pass automatically, and an address that guesses wrong too many times is locked out for a while.
package server

import (
	"crypto/subtle"
	"net"
	"net/http"
	"sync"
	"time"

	"drawa/internal/config"
)

const (
	netCookie      = "drawa_net"
	maxNetAttempts = 5
	netLockout     = 5 * time.Minute
	maxNetTracked  = 1000
)

var (
	netAuthMu sync.Mutex
	netFails  = map[string]int{}       // remote address -> consecutive wrong tokens
	netLocked = map[string]time.Time{} // remote address -> locked out until
)

// netAuthorized reports whether this request may proceed; when it returns false it has already answered
// (403, or the redirect that drops a valid ?token= from the address bar).
func netAuthorized(w http.ResponseWriter, r *http.Request) bool {
	if !config.Net || loopback(r) {
		return true
	}
	addr := remoteAddr(r)
	if lockedOut(addr) {
		http.Error(w, "", 403)
		return false
	}
	token := r.URL.Query().Get("token")
	if token == "" {
		// ponytail: wrong cookies aren't counted as guesses, so a stale one from an earlier run can't lock the
		// browser out; the 128-bit token is what stops guessing, the lockout is only a backstop for ?token=
		if c, err := r.Cookie(netCookie); err == nil && validNetToken(c.Value) {
			return true
		}
		http.Error(w, "", 403)
		return false
	}
	if !validNetToken(token) {
		netFailed(addr)
		http.Error(w, "", 403)
		return false
	}
	netAuthMu.Lock()
	delete(netFails, addr)
	netAuthMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: netCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode})
	if r.Method != http.MethodGet {
		return true
	}
	// keep the token out of the address bar, history and Referer: the cookie carries it from here
	u := *r.URL
	q := u.Query()
	q.Del("token")
	u.RawQuery = q.Encode()
	http.Redirect(w, r, u.RequestURI(), http.StatusFound)
	return false
}

func validNetToken(t string) bool {
	return subtle.ConstantTimeCompare([]byte(t), []byte(config.NetToken)) == 1
}

// lockedOut also drops an expired lock, so the map only holds addresses locked right now.
func lockedOut(addr string) bool {
	netAuthMu.Lock()
	defer netAuthMu.Unlock()
	until, ok := netLocked[addr]
	if ok && time.Now().After(until) {
		delete(netLocked, addr)
		return false
	}
	return ok
}

func netFailed(addr string) {
	netAuthMu.Lock()
	defer netAuthMu.Unlock()
	if len(netFails) > maxNetTracked { // ponytail: a flood of addresses resets everyone's count; per-subnet if that's abused
		netFails = map[string]int{}
		for a, until := range netLocked {
			if time.Now().After(until) {
				delete(netLocked, a)
			}
		}
	}
	netFails[addr]++
	if netFails[addr] >= maxNetAttempts {
		netLocked[addr] = time.Now().Add(netLockout)
		delete(netFails, addr)
	}
}

func loopback(r *http.Request) bool {
	ip := net.ParseIP(remoteAddr(r))
	return ip != nil && ip.IsLoopback()
}

func remoteAddr(r *http.Request) string {
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return h
	}
	return r.RemoteAddr
}
