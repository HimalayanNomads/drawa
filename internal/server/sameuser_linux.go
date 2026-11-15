package server

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
)

var myUID = os.Getuid()

// peerCheck is on unless /proc/net/tcp can't be read, or this is WSL: there a Windows browser reaches localhost
// through a relay that isn't the user, so every connection would be refused. ponytail: WSL keeps the old rule (any
// local program); a per-launch secret would cover it.
func peerCheck() bool {
	if release, _ := os.ReadFile("/proc/sys/kernel/osrelease"); strings.Contains(strings.ToLower(string(release)), "microsoft") {
		return false
	}
	_, err := os.Stat("/proc/net/tcp")
	return err == nil
}

// peerUID is the user that owns the socket at `from` connected to `to` (both on this machine), from the kernel's
// table of TCP sockets.
func peerUID(from, to *net.TCPAddr) (int, error) {
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		uid, err := ownerIn(table, from, to)
		if err == nil {
			return uid, nil
		}
		if !errors.Is(err, errNoSocket) {
			return 0, err
		}
	}
	return 0, errNoSocket
}

var errNoSocket = errors.New("its socket isn't in the kernel's table (another network namespace, such as a container)")

// ownerIn reads one table: lines like "0: 0100007F:A1B2 0100007F:2253 01 ... 1000 ...", whose second and third
// fields are the socket's own and its peer's address and whose eighth is its owner's uid.
func ownerIn(table string, from, to *net.TCPAddr) (int, error) {
	f, err := os.Open(table)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	lines := bufio.NewScanner(f)
	lines.Scan() // the header
	for lines.Scan() {
		fields := strings.Fields(lines.Text())
		if len(fields) < 8 || !sameAddr(fields[1], from) || !sameAddr(fields[2], to) {
			continue
		}
		return strconv.Atoi(fields[7])
	}
	return 0, errNoSocket
}

// sameAddr compares the kernel's "IP:PORT" (hex; the IP as 32-bit words in this machine's byte order) with a.
func sameAddr(field string, a *net.TCPAddr) bool {
	ipHex, portHex, ok := strings.Cut(field, ":")
	if !ok {
		return false
	}
	port, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil || int(port) != a.Port {
		return false
	}
	raw, err := hex.DecodeString(ipHex)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return false
	}
	ip := make(net.IP, len(raw))
	for i := 0; i < len(raw); i += 4 {
		binary.NativeEndian.PutUint32(ip[i:], binary.BigEndian.Uint32(raw[i:]))
	}
	return ip.Equal(a.IP) // also matches an IPv4 address against its IPv6-mapped form
}
