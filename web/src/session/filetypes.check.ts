// Raster-predicate checks: no DOM, no browser. Run: cd web && npx --yes tsx src/session/filetypes.check.ts
import { raster } from './filetypes'

const ok = (got: boolean, want: boolean, what: string) => {
  if (got !== want) throw new Error(`${what}: got ${got}, want ${want}`)
}

const f = (name: string, type: string) => new File([], name, { type })

// Known raster MIME types → accepted
ok(raster(f('a.png',  'image/png')),  true,  'image/png is raster')
ok(raster(f('a.jpg',  'image/jpeg')), true,  'image/jpeg is raster')
ok(raster(f('a.heic', 'image/heic')), true,  'image/heic is raster')
ok(raster(f('a.tiff', 'image/tiff')), true,  'image/tiff is raster')

// Explicitly excluded vector / document types → rejected
ok(raster(f('a.svg',  'image/svg+xml')), false, 'image/svg+xml is not raster')
ok(raster(f('a.txt',  'text/plain')),    false, 'text/plain is not raster')
ok(raster(f('a.pdf',  'application/pdf')), false, 'application/pdf is not raster')

// Empty type: extension decides
// A .svg file with no MIME type must be treated as non-raster (same as image/svg+xml).
ok(raster(f('a.svg', '')), false, 'empty type + .svg extension is not raster')
// An empty type with no known image extension is also rejected (binary unknown file).
ok(raster(f('a.bin', '')), false, 'empty type + unknown extension is not raster')
// A .png with no MIME type (some file managers omit it) is accepted.
ok(raster(f('a.png', '')), true, 'empty type + .png extension is raster')

console.log('filetypes: ok')
