package filesx

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"unicode/utf8"

	"drawa/internal/config"
)

// ErrChanged: the file on disk isn't the text the editor started from (changed since, or not editable when it
// was read), so saving would throw away what's there.
var ErrChanged = errors.New("the file changed on disk since it was opened")

// ErrTooBig: the text is over the 1 MB the editor may open, so it couldn't be edited again once saved.
var ErrTooBig = errors.New("the text is over 1 MB, more than the editor can open again")

// ErrReadOnly: the file isn't writable; replacing it by rename would get around that.
var ErrReadOnly = errors.New("the file is read-only")

// uneditable says why the editor can't save this file's text without changing what it didn't touch, or "": the
// text must be the whole file, byte for byte, with one kind of line ending (CodeMirror rewrites a lone \r, and
// keeps only one separator).
func uneditable(data []byte) string {
	switch crlf, lf := bytes.Count(data, []byte("\r\n")), bytes.Count(data, []byte("\n")); {
	case len(data) > maxRead:
		return "it's over 1 MB"
	case bytes.IndexByte(data, 0) >= 0, !utf8.Valid(data):
		return "it isn't UTF-8 text"
	case bytes.Count(data, []byte("\r")) != crlf:
		return "it has old Mac line endings (\\r)"
	case crlf > 0 && crlf != lf:
		return "it mixes Windows and Unix line endings"
	}
	return ""
}

// writable: whether the user may write the file itself (rename would replace it even when it's read-only).
func writable(p string) bool { return syscall.Access(p, 2) == nil } // 2: W_OK

// Save writes text over an existing project file, only if the file still holds base, the text the page read
// with Get. It writes a temporary file beside it and renames it over, so a failed write leaves the file as it
// was, keeping its permissions and (as far as it's allowed to) its owner and group. Where the folder can't take
// a new file, it writes the file in place instead. ponytail: the rename drops ACLs and extended attributes, and a
// hard link keeps the old copy; write in place always if those ever matter more than a safe write.
func Save(rel, base, text string) error {
	if len(text) > maxRead {
		return ErrTooBig
	}
	f, info, err := Open(rel)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(f, maxRead+1))
	f.Close()
	if err != nil {
		return err
	}
	if uneditable(data) != "" || string(data) != base {
		return ErrChanged
	}
	// Open approved where it really is; resolve and check again, so a link swapped in since can't send the
	// write outside the project, and replace that file, not a link to it
	p, err := config.Inside(f.Name())
	if err != nil {
		return err
	}
	if !writable(p) {
		return ErrReadOnly
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".drawa-*")
	if errors.Is(err, os.ErrPermission) {
		return os.WriteFile(p, []byte(text), 0) // a folder we can't add to: the file itself is writable
	}
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // gone once renamed; cleans up after a failure
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		tmp.Chown(int(st.Uid), int(st.Gid)) // best effort: only root may give a file away
	}
	if _, err = tmp.WriteString(text); err == nil {
		err = tmp.Chmod(info.Mode().Perm())
	}
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
