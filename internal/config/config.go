// Package config holds paths and constants shared by the rest of the server, and Inside() (the path-safety
// check every file route uses).
package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"drawa/internal/remote"
)

const defaultPort = 8765

// Version is the release tag, stamped in by the release build (-ldflags -X); "dev" for a source build, which never
// offers updates.
var Version = "dev"

// Port is 8765 unless DRAWA_PORT overrides it (e.g. two projects open at once, or 8765 is already taken).
var Port = port()

// MaxLive caps running agent processes, of every backend together (DRAWA_MAX_LIVE; 0, the default, means no cap). No default number: how
// many fit depends on the machine (each process is a few hundred MB), and the idle reaper already bounds them.
var MaxLive = maxLive()

func maxLive() int {
	n, _ := strconv.Atoi(os.Getenv("DRAWA_MAX_LIVE"))
	return max(n, 0)
}

func port() int {
	if v := os.Getenv("DRAWA_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 && p < 65536 {
			return p
		}
	}
	return defaultPort
}

// Repo is this module's root: where main.go and web/ live. runtime.Caller embeds the build-time source path,
// so this resolves correctly whether launched via `go run` or a built binary, as long as the source tree hasn't
// moved since the binary was built (true here: the restart-on-change loop always rebuilds before re-exec'ing).
var Repo = repoRoot()

func repoRoot() string {
	_, thisFile, _, _ := runtime.Caller(0) // .../internal/config/config.go
	dir, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	if err != nil {
		dir = "."
	}
	return dir
}

var Dist = filepath.Join(Repo, "web", "dist")

// Net is true when --net was passed: listen on every interface, not just loopback, so other devices on the
// network can reach the server too. Off by default, since this endpoint runs Claude Code with your permissions.
var Net = hasFlag("--net")

func hasFlag(name string) bool {
	for _, a := range os.Args[1:] {
		if a == name {
			return true
		}
	}
	return false
}

// NetToken guards the network address when --net is passed (only loopback clients skip it: see internal/server's
// netAuthorized). 16 random bytes, so guessing it is hopeless; it's typed once from the printed link and then
// lives in a cookie. Kept in DRAWA_NET_TOKEN so the self-restart (syscall.Exec with os.Environ) keeps it and
// already-open browsers stay signed in. Empty, and unused, when --net wasn't passed.
var NetToken = netToken()

const netTokenEnv = "DRAWA_NET_TOKEN"

func netToken() string {
	if !Net {
		return ""
	}
	if t := os.Getenv(netTokenEnv); len(t) >= 22 { // a short hand-set value would undo the point of the length
		return t
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the OS RNG failing is not something we can recover from
	}
	t := base64.RawURLEncoding.EncodeToString(b)
	os.Setenv(netTokenEnv, t)
	return t
}

// Root is the project folder Claude works in: the first non-flag argument, default the current folder. A GitHub
// URL maps to its clone folder in the cache (a local path of the same name wins); main() does the cloning, since
// this runs at init and must not touch the network.
var Root = rootDir()

// Cloned is true when Root is a clone of someone else's code: the argument was a GitHub URL, or a folder inside the
// clone cache (opening it directly must not skip the trust question). CloneURL and CloneRef say what main() clones
// into Root on first run; empty for a folder given directly, which already exists. No initializers: rootDir() sets them while Root is
// initialized, and a zero-value var is never reassigned after that.
var Cloned bool
var CloneURL, CloneRef string

// Trusted is the answer main() got when it asked whether to trust a clone. Kept in DRAWA_TRUST so the
// self-restart (syscall.Exec with os.Environ) doesn't ask again.
var Trusted bool

const TrustEnv = "DRAWA_TRUST"

// Untrusted: agents start without the project's own settings, since its hooks would run shell commands unasked.
func Untrusted() bool { return Cloned && !Trusted }

// TrustFor reads a DRAWA_TRUST value ("1:<root>" or "0:<root>"): ok only when it was given for root, since every
// child process inherits the variable and a drawa started from one on another repo must still ask.
func TrustFor(v, root string) (trust, ok bool) {
	answer, r, _ := strings.Cut(v, ":") // Cut: the root may hold colons
	return answer == "1", r == root
}

