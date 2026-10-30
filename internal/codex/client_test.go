package codex

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"

	"drawa/internal/live"
)

func TestInputOrderingAndTypes(t *testing.T) {
	savedFiles := make(map[string][]byte)
	saver := func(title string, data []byte) (string, error) {
		path := "/fake/uploads/" + title
		savedFiles[title] = data
		return path, nil
	}

	rawPDF1 := "%PDF-1.4 file one content"
	rawPDF2 := "%PDF-1.4 file two content"
	b64PDF1 := base64.StdEncoding.EncodeToString([]byte(rawPDF1))
	b64PDF2 := base64.StdEncoding.EncodeToString([]byte(rawPDF2))

	content := []any{
		map[string]any{"type": "text", "text": "intro note"},
		map[string]any{
			"type":  "document",
			"title": "doc1.pdf",
			"source": map[string]any{
				"type":       "base64",
				"media_type": "application/pdf",
				"data":       b64PDF1,
			},
		},
		map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": "image/png",
				"data":       "iVBORw0KGgoAAAANSUhEUg==",
			},
		},
		map[string]any{
			"type":  "document",
			"title": "doc2.pdf",
			"source": map[string]any{
				"type":       "base64",
				"media_type": "application/pdf",
				"data":       b64PDF2,
			},
		},
		map[string]any{"type": "text", "text": "outro note"},
	}

	items, err := input(content, saver)
	if err != nil {
		t.Fatalf("input failed: %v", err)
	}

	if len(items) != 5 {
		t.Fatalf("expected 5 items, got %d", len(items))
	}

	if items[0]["type"] != "text" || items[0]["text"] != "intro note" {
		t.Errorf("item 0 mismatch: %v", items[0])
	}
	if items[1]["type"] != "text" {
		t.Errorf("item 1 not text: %v", items[1])
	}
	wantNote1 := fmt.Sprintf("Attached PDF %q saved at %s; open it with your file tools.", "doc1.pdf", "/fake/uploads/doc1.pdf")
	if items[1]["text"] != wantNote1 {
		t.Errorf("item 1 text mismatch:\ngot  %q\nwant %q", items[1]["text"], wantNote1)
	}
	if items[2]["type"] != "image" || items[2]["url"] != "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" {
		t.Errorf("item 2 image mismatch: %v", items[2])
	}
	if items[3]["type"] != "text" {
		t.Errorf("item 3 not text: %v", items[3])
	}
	wantNote2 := fmt.Sprintf("Attached PDF %q saved at %s; open it with your file tools.", "doc2.pdf", "/fake/uploads/doc2.pdf")
	if items[3]["text"] != wantNote2 {
		t.Errorf("item 3 text mismatch:\ngot  %q\nwant %q", items[3]["text"], wantNote2)
	}
	if items[4]["type"] != "text" || items[4]["text"] != "outro note" {
		t.Errorf("item 4 mismatch: %v", items[4])
	}
}

func TestInputTwoSameNamePDFs(t *testing.T) {
	var savedPaths []string
	callCount := 0
	saver := func(title string, data []byte) (string, error) {
		callCount++
		path := fmt.Sprintf("/fake/uploads/run%d/%s", callCount, title)
		savedPaths = append(savedPaths, path)
		return path, nil
	}

	rawPDF := "%PDF-1.4 file content"
	b64PDF := base64.StdEncoding.EncodeToString([]byte(rawPDF))

	content := []any{
		map[string]any{
			"type":  "document",
			"title": "same.pdf",
			"source": map[string]any{
				"type": "base64",
				"data": b64PDF,
			},
		},
		map[string]any{
			"type":  "document",
			"title": "same.pdf",
			"source": map[string]any{
				"type": "base64",
				"data": b64PDF,
			},
		},
	}

	items, err := input(content, saver)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	if callCount != 2 {
		t.Fatalf("expected saver to be called twice, got %d", callCount)
	}
	if !strings.Contains(items[0]["text"].(string), savedPaths[0]) {
		t.Errorf("expected item 0 to reference %s, got %s", savedPaths[0], items[0]["text"])
	}
	if !strings.Contains(items[1]["text"].(string), savedPaths[1]) {
		t.Errorf("expected item 1 to reference %s, got %s", savedPaths[1], items[1]["text"])
	}
}

func TestInputMalformedDocumentSkipped(t *testing.T) {
	saverCalled := false
	saver := func(title string, data []byte) (string, error) {
		saverCalled = true
		return "/fake/" + title, nil
	}

	content := []any{
		map[string]any{"type": "document"},
		map[string]any{"type": "document", "source": "not-a-map"},
		map[string]any{"type": "document", "source": map[string]any{"type": "url"}},
		map[string]any{"type": "document", "source": map[string]any{"type": "base64", "data": "invalid!base64@@@"}},
		map[string]any{"type": "text", "text": "valid"},
	}

	items, err := input(content, saver)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if saverCalled {
		t.Fatalf("expected saver not to be called for malformed blocks")
	}
	if len(items) != 1 || items[0]["text"] != "valid" {
		t.Fatalf("expected only valid text block, got: %v", items)
	}
}

func TestInputSaverErrorReturnsRefused(t *testing.T) {
	saver := func(title string, data []byte) (string, error) {
		return "", errors.New("disk full")
	}

	rawPDF := "%PDF-1.4 file content"
	b64PDF := base64.StdEncoding.EncodeToString([]byte(rawPDF))

	content := []any{
		map[string]any{
			"type":  "document",
			"title": "report.pdf",
			"source": map[string]any{
				"type": "base64",
				"data": b64PDF,
			},
		},
	}

	items, err := input(content, saver)
	if items != nil {
		t.Fatalf("expected nil items on error, got %v", items)
	}
	if err == nil {
		t.Fatalf("expected error from input")
	}

	var refused *live.Refused
	if !errors.As(err, &refused) {
		t.Fatalf("expected err to be *live.Refused, got %T: %v", err, err)
	}
	errMsg := refused.Error()
	if !strings.Contains(errMsg, "could not save \"report.pdf\" for Codex") || !strings.Contains(errMsg, "disk full") {
		t.Fatalf("expected user-readable message naming file and cause, got: %q", errMsg)
	}
}

func TestInputStringContentUnchanged(t *testing.T) {
	saver := func(title string, data []byte) (string, error) {
		return "", nil
	}
	items, err := input("simple string message", saver)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(items) != 1 || items[0]["type"] != "text" || items[0]["text"] != "simple string message" {
		t.Fatalf("expected single text item for string content, got: %v", items)
	}
}
