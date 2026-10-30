// Enforces individual and per-message size limits for attached PDFs.

export const MAX_FILE_SIZE = 3_500_000;
export const MAX_MESSAGE_SIZE = 3_500_000;

/** Check whether a file of the given byte size fits within the individual and per-message caps. */
export function fitsPdf({
  size,
  usedBytes,
}: {
  size: number;
  usedBytes: number;
}): 'ok' | 'file-too-big' | 'message-too-big' {
  if (size > MAX_FILE_SIZE) {
    return 'file-too-big';
  }
  if (usedBytes + size > MAX_MESSAGE_SIZE) {
    return 'message-too-big';
  }
  return 'ok';
}

/** Calculate the sum of PDF byte sizes. */
export function pdfBytes(sizes: number[]): number {
  return sizes.reduce((totalBytes, currentSize) => totalBytes + currentSize, 0);
}