func rootDir() string {
	arg := "."
	for _, a := range os.Args[1:] {
		if !strings.HasPrefix(a, "-") {
			arg = a
			break
		}
	}
	if _, err := os.Stat(arg); err != nil {
		if dir, url, ref, ok := remote.Parse(arg); ok {
			Cloned, CloneURL, CloneRef = true, url, ref
			return dir
		}
	}
	abs, err := filepath.Abs(arg)
	if err != nil {
		abs = arg
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	Cloned = inCache(abs, remote.Base())
	return abs
}

// inCache: both paths are resolved, so a prefix with a trailing separator is enough (/repos2 isn't inside /repos).
func inCache(abs, base string) bool {
	return strings.HasPrefix(abs, base+string(filepath.Separator))
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

// Sessions is where Claude Code stores this project's transcripts: path mangled to dashes, one char at a time
// (must match the CLI's own mangling exactly, so `re.sub` semantics: no collapsing runs of separators).
var Sessions = filepath.Join(sessionsBase(), "projects", nonAlnum.ReplaceAllString(Root, "-"))

func sessionsBase() string {
	if v := os.Getenv("CLAUDE_CONFIG_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

var Modes = map[string]bool{
	"default": true, "acceptEdits": true, "auto": true, "plan": true, "bypassPermissions": true,
}

// Efforts: the levels `claude --effort` accepts at spawn (its own --help lists these five; "auto" is a
// mid-session-only value for the /effort command, not a valid spawn flag).
var Efforts = map[string]bool{
	"low": true, "medium": true, "high": true, "xhigh": true, "max": true,
}

// With --net the server listens on every interface (see main.go), so its own LAN address(es) must pass the
// same Host-header allowlist that 127.0.0.1/localhost do; LocalIPs() is what finds them.
var Hosts = hosts()

func hosts() map[string]bool {
	m := map[string]bool{
		fmt.Sprintf("127.0.0.1:%d", Port): true,
		fmt.Sprintf("localhost:%d", Port): true,
	}
	if Net {
		for _, ip := range LocalIPs() {
			m[fmt.Sprintf("%s:%d", ip, Port)] = true
		}
	}
	return m
}

// LocalIPs returns this machine's outward-facing IPv4 address (how another device on the same network would
// reach it) — or none when there's no network route (e.g. fully offline). A UDP dial doesn't send any packets;
// it just asks the OS which local address it would use to reach that destination, which is also the standard
// trick for finding the real NIC's address instead of a VM/container bridge's.
func LocalIPs() []string {
	conn, err := net.Dial("udp4", "8.8.8.8:80")
	if err != nil {
		return nil
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP.IsLoopback() || addr.IP.IsUnspecified() {
		return nil
	}
	return []string{addr.IP.String()}
}

// Origins are the pages allowed to POST: our own hosts, plus the Vite dev server (which proxies to us but keeps
// the browser's Origin) only when DRAWA_DEV=1, so another app on :5173 can't drive a normal run.
var Origins = mergeOrigins()

func mergeOrigins() map[string]bool {
	m := map[string]bool{}
	if os.Getenv("DRAWA_DEV") == "1" {
		m["127.0.0.1:5173"], m["localhost:5173"] = true, true
	}
	for k := range Hosts {
		m[k] = true
	}
	return m
}

var UUIDRe = regexp.MustCompile(`^[0-9a-f-]{36}$`)

// live Claude processes with no traffic for this long are closed (the next message resumes them)
const IdleSecs = 30 * 60

// This UI renders Mermaid; models often name a node "graph", which Mermaid rejects.
const SystemNote = `Replies are shown in a web UI that renders Markdown and Mermaid. In Mermaid diagrams never use keywords (graph, end, subgraph, flowchart, class, style, click) as node ids; e.g. write graphMod["graph.ts"].`

var ErrOutside = errors.New("outside project folder")

// Inside resolves rel against Root and refuses anything that escapes it. Like Python's (ROOT / rel).resolve(),
// an absolute rel stands alone (so it's only accepted when it already lies inside Root).
func Inside(rel string) (string, error) {
	p := rel
	if !filepath.IsAbs(p) {
		p = filepath.Join(Root, rel)
	}
	resolved, err := resolve(filepath.Clean(p))
	if err != nil {
		return "", err
	}
	if !contains(resolved) {
		return "", ErrOutside
	}
	return resolved, nil
}

// contains: Rel, not a string prefix: /root2 isn't inside /root, and everything is inside Root == "/".
func contains(abs string) bool {
	r, err := filepath.Rel(Root, abs)
	return err == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator))
}

// Opened re-checks, after the open, that f (opened from path p, which Inside approved) is still inside Root:
// a symlink swapped in between Inside and the open would otherwise let the read escape. Linux asks the kernel
// what f really is; elsewhere it resolves p again. ponytail: the fallback only narrows the race, not closes it;
// openat2(RESOLVE_BENEATH) if that ever matters off Linux.
func Opened(f *os.File, p string) error {
	real, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(f.Fd())))
	if err != nil {
		real, err = filepath.EvalSymlinks(p)
	}
	if err != nil || !contains(real) {
		return ErrOutside
	}
	return nil
}

// resolve follows symlinks in p even when its leaf doesn't exist yet: the deepest existing ancestor is resolved
// and the rest re-appended, so lnk/new with lnk -> /etc resolves to /etc/new.
func resolve(p string) (string, error) {
	tail := ""
	for {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Join(r, tail), nil
		}
		if _, err := os.Lstat(p); err == nil { // exists but won't resolve: a dangling or looping link
			return "", ErrOutside
		}
		parent := filepath.Dir(p)
		if parent == p {
			return filepath.Join(p, tail), nil
		}
		tail = filepath.Join(filepath.Base(p), tail)
		p = parent
	}
}
