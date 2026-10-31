package uploads

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func setTestDir(t *testing.T) string {
	t.Helper()
	temp := t.TempDir()
	old := dirFn
	dirFn = func() string { return temp }
	t.Cleanup(func() { dirFn = old })
	return temp
}

func TestSanitizeName(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty string", "", "document.pdf"},
		{"whitespace only", "   ", "document.pdf"},
		{"dots only", "...................", "document.pdf"},
		{"simple name", "simple.pdf", "simple.pdf"},
		{"uppercase PDF extension", "SIMPLE.PDF", "SIMPLE.pdf"},
		{"lowercase with uppercase ext", "doc.PDF", "doc.pdf"},
		{"path traversal unix", "../x.pdf", "x.pdf"},
		{"nested path traversal", "../traversal/escape.pdf", "escape.pdf"},
		{"absolute unix path", "/etc/passwd", "passwd.pdf"},
		{"windows drive and path", "C:\\x\\y.pdf", "y.pdf"},
		{"windows path traversal", "..\\..\\evil.pdf", "evil.pdf"},
		{"mixed separators", "a/b\\c.pdf", "c.pdf"},
		{"trailing backslash", "dir\\", "document.pdf"},
		{"single backslash", "\\", "document.pdf"},
		{"unicode characters", "unicode-föö-bår.pdf", "unicode-f__-b_r.pdf"},
		{"spaces in name", "spaces in name.pdf", "spaces_in_name.pdf"},
		{"no extension provided", "no-extension", "no-extension.pdf"},
		{"very long name truncated to 64 chars", strings.Repeat("a", 100) + ".pdf", strings.Repeat("a", 64) + ".pdf"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SanitizeName(tt.input)
			if got != tt.want {
				t.Errorf("SanitizeName(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSaveValidation(t *testing.T) {
	setTestDir(t)

	// Path traversal in sessionID
	if _, err := Save("../../bad", "doc.pdf", []byte("%PDF-1.4")); err == nil {
		t.Error("Save accepted path traversal sessionID")
	}

	// Empty data
	if _, err := Save("sess1", "doc.pdf", nil); err == nil {
		t.Error("Save accepted empty data")
	}

	// Missing/incorrect %PDF- header
	if _, err := Save("sess1", "doc.pdf", []byte("NOT-A-PDF-HEADER")); err == nil {
		t.Error("Save accepted data without %PDF- header")
	}

	// Decoded size just under the 3.5MB cap (3,500,000 bytes) -> must succeed
	underCap := append([]byte("%PDF-"), make([]byte, MaxSize-5)...)
	if path, err := Save("sess1", "under.pdf", underCap); err != nil || path == "" {
		t.Errorf("Save rejected valid data at 3.5MB cap: %v", err)
	}

	// Decoded size just over the 3.5MB cap (3,500,001 bytes) -> must fail
	overCap := append([]byte("%PDF-"), make([]byte, MaxSize-5+1)...)
	if _, err := Save("sess1", "over.pdf", overCap); err == nil {
		t.Error("Save accepted data exceeding MaxSize by 1 byte")
	}
}

func TestSaveAndPermissions(t *testing.T) {
	setTestDir(t)

	validPDF := []byte("%PDF-1.4 valid content")
	sessionID := "session-abc-123"
	path1, err := Save(sessionID, "my-doc.pdf", validPDF)
	if err != nil {
		t.Fatalf("Save 1 failed: %v", err)
	}

	if !strings.HasSuffix(path1, "-my-doc.pdf") {
		t.Errorf("path %q does not have expected suffix", path1)
	}

	content, err := os.ReadFile(path1)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if !bytes.Equal(content, validPDF) {
		t.Errorf("content = %q, want %q", content, validPDF)
	}

	// Two saves with the same title don't collide
	path2, err := Save(sessionID, "my-doc.pdf", validPDF)
	if err != nil {
		t.Fatalf("Save 2 failed: %v", err)
	}
	if path1 == path2 {
		t.Errorf("duplicate saves collided at path %q", path1)
	}
	if _, err := os.Stat(path1); err != nil {
		t.Errorf("first save disappeared: %v", err)
	}
	if _, err := os.Stat(path2); err != nil {
		t.Errorf("second save disappeared: %v", err)
	}

	// Check permissions on non-Windows
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path1)
		if err != nil {
			t.Fatal(err)
		}
		if perm := fi.Mode().Perm(); perm != 0o600 {
			t.Errorf("file mode = %o, want 0600", perm)
		}

		dirFi, err := os.Stat(filepath.Dir(path1))
		if err != nil {
			t.Fatal(err)
		}
		if dirPerm := dirFi.Mode().Perm(); dirPerm != 0o700 {
			t.Errorf("dir mode = %o, want 0700", dirPerm)
		}
	}
}

func TestRemoveSession(t *testing.T) {
	root := setTestDir(t)

	validPDF := []byte("%PDF-1.4 content")
	sessionID := "sess-delete"
	path, err := Save(sessionID, "doc.pdf", validPDF)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file does not exist before delete: %v", err)
	}

	if err := RemoveSession(sessionID); err != nil {
		t.Fatalf("RemoveSession failed: %v", err)
	}

	sessDir := filepath.Join(root, sessionID)
	if _, err := os.Stat(sessDir); !os.IsNotExist(err) {
		t.Errorf("session dir still exists: %v", err)
	}

	// Calling with missing or empty session shouldn't error
	if err := RemoveSession(""); err != nil {
		t.Errorf("RemoveSession empty error: %v", err)
	}
	if err := RemoveSession("non-existent"); err != nil {
		t.Errorf("RemoveSession non-existent error: %v", err)
	}
}

