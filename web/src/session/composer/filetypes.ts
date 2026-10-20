// Which dropped and pasted files are treated as bitmap images or PDF documents.

/** Whether a dropped or pasted file is a bitmap image that can be decoded and sent as a picture.
 *  SVG is excluded by name: it is XML markup that is sent as text, and browser decode support for it differs. */
export const raster = (file: File): boolean => file.type.startsWith('image/') && file.type !== 'image/svg+xml';

/** Whether a dropped or pasted file is a PDF document, identified by MIME type or .pdf extension when the type is empty. */
export const pdf = (file: File): boolean =>
  file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name));
