// Package qr draws a QR code in the terminal, so --net's Network link can be opened on a phone by pointing its
// camera at it. Stdlib only, like the rest of the server.
//
// ponytail: byte mode, error correction L, mask 0, versions 1-5 only (up to 106 bytes: a LAN URL with its token
// is ~45). Those versions have a single error correction block, so there's no interleaving and one alignment
// pattern. Longer text returns "" rather than a wrong code; add versions (and block interleaving) if that ever matters.
package qr

import "strings"

// data and error correction codewords per version at level L (index = version).
var dataWords = [...]int{0, 19, 34, 55, 80, 108}
var eccWords = [...]int{0, 7, 10, 15, 20, 26}

// Terminal renders text as a QR code, two modules per character row, black on white whatever the terminal's
// theme (many phone scanners can't read an inverted code). "" if the text is too long.
func Terminal(text string) string {
	m := Encode(text)
	if m == nil {
		return ""
	}
	const quiet = 2
	n := len(m)
	dark := func(y, x int) bool {
		y, x = y-quiet, x-quiet
		return y >= 0 && x >= 0 && y < n && x < n && m[y][x]
	}
	var b strings.Builder
	for y := 0; y < n+2*quiet; y += 2 {
		b.WriteString("  \x1b[30;107m")
		for x := 0; x < n+2*quiet; x++ {
			b.WriteString([]string{" ", "▄", "▀", "█"}[btoi(dark(y, x))*2+btoi(dark(y+1, x))])
		}
		b.WriteString("\x1b[0m\n")
	}
	return b.String()
}

// Encode returns the modules (true = dark), indexed [y][x], or nil if text doesn't fit version 5-L.
func Encode(text string) [][]bool {
	v := 1
	for v < len(dataWords) && 2+len(text) > dataWords[v] { // 4-bit mode + 8-bit count ≈ 2 bytes of overhead
		v++
	}
	if v == len(dataWords) {
		return nil
	}
	words := codewords([]byte(text), dataWords[v])
	words = append(words, rsRemainder(words, eccWords[v])...)

	size := 17 + 4*v
	m, fixed := grid(size), grid(size)
	set := func(x, y int, dark bool) { m[y][x], fixed[y][x] = dark, true }
	for _, c := range [][2]int{{3, 3}, {size - 4, 3}, {3, size - 4}} { // finders with their separators
		for dy := -4; dy <= 4; dy++ {
			for dx := -4; dx <= 4; dx++ {
				x, y := c[0]+dx, c[1]+dy
				if x >= 0 && y >= 0 && x < size && y < size {
					d := max(abs(dx), abs(dy))
					set(x, y, d != 2 && d != 4)
				}
			}
		}
	}
	for i := 8; i < size-8; i++ { // timing
		set(i, 6, i%2 == 0)
		set(6, i, i%2 == 0)
	}
	if v > 1 {
		for dy := -2; dy <= 2; dy++ {
			for dx := -2; dx <= 2; dx++ {
				set(size-7+dx, size-7+dy, max(abs(dx), abs(dy)) != 1)
			}
		}
	}
	format := formatBits()
	bit := func(i int) bool { return format>>i&1 == 1 }
	for i := 0; i <= 5; i++ {
		set(8, i, bit(i))
	}
	set(8, 7, bit(6))
	set(8, 8, bit(7))
	set(7, 8, bit(8))
	for i := 9; i < 15; i++ {
		set(14-i, 8, bit(i))
	}
	for i := 0; i < 8; i++ {
		set(size-1-i, 8, bit(i))
	}
	for i := 8; i < 15; i++ {
		set(8, size-15+i, bit(i))
	}
	set(8, size-8, true) // the dark module

	i := 0 // zigzag up and down two-column strips from the right, skipping the vertical timing column
	for right := size - 1; right >= 1; right -= 2 {
		if right == 6 {
			right = 5
		}
		for vert := 0; vert < size; vert++ {
			for j := 0; j < 2; j++ {
				x, y := right-j, vert
				if (right+1)&2 == 0 {
					y = size - 1 - vert
				}
				if fixed[y][x] {
					continue
				}
				if i < len(words)*8 {
					m[y][x] = words[i>>3]>>(7-i&7)&1 == 1
					i++
				}
				m[y][x] = m[y][x] != ((x+y)%2 == 0) // mask 0
			}
		}
	}
	return m
}

// codewords is the data bit stream: byte mode, length, the bytes, a terminator, then the standard pad bytes.
func codewords(data []byte, capacity int) []byte {
	out := []byte{0x40 | byte(len(data)>>4), byte(len(data) << 4)}
	for _, c := range data {
		out[len(out)-1] |= c >> 4
		out = append(out, c<<4)
	} // the last byte's low nibble is the 0000 terminator
	for pad := byte(0xEC); len(out) < capacity; pad ^= 0xEC ^ 0x11 {
		out = append(out, pad)
	}
	return out
}

// formatBits is level L with mask 0, BCH-protected and XOR-masked as the spec says.
func formatBits() int {
	data := 1<<3 | 0 // L = 01, mask 000
	rem := data
	for i := 0; i < 10; i++ {
		rem = rem<<1 ^ (rem>>9)*0x537
	}
	return (data<<10 | rem) ^ 0x5412
}

// rsRemainder is the Reed-Solomon error correction for data over GF(256) with polynomial 0x11D.
func rsRemainder(data []byte, n int) []byte {
	gen := make([]byte, n) // generator coefficients, highest power dropped
	gen[n-1] = 1
	root := byte(1)
	for i := 0; i < n; i++ {
		for j := 0; j < n; j++ {
			gen[j] = gfMul(gen[j], root)
			if j+1 < n {
				gen[j] ^= gen[j+1]
			}
		}
		root = gfMul(root, 2)
	}
	rem := make([]byte, n)
	for _, b := range data {
		f := b ^ rem[0]
		copy(rem, rem[1:])
		rem[n-1] = 0
		for j := range rem {
			rem[j] ^= gfMul(gen[j], f)
		}
	}
	return rem
}

func gfMul(x, y byte) byte {
	z := 0
	for i := 7; i >= 0; i-- {
		z = z<<1 ^ (z>>7)*0x11D
		z ^= int(y>>i&1) * int(x)
	}
	return byte(z)
}

func grid(n int) [][]bool {
	g := make([][]bool, n)
	for i := range g {
		g[i] = make([]bool, n)
	}
	return g
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}