func TestSweepOlderThan(t *testing.T) {
	// Missing root directory returns nil
	setTestDir(t)
	dirFn = func() string { return filepath.Join(t.TempDir(), "nonexistent") }
	if err := SweepOlderThan(MaxAge); err != nil {
		t.Fatalf("missing root dir should return nil, got: %v", err)
	}

	root := setTestDir(t)
	validPDF := []byte("%PDF-1.4 old")

	// Old session: file and dir modtime > MaxAge (100h) -> removed
	sessOld := "sess-old"
	pathOld, err := Save(sessOld, "old.pdf", validPDF)
	if err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-100 * time.Hour)
	if err := os.Chtimes(pathOld, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(root, sessOld), oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	// New session: file < MaxAge -> kept
	sessNew := "sess-new"
	pathNew, err := Save(sessNew, "new.pdf", validPDF)
	if err != nil {
		t.Fatal(err)
	}

	// Mixed session: old file + new file -> old file deleted, new file kept, directory kept
	sessMixed := "sess-mixed"
	pathMixedOld, err := Save(sessMixed, "mixed-old.pdf", validPDF)
	if err != nil {
		t.Fatal(err)
	}
	pathMixedNew, err := Save(sessMixed, "mixed-new.pdf", validPDF)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(pathMixedOld, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	// Fresh empty directory (modtime < 72h): directory KEPT
	sessFreshEmpty := "sess-fresh-empty"
	freshEmptyDir := filepath.Join(root, sessFreshEmpty)
	if err := os.MkdirAll(freshEmptyDir, 0o700); err != nil {
		t.Fatal(err)
	}

	// Old empty directory (modtime > 72h): directory REMOVED
	sessOldEmpty := "sess-old-empty"
	oldEmptyDir := filepath.Join(root, sessOldEmpty)
	if err := os.MkdirAll(oldEmptyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(oldEmptyDir, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	// Sweep older than MaxAge (72 hours)
	if err := SweepOlderThan(MaxAge); err != nil {
		t.Fatalf("SweepOlderThan failed: %v", err)
	}

	// sessOld should be completely removed
	if _, err := os.Stat(filepath.Join(root, sessOld)); !os.IsNotExist(err) {
		t.Errorf("old session directory still exists")
	}

	// sessNew should remain
	if _, err := os.Stat(pathNew); err != nil {
		t.Errorf("new file was swept: %v", err)
	}

	// sessMixed: old file deleted, new file kept, directory KEPT
	if _, err := os.Stat(pathMixedOld); !os.IsNotExist(err) {
		t.Errorf("mixed old file was not swept: %v", err)
	}
	if _, err := os.Stat(pathMixedNew); err != nil {
		t.Errorf("mixed new file was swept: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, sessMixed)); err != nil {
		t.Errorf("mixed directory was removed: %v", err)
	}

	// fresh empty directory: KEPT
	if _, err := os.Stat(freshEmptyDir); err != nil {
		t.Errorf("fresh empty directory was swept: %v", err)
	}

	// old empty directory: REMOVED
	if _, err := os.Stat(oldEmptyDir); !os.IsNotExist(err) {
		t.Errorf("old empty directory still exists: %v", err)
	}
}

func TestHasDocument(t *testing.T) {
	cases := []struct {
		name    string
		content any
		want    bool
	}{
		{"nil", nil, false},
		{"string", "plain text", false},
		{"empty list", []any{}, false},
		{"non-maps in list", []any{123, "text", true}, false},
		{"other block type", []any{map[string]any{"type": "text", "text": "hello"}}, false},
		{"image block", []any{map[string]any{"type": "image"}}, false},
		{"document block", []any{map[string]any{"type": "document"}}, true},
		{"mixed with document", []any{"str", map[string]any{"type": "text"}, map[string]any{"type": "document"}}, true},
	}
	for _, tc := range cases {
		if got := HasDocument(tc.content); got != tc.want {
			t.Errorf("HasDocument(%s) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestValidateContent(t *testing.T) {
	root := setTestDir(t)

	validHeader := []byte("%PDF-1.4 sample content")
	b64Valid := base64.StdEncoding.EncodeToString(validHeader)

	// String and nil
	if err := ValidateContent("hello"); err != nil {
		t.Errorf("ValidateContent(string) error: %v", err)
	}
	if err := ValidateContent(nil); err != nil {
		t.Errorf("ValidateContent(nil) error: %v", err)
	}

	// Non-document blocks ignored
	if err := ValidateContent([]any{
		"plain",
		map[string]any{"type": "text", "text": "note"},
		map[string]any{"type": "image", "source": "whatever"},
	}); err != nil {
		t.Errorf("ValidateContent(non-document blocks) error: %v", err)
	}

	// Valid document block
	validBlock := map[string]any{
		"type":  "document",
		"title": "spec.pdf",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       b64Valid,
		},
	}
	if err := ValidateContent([]any{validBlock}); err != nil {
		t.Errorf("ValidateContent(validBlock) error: %v", err)
	}

	// Missing or non-base64 source
	badSource := map[string]any{
		"type":  "document",
		"title": "nosource.pdf",
		"source": map[string]any{
			"type":       "url",
			"media_type": "application/pdf",
		},
	}
	if err := ValidateContent([]any{badSource}); err == nil {
		t.Error("ValidateContent accepted non-base64 source")
	}

	// Non-PDF media_type
	wrongMime := map[string]any{
		"type":  "document",
		"title": "doc.txt",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "text/plain",
			"data":       b64Valid,
		},
	}
	if err := ValidateContent([]any{wrongMime}); err == nil || !strings.Contains(err.Error(), `"doc.txt"`) {
		t.Errorf("ValidateContent wrongMime error = %v, want error naming doc.txt", err)
	}

	// Empty data
	emptyData := map[string]any{
		"type":  "document",
		"title": "empty.pdf",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       "",
		},
	}
	if err := ValidateContent([]any{emptyData}); err == nil || !strings.Contains(err.Error(), `"empty.pdf"`) {
		t.Errorf("ValidateContent emptyData error = %v, want error naming empty.pdf", err)
	}

	// Corrupt base64
	corruptB64 := map[string]any{
		"type":  "document",
		"title": "corrupt.pdf",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       "not-base-64!@#$",
		},
	}
	if err := ValidateContent([]any{corruptB64}); err == nil || !strings.Contains(err.Error(), `"corrupt.pdf"`) {
		t.Errorf("ValidateContent corruptB64 error = %v, want error naming corrupt.pdf", err)
	}

	// Valid base64 but missing %PDF- header (e.g. text file renamed .pdf)
	nonPdfBytes := base64.StdEncoding.EncodeToString([]byte("plain text file contents"))
	fakePdf := map[string]any{
		"type":  "document",
		"title": "renamed.pdf",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       nonPdfBytes,
		},
	}
	if err := ValidateContent([]any{fakePdf}); err == nil || !strings.Contains(err.Error(), `"renamed.pdf" is not a PDF file`) {
		t.Errorf("ValidateContent fakePdf error = %v, want error saying not a PDF file", err)
	}

	// Default title when title is empty
	unnamedFakePdf := map[string]any{
		"type": "document",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       nonPdfBytes,
		},
	}
	if err := ValidateContent([]any{unnamedFakePdf}); err == nil || !strings.Contains(err.Error(), `"document.pdf" is not a PDF file`) {
		t.Errorf("ValidateContent unnamedFakePdf error = %v, want error naming document.pdf", err)
	}

	// Exactly MaxSize accepted
	maxBytes := make([]byte, MaxSize)
	copy(maxBytes, []byte("%PDF-"))
	b64Max := base64.StdEncoding.EncodeToString(maxBytes)
	maxBlock := map[string]any{
		"type":  "document",
		"title": "exact.pdf",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       b64Max,
		},
	}
	if err := ValidateContent([]any{maxBlock}); err != nil {
		t.Errorf("ValidateContent(exact MaxSize) error: %v", err)
	}

	// MaxSize + 1 rejected
	overBytes := make([]byte, MaxSize+1)
	copy(overBytes, []byte("%PDF-"))
	b64Over := base64.StdEncoding.EncodeToString(overBytes)
	overBlock := map[string]any{
		"type":  "document",
		"title": "toolarge.pdf",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       b64Over,
		},
	}
	if err := ValidateContent([]any{overBlock}); err == nil || !strings.Contains(err.Error(), `"toolarge.pdf" is over 3.5 MB`) {
		t.Errorf("ValidateContent(over MaxSize) error = %v, want error saying over 3.5 MB", err)
	}

	// Verify ValidateContent wrote nothing to disk
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) > 0 {
		t.Errorf("ValidateContent wrote files to disk: %d entries", len(entries))
	}
}
