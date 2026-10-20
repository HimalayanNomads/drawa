// Which dropped and pasted files are treated as bitmap images.

/** Whether a dropped or pasted file is a bitmap image that can be decoded and sent as a picture.
 *  SVG is excluded by name: it is XML markup that is sent as text, and browser decode support for it differs. */
export const raster = (file: File): boolean => file.type.startsWith('image/') && file.type !== 'image/svg+xml';
