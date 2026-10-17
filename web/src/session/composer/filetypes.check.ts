// Which files are treated as bitmap images. Run: cd web && pnpm dlx tsx src/session/composer/filetypes.check.ts
import { raster } from './filetypes';

/** Throw unless `got` equals `want` (compared as JSON). */
const eq = (got: unknown, want: unknown, what: string) => {
  const gotJson = JSON.stringify(got),
    wantJson = JSON.stringify(want);
  if (gotJson !== wantJson) throw new Error(`${what}: got ${gotJson}, want ${wantJson}`);
};

/** An empty File with the given name and MIME type: enough for type checks, no browser needed. */
const file = (name: string, type: string) => new File([], name, { type });

eq(raster(file('photo.png', 'image/png')), true, 'PNG is a raster image');
eq(raster(file('photo.jpeg', 'image/jpeg')), true, 'JPEG is a raster image');
eq(raster(file('photo.webp', 'image/webp')), true, 'WebP is a raster image');
eq(raster(file('photo.heic', 'image/heic')), true, 'HEIC has an image type');
eq(raster(file('diagram.svg', 'image/svg+xml')), false, 'SVG is excluded from raster images');
eq(raster(file('notes.txt', 'text/plain')), false, 'plain text is not an image');
eq(raster(file('doc.pdf', 'application/pdf')), false, 'PDF is not an image');
eq(raster(file('data.json', 'application/json')), false, 'JSON is not an image');
eq(raster(file('a.png', '')), false, 'empty type is not a raster image even with .png extension');

console.log('filetypes: ok');
