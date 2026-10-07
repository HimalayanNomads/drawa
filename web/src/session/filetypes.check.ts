// Raster-predicate checks: no DOM, no browser. Run: cd web && npx --yes tsx src/session/filetypes.check.ts
import { raster } from './filetypes'

const ok = (got: boolean, want: boolean, what: string) => {
  if (got !== want) throw new Error(`${what}: got ${got}, want ${want}`)
}

const f = (name: string, type: string) => ({ name, type })

// Known raster MIME types → accepted
ok(raster(f('a.png',  'image/png')),  true,  'image/png is raster')
ok(raster(f('a.jpg',  'image/jpeg')), true,  'image/jpeg is raster')
ok(raster(f('a.gif',  'image/gif')),  true,  'image/gif is raster')
ok(raster(f('a.webp', 'image/webp')), true,  'image/webp is raster')
// image/heic and image/tiff are routed to decodeImages(); if the browser cannot decode them
// they come back as `failed` and attachAny() forwards them to textRefs() — that is intended.
ok(raster(f('a.heic', 'image/heic')), true,  'image/heic is raster (may fall back to textRefs on decode failure)')
ok(raster(f('a.tiff', 'image/tiff')), true,  'image/tiff is raster (may fall back to textRefs on decode failure)')

// SVG → always rejected (vector, not a bitmap)
ok(raster(f('a.svg', 'image/svg+xml')), false, 'image/svg+xml is not raster')

// Non-image MIME types → rejected
ok(raster(f('a.txt', 'text/plain')),     false, 'text/plain is not raster')
ok(raster(f('a.pdf', 'application/pdf')), false, 'application/pdf is not raster')

// Empty type: only known web-safe bitmap extensions → true
ok(raster(f('a.png',  '')), true,  'empty type + .png extension is raster')
ok(raster(f('a.JPG',  '')), true,  'empty type + .JPG (uppercase) extension is raster')
ok(raster(f('a.jpeg', '')), true,  'empty type + .jpeg extension is raster')
ok(raster(f('a.gif',  '')), true,  'empty type + .gif extension is raster')
ok(raster(f('a.webp', '')), true,  'empty type + .webp extension is raster')

// Empty type: .svg and non-image extensions → false
ok(raster(f('a.svg',    '')), false, 'empty type + .svg is not raster')
ok(raster(f('notes.md', '')), false, 'empty type + .md is not raster')
ok(raster(f('main.go',  '')), false, 'empty type + .go is not raster')
ok(raster(f('app.ts',   '')), false, 'empty type + .ts is not raster')
ok(raster(f('README',   '')), false, 'empty type + no extension is not raster')

console.log('filetypes: ok')
