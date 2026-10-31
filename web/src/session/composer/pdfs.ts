// PDF files dropped or pasted into a message box: validated (size cap, %PDF- magic bytes),
// read as base64 and sent as document blocks, shown as upload chips.

import type { Ref } from '../../canvas/core/refs';
import { base64 } from '../../lib/blobs';
import { make, toast } from '../../lib/dom';
import { fitsPdf } from './pdfLimits';

const pdfMagic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** The base64 payload, title, and raw byte size stored for a PDF upload reference element. */
export interface StoredPdf {
  data: string;
  title: string;
  size: number;
}

const pdfStore = new WeakMap<HTMLElement, StoredPdf>();

/** Retrieve the stored PDF data for an upload element, or undefined if it is not a PDF. */
export const getPdf = (element: HTMLElement): StoredPdf | undefined => pdfStore.get(element);

/** Check whether a file starts with the %PDF- magic bytes. */
async function hasPdfHeader(file: File): Promise<boolean> {
  if (file.size < 5) return false;
  const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return pdfMagic.every((expectedByte, index) => header[index] === expectedByte);
}

/** Read the PDF files among `files` into upload references; say why any were skipped. */
export async function pdfRefs(files: File[], existingBytes = 0): Promise<Ref[]> {
  const refs: Ref[] = [],
    skipped: string[] = [];
  let totalBytes = existingBytes;

  for (const file of files) {
    const fitStatus = fitsPdf({ size: file.size, usedBytes: totalBytes });
    if (fitStatus === 'file-too-big') {
      skipped.push(`${file.name} (over 3.5MB)`);
      continue;
    }
    if (fitStatus === 'message-too-big') {
      toast('PDFs add up to over 3.5MB for one message: remove one');
      continue;
    }
    if (!(await hasPdfHeader(file))) {
      skipped.push(`${file.name} (not a PDF file)`);
      continue;
    }
    totalBytes += file.size;
    const element = make('span');
    element.dataset.label = file.name;
    const data = await base64(file);
    pdfStore.set(element, { data, title: file.name, size: file.size });
    refs.push({ kind: 'upload', label: file.name, el: element });
  }

  if (skipped.length) {
    toast(`Not attached: ${skipped.join(', ')}. Text files, PDFs and images can be attached.`);
  }
  return refs;
}
