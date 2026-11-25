// Keeps other accounts on this machine out. The Host, Origin and JSON checks stop web pages in a browser, but any
// program on the machine can send whatever headers it likes, so a service running as another user (a database, a
// web server someone broke into) could otherwise post to /api/shell or open a terminal as you. A connection from
// this machine is kept only when the socket it comes from belongs to the user drawa runs as.
package server

import (
	"fmt"
	"net"
	"sync/atomic"
	"time"
)

// SameUser wraps the server's listener: a loopback connection from another user is closed before it's read. One
// from another device (--net) passes, for the network token to decide. Where the owner can't be found out
// (not Linux), every connection passes, as before.
func SameUser(ln net.Listener) net.Listener {
	if !peerCheck() {
		return ln
	}
	return sameUser{ln, peerUID}
}

// sameUser carries how it finds a socket's owner, so a test can stand in another user.
type sameUser struct {
	net.Listener
	owner func(from, to *net.TCPAddr) (int, error)
}

func (l sameUser) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		ok, why := ownConn(c, l.owner)
		if ok {
			return c, nil
		}
		refused(why)
		c.Close()
	}
}

// ownConn says whether c may be served: it isn't from this machine, or its other end is owned by this user.
func ownConn(c net.Conn, owner func(from, to *net.TCPAddr) (int, error)) (bool, string) {
	remote, ok := c.RemoteAddr().(*net.TCPAddr)
	if !ok || !remote.IP.IsLoopback() {
		return true, ""
	}
	uid, err := owner(remote, c.LocalAddr().(*net.TCPAddr))
	switch {
	case err != nil:
		return false, err.Error()
	case uid != myUID:
		return false, fmt.Sprintf("it came from another user (uid %d)", uid)
	}
	return true, ""
}

var lastRefusal atomic.Int64

// refused says so in drawa's terminal, at most once a minute (a program retrying can't flood it).
func refused(why string) {
	now := time.Now().Unix()
	if last := lastRefusal.Load(); now-last >= 60 && lastRefusal.CompareAndSwap(last, now) {
		fmt.Printf("drawa refused a connection from this machine: %s. Only your own user may use it.\n", why)
	}
}
