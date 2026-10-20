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
	root := setTestDir(t)

	validPDF := []byte("%PDF-1.4 old")
	sessOld := "sess-old"
	pathOld, err := Save(sessOld, "old.pdf", validPDF)
	if err != nil {
		t.Fatal(err)
	}

	sessNew := "sess-new"
	pathNew, err := Save(sessNew, "new.pdf", validPDF)
	if err != nil {
		t.Fatal(err)
	}

	// Set old file mod time to 48 hours ago
	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(pathOld, past, past); err != nil {
		t.Fatal(err)
	}

	// Sweep older than 24 hours
	if err := SweepOlderThan(24 * time.Hour); err != nil {
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
}

func TestPrepareContent(t *testing.T) {
	root := setTestDir(t)

	validPDF := []byte("%PDF-1.4 test document content")
	b64Valid := base64.StdEncoding.EncodeToString(validPDF)

	docBlock := map[string]any{
		"type": "document",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       b64Valid,
		},
		"title": "spec.pdf",
	}

	// String content is unchanged
	resStr, err := PrepareContent("codex", false, "sess", "card", "hello world")
	if err != nil || resStr != "hello world" {
		t.Errorf("PrepareContent string = %v, %v", resStr, err)
	}

	// Non-document blocks (e.g. image) untouched
	imgBlock := map[string]any{
		"type": "image",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "image/png",
			"data":       "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		},
	}
	resImg, err := PrepareContent("codex", false, "sess", "card", []any{imgBlock})
	if err != nil {
		t.Fatalf("PrepareContent img error: %v", err)
	}
	if len(resImg.([]any)) != 1 || resImg.([]any)[0].(map[string]any)["type"] != "image" {
		t.Errorf("image block was altered: %v", resImg)
	}

	// Table test over backends: claude, opencode, codex, agy
	backendTests := []struct {
		backend    string
		textOnly   bool
		wantSave   bool
		wantDocTyp string // "document" for passthrough, "text" for rewritten
	}{
		{"claude", false, false, "document"},
		{"opencode", false, false, "document"},
		{"codex", false, true, "text"},
		{"agy", true, false, "document"},
	}

	for _, bt := range backendTests {
		t.Run("backend_"+bt.backend, func(t *testing.T) {
			sessID := "sess-" + bt.backend
			res, err := PrepareContent(bt.backend, bt.textOnly, sessID, "card-"+bt.backend, []any{
				map[string]any{"type": "text", "text": "intro"},
				docBlock,
			})
			if err != nil {
				t.Fatalf("PrepareContent(%s) error: %v", bt.backend, err)
			}
			blocks := res.([]any)
			if len(blocks) != 2 {
				t.Fatalf("len(blocks) = %d, want 2", len(blocks))
			}
			b2 := blocks[1].(map[string]any)
			gotType := b2["type"].(string)
			if gotType != bt.wantDocTyp {
				t.Errorf("backend %s block[1] type = %q, want %q", bt.backend, gotType, bt.wantDocTyp)
			}

			// Check file existence
			sessDir := filepath.Join(root, sessID)
			entries, _ := os.ReadDir(sessDir)
			if bt.wantSave {
				if len(entries) == 0 {
					t.Errorf("backend %s expected saved file, but directory is empty", bt.backend)
				}
				textVal := b2["text"].(string)
				if !strings.Contains(textVal, "Attached PDF \"spec.pdf\" saved at") {
					t.Errorf("unexpected rewritten text for %s: %s", bt.backend, textVal)
				}
			} else {
				if len(entries) > 0 {
					t.Errorf("backend %s should NOT write files, found: %d", bt.backend, len(entries))
				}
			}
		})
	}

	// Save error returns error and does NOT send half-rewritten message
	b64Bad := base64.StdEncoding.EncodeToString([]byte("NOT-PDF-HEADER"))
	badDoc := map[string]any{
		"type": "document",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       b64Bad,
		},
		"title": "bad.pdf",
	}
	mixedContent := []any{
		map[string]any{"type": "text", "text": "first block"},
		docBlock,
		badDoc,
	}
	if _, err := PrepareContent("codex", false, "sess-fail", "card-fail", mixedContent); err == nil {
		t.Error("PrepareContent accepted mixed content with a bad document block")
	}

	// Bad document block: missing data
	missingData := map[string]any{
		"type": "document",
		"source": map[string]any{
			"type":       "base64",
			"media_type": "application/pdf",
			"data":       "",
		},
	}
	if _, err := PrepareContent("codex", false, "sess-empty", "card-empty", []any{missingData}); err == nil {
		t.Error("PrepareContent accepted empty data")
	}
}

// TestShouldSaveToFile verifies that ShouldSaveToFile decides whether to save attachments
// to file using native document support and the textOnly flag, without hardcoding backend names (#136).
func TestShouldSaveToFile(t *testing.T) {
	tests := []struct {
		backend  string
		textOnly bool
		want     bool
	}{
		{"claude", false, false},
		{"opencode", false, false},
		{"codex", false, true},
		{"agy", true, false},
		{"agy", false, true},
		{"custom-textonly", true, false},
		{"custom-standard", false, true},
	}
	for _, tt := range tests {
		if got := ShouldSaveToFile(tt.backend, tt.textOnly); got != tt.want {
			t.Errorf("ShouldSaveToFile(%q, %v) = %v, want %v", tt.backend, tt.textOnly, got, tt.want)
		}
	}
}
