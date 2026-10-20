// Package uploads handles PDF and document attachments: validation, temporary storage
// for backends that lack native document support (Codex), and cleanup of session upload directories.
package uploads

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// MaxSize is the maximum allowed size for an uploaded PDF (3.5MB, matching the image cap).
const MaxSize = 3_500_000

var pdfMagic = []byte("%PDF-")

var safeChars = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

// BaseDir returns the root uploads directory, ~/.drawa/uploads.
// ponytail: a shared ~/.drawa helper across prefs/agy/uploads would be cleaner,
// but is deferred to avoid refactoring existing packages in this PR.
func BaseDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), ".drawa", "uploads")
	}
	return filepath.Join(home, ".drawa", "uploads")
}

var dirFn = BaseDir

func baseDir() string {
	return dirFn()
}

// SanitizeName strips directories, path traversal, unsafe characters, and length excesses,
// ensuring the returned file name has a safe base and a .pdf extension.
func SanitizeName(title string) string {
	// Browsers send a bare file name, but a name can still carry either separator (\ or /).
	// Normalize \ to / and use path (not filepath) so extracting the last element is OS-independent.
	clean := strings.ReplaceAll(strings.TrimSpace(title), "\\", "/")
	var base string
	if strings.HasSuffix(clean, "/") {
		base = ""
	} else {
		base = path.Base(path.Clean(clean))
	}
	base = strings.TrimSpace(base)
	base = safeChars.ReplaceAllString(base, "_")
	base = strings.TrimLeft(base, "._-")
	lower := strings.ToLower(base)
	if strings.HasSuffix(lower, ".pdf") {
		base = base[:len(base)-4]
	}
	if len(base) > 64 {
		base = base[:64]
	}
	if base == "" {
		base = "document"
	}
	return base + ".pdf"
}

// sessionRe validates that a session ID consists of safe characters and cannot escape BaseDir.
var sessionRe = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// Save validates the PDF magic header and size, sanitizes the name, prefixes random bytes,
// creates the session directory (0700) and file (0600), and writes the bytes without overwriting.
func Save(sessionID, title string, data []byte) (string, error) {
	if !sessionRe.MatchString(sessionID) {
		return "", fmt.Errorf("invalid session id: %q", sessionID)
	}
	if len(data) == 0 {
		return "", errors.New("empty document data")
	}
	if len(data) > MaxSize {
		return "", fmt.Errorf("PDF exceeds 3.5MB limit (%d bytes)", len(data))
	}
	if !bytes.HasPrefix(data, pdfMagic) {
		return "", errors.New("file is not a PDF (missing %PDF- header)")
	}

	safe := SanitizeName(title)
	randBytes := make([]byte, 4)
	if _, err := rand.Read(randBytes); err != nil {
		return "", err
	}
	filename := fmt.Sprintf("%s-%s", hex.EncodeToString(randBytes), safe)

	dir := filepath.Join(baseDir(), sessionID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(dir, 0o700)

	targetPath := filepath.Join(dir, filename)
	file, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	defer file.Close()

	if _, err := file.Write(data); err != nil {
		_ = os.Remove(targetPath)
		return "", err
	}
	return targetPath, nil
}

// RemoveSession removes the uploads directory for the given session ID.
func RemoveSession(sessionID string) error {
	if sessionID == "" || !sessionRe.MatchString(sessionID) {
		return nil
	}
	dir := filepath.Join(baseDir(), sessionID)
	return os.RemoveAll(dir)
}

// SweepOlderThan removes upload files older than maxAge, and deletes empty session directories.
func SweepOlderThan(maxAge time.Duration) error {
	base := baseDir()
	entries, err := os.ReadDir(base)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	cutoff := time.Now().Add(-maxAge)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		sessDir := filepath.Join(base, entry.Name())
		files, err := os.ReadDir(sessDir)
		if err != nil {
			continue
		}
		remaining := len(files)
		for _, f := range files {
			if f.IsDir() {
				continue
			}
			filePath := filepath.Join(sessDir, f.Name())
			info, err := f.Info()
			if err == nil && info.ModTime().Before(cutoff) {
				if err := os.Remove(filePath); err == nil {
					remaining--
				}
			}
		}
		if remaining <= 0 {
			_ = os.Remove(sessDir)
		}
	}
	return nil
}

// HasNativeDocumentSupport reports whether a backend accepts native Anthropic/OpenCode document blocks.
func HasNativeDocumentSupport(backend string) bool {
	switch backend {
	case "claude", "opencode":
		return true
	default:
		return false
	}
}

// ShouldSaveToFile reports whether a backend should save document attachments to disk
// and rewrite them to text blocks. Backends with native document support (Claude, OpenCode)
// and text-only backends (TextOnly) must NOT save files to disk.
func ShouldSaveToFile(backend string, textOnly bool) bool {
	if textOnly {
		return false
	}
	return !HasNativeDocumentSupport(backend)
}

// PrepareContent validates document blocks in a message and, for backends that lack native
// document block support (Codex), saves them to disk and rewrites them into text blocks.
// Native backends (Claude, OpenCode) and text-only backends (Antigravity) pass through untouched.
func PrepareContent(backend string, textOnly bool, sessionID, cardID string, content any) (any, error) {
	list, ok := content.([]any)
	if !ok {
		return content, nil
	}
	folder := sessionID
	if folder == "" {
		folder = cardID
	}
	saveFile := ShouldSaveToFile(backend, textOnly)
	out := make([]any, 0, len(list))

	for _, item := range list {
		blockMap, ok := item.(map[string]any)
		if !ok || blockMap["type"] != "document" {
			out = append(out, item)
			continue
		}

		source, ok := blockMap["source"].(map[string]any)
		if !ok {
			return nil, errors.New("document block missing source")
		}
		if source["type"] != "base64" || source["media_type"] != "application/pdf" {
			return nil, errors.New("document block must be base64 application/pdf")
		}
		b64Data, ok := source["data"].(string)
		if !ok || b64Data == "" {
			return nil, errors.New("document block missing data")
		}

		data, err := base64.StdEncoding.DecodeString(b64Data)
		if err != nil {
			return nil, fmt.Errorf("invalid base64 document data: %w", err)
		}
		if len(data) > MaxSize {
			return nil, fmt.Errorf("PDF exceeds 3.5MB limit (%d bytes)", len(data))
		}
		if !bytes.HasPrefix(data, pdfMagic) {
			return nil, errors.New("file is not a PDF (missing %PDF- header)")
		}

		title, _ := blockMap["title"].(string)
		if title == "" {
			title = "document.pdf"
		}

		if !saveFile {
			out = append(out, blockMap)
			continue
		}

		// Non-native, non-text-only backend (Codex): save to file and rewrite to text block.
		savedPath, err := Save(folder, title, data)
		if err != nil {
			return nil, fmt.Errorf("failed to save PDF: %w", err)
		}
		textNote := fmt.Sprintf("Attached PDF %q saved at %s; open it with your file tools.", title, savedPath)
		out = append(out, map[string]any{"type": "text", "text": textNote})
	}
	return out, nil
}
