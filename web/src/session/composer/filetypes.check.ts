// Which files are treated as bitmap images or PDF documents. Run: cd web && pnpm dlx tsx src/session/composer/filetypes.check.ts
import { pdf, raster } from './filetypes';

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

eq(pdf(file('doc.pdf', 'application/pdf')), true, 'PDF with application/pdf MIME type');
eq(pdf(file('doc.pdf', '')), true, 'PDF with empty MIME type and .pdf extension');
eq(pdf(file('DOC.PDF', '')), true, 'PDF with uppercase extension and empty type');
eq(pdf(file('doc.pdf', 'text/plain')), false, 'PDF extension with non-empty non-PDF MIME type');
eq(pdf(file('photo.png', 'image/png')), false, 'PNG is not a PDF');
eq(pdf(file('notes.txt', 'text/plain')), false, 'plain text is not a PDF');
eq(pdf(file('no-ext', '')), false, 'empty type without extension is not a PDF');

console.log('filetypes: ok');
