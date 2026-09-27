package qr

import (
	"strings"
	"testing"
)

// Codes from this package were checked against a real decoder (zxing) for versions 1-5; this pins the pieces
// that would silently break them.
func TestEncode(t *testing.T) {
	if got := formatBits(); got != 0x77C4 { // the spec's table value for level L, mask 0
		t.Fatalf("format bits %#x", got)
	}
	// ISO 18004 annex example: "01234567" at 1-M has ECC a5 24 d4 c1 ed 36 c7 87 2c 55 for these data codewords.
	data := []byte{0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11}
	if got := rsRemainder(data, 10); string(got) != "\xa5\x24\xd4\xc1\xed\x36\xc7\x87\x2c\x55" {
		t.Fatalf("reed-solomon % x", got)
	}
	for n, size := range map[int]int{1: 21, 45: 29, 106: 37} {
		if m := Encode(strings.Repeat("x", n)); len(m) != size {
			t.Fatalf("%d bytes: size %d, want %d", n, len(m), size)
		}
	}
	if Encode(strings.Repeat("x", 107)) != nil {
		t.Fatal("too long for 5-L should be nil")
	}
}
