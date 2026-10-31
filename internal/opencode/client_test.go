package opencode

import (
	"testing"
)

// parts (v1) and textAndFiles (v2) convert document blocks to file parts preserving mime and base64 data,
// while silently dropping unknown block types (#136).
func TestPartsAndTextAndFiles(t *testing.T) {
	input := []any{
		map[string]any{"type": "text", "text": "hello"},
		map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": "image/png",
				"data":       "PNG123",
			},
		},
		map[string]any{
			"type": "document",
			"source": map[string]any{
				"type":       "base64",
				"media_type": "application/pdf",
				"data":       "PDF456",
			},
			"title": "doc.pdf",
		},
		map[string]any{
			"type": "unknown_custom",
			"data": "should be dropped",
		},
	}

	// v1: parts
	p := parts(input)
	if len(p) != 3 {
		t.Fatalf("parts() count = %d, want 3 (unknown dropped)", len(p))
	}
	if p[0]["type"] != "text" || p[0]["text"] != "hello" {
		t.Errorf("parts[0] = %v, want text block", p[0])
	}
	if p[1]["type"] != "file" || p[1]["mime"] != "image/png" || p[1]["url"] != "data:image/png;base64,PNG123" {
		t.Errorf("parts[1] = %v, want image file part", p[1])
	}
	if p[2]["type"] != "file" || p[2]["mime"] != "application/pdf" || p[2]["url"] != "data:application/pdf;base64,PDF456" {
		t.Errorf("parts[2] = %v, want document file part", p[2])
	}

	// v2: textAndFiles
	text, files := textAndFiles(input)
	if text != "hello" {
		t.Errorf("textAndFiles() text = %q, want hello", text)
	}
	if len(files) != 2 {
		t.Fatalf("textAndFiles() files count = %d, want 2", len(files))
	}
	if files[0]["uri"] != "data:image/png;base64,PNG123" {
		t.Errorf("files[0] = %v, want image uri", files[0])
	}
	if files[1]["uri"] != "data:application/pdf;base64,PDF456" {
		t.Errorf("files[1] = %v, want document uri", files[1])
	}
}
