//go:build !linux

package server

import "net"

// ponytail: only Linux can name a local socket's owner without cgo (/proc/net/tcp); elsewhere any program on the
// machine is still let in, as before. macOS could ask with `lsof -i` or a per-launch secret could cover every OS.
func peerCheck() bool { return false }

var myUID = -1

func peerUID(from, to *net.TCPAddr) (int, error) { return myUID, nil }
