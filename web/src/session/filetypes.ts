// Pure file-type predicates: no DOM, safe to import from tests and tsx.

/** True for image files that should be sent to decodeImages() (raster bitmaps the canvas API
 *  can decode). SVG is excluded: it is vector text, better sent as a file reference.
 *
 *  - Any type starting with 'image/' (except 'image/svg+xml') is accepted regardless of name.
 *    Types like image/heic or image/tiff may fail inside decodeImages(); those failures come
 *    back as `failed` files and attachAny() forwards them to textRefs() — that is intended.
 *  - An empty type is accepted ONLY when the name ends in a known web-safe bitmap extension
 *    (.png, .jpg, .jpeg, .gif, .webp, case-insensitive). File managers on some platforms omit
 *    the MIME type; this catches the common cases without wrongly treating source code or docs
 *    as images. All other empty-type files (scripts, markdown, SVG, unknown) are left to
 *    textRefs() / the caller.
 *  - Any other non-empty type (text/plain, application/pdf, …) is rejected. */
export const raster = (f: { type: string; name: string }) =>
  f.type !== '' ? f.type.startsWith('image/') && f.type !== 'image/svg+xml'
                : /\.(png|jpe?g|gif|webp)$/i.test(f.name)
