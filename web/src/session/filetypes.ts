// Pure file-type predicates: no DOM, safe to import from tests and tsx.

/** True for image files that can be decoded by readImages / decodeImages (raster bitmaps the canvas API accepts).
 *  SVG is excluded: it is vector text, better handled as a text reference.
 *  Files with no MIME type are routed by extension so a .svg dropped from a file manager
 *  (which often leaves File.type empty) is still treated as a non-raster document. */
export const raster = (f: File) =>
  f.type.startsWith('image/') && f.type !== 'image/svg+xml' ||
  (!f.type && !/\.svg$/i.test(f.name) && /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|heif|avif)$/i.test(f.name))
