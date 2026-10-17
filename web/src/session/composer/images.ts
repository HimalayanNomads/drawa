// Images you paste or drop into a message: read, scaled down to what Claude uses, shown as thumbnails.

import { base64, imageBlock as block } from '../../lib/blobs';
import { make } from '../../lib/dom';
import { openZoom } from '../../lib/zoom';

export interface Pasted {
  type: string;
  data: string;
  url: string;
  blob?: Blob;
  w?: number;
  h?: number;
} // media type, base64, displayable URL; when read here: the bytes, pixel size

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']; // what the API accepts
const MAX_EDGE = 1568; // Claude downsizes anything larger anyway; sending less keeps requests small

/** What decodeImages made of a batch: the images to send, and the files that couldn't be decoded. */
export interface DecodedImages {
  images: Pasted[];
  failed: File[];
}

/** Decode image files into sendable images; files that fail decoding are reported in `failed`. */
export async function decodeImages(files: File[]): Promise<DecodedImages> {
  const images: Pasted[] = [],
    failed: File[] = [];
  for (const file of files) {
    try {
      images.push(await readOne(file));
    } catch {
      failed.push(file);
    }
  }
  return { images, failed };
}

/** Read image files into sendable images, omitting any that fail to decode. */
export async function readImages(files: File[]): Promise<Pasted[]> {
  return (await decodeImages(files)).images;
}

/** Read one pasted or dropped image, scaled down to what Claude uses (sent as is when it's already small enough). */
async function readOne(f: File): Promise<Pasted> {
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  // small enough and a supported type: send the file as it is (keeps GIF animation, PNG exactness)
  if (k === 1 && TYPES.includes(f.type) && f.size < 3_500_000) {
    const data = await base64(f);
    return { type: f.type, data, url: URL.createObjectURL(f), blob: f, w: bmp.width, h: bmp.height };
  }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const type = f.type === 'image/png' ? 'image/png' : 'image/jpeg'; // screenshots stay crisp, photos get smaller
  const blob = await new Promise<Blob>((res, rej) =>
    c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), type, 0.9),
  );
  return { type, data: await base64(blob), url: URL.createObjectURL(blob), blob, w: c.width, h: c.height };
}

/** An image as a message content block. */
export const imageBlock = (img: Pasted) => block(img.type, img.data);

/** A thumbnail; click to zoom and pan it. With `remove`, an × to take it off the message. */
export function thumbnail(img: Pasted, remove?: () => void) {
  const t = make('span', 'thumb'),
    pic = make('img');
  pic.src = img.url;
  pic.alt = 'Attached image';
  pic.onclick = () => openZoom(pic);
  t.append(pic);
  if (remove) {
    const x = make('button', 'x', '×');
    x.title = 'Remove image';
    x.setAttribute('aria-label', 'Remove image');
    x.onclick = remove;
    t.append(x);
  }
  return t;
}
