// Images you paste or drop into a message: read, scaled down to what Claude uses, shown as thumbnails.
import { make } from '../lib/dom'
import { openZoom } from '../lib/zoom'
import { base64, imageBlock as block } from '../lib/blobs'

export interface Pasted { type: string; data: string; url: string; blob?: Blob; w?: number; h?: number } // media type, base64, displayable URL; when read here: the bytes, pixel size

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] // what the API accepts
const MAX_EDGE = 1568 // Claude downsizes anything larger anyway; sending less keeps requests small

/** Read image files into sendable images, collecting the ones that failed to decode.
 *  A file throws when the browser can't interpret it as a bitmap (wrong format, corrupted, SVG
 *  that createImageBitmap refuses, etc.). Those come back in `failed` so the caller can route
 *  them elsewhere instead of silently dropping them. */
export async function decodeImages(files: File[]): Promise<{ images: Pasted[]; failed: File[] }> {
  const images: Pasted[] = [], failed: File[] = []
  for (const f of files) {
    try { images.push(await readOne(f)) } catch (e) { console.warn('image skipped:', f.name, e); failed.push(f) }
  }
  return { images, failed }
}

/** Read image files into sendable images. Other types, or ones that fail to decode, are skipped. */
export async function readImages(files: File[]): Promise<Pasted[]> {
  return (await decodeImages(files)).images
}

async function readOne(f: File): Promise<Pasted> {
  const bmp = await createImageBitmap(f)
  const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
  // small enough and a supported type: send the file as it is (keeps GIF animation, PNG exactness)
  if (k === 1 && TYPES.includes(f.type) && f.size < 3_500_000) {
    const data = await base64(f)
    return { type: f.type, data, url: URL.createObjectURL(f), blob: f, w: bmp.width, h: bmp.height }
  }
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k)
  c.height = Math.round(bmp.height * k)
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  const type = f.type === 'image/png' ? 'image/png' : 'image/jpeg' // screenshots stay crisp, photos get smaller
  const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), type, 0.9))
  return { type, data: await base64(blob), url: URL.createObjectURL(blob), blob, w: c.width, h: c.height }
}

export const imageBlock = (img: Pasted) => block(img.type, img.data)

/** A thumbnail; click to zoom and pan it. With `remove`, an × to take it off the message. */
export function thumb(img: Pasted, remove?: () => void) {
  const t = make('span', 'thumb'), pic = make('img')
  pic.src = img.url
  pic.alt = 'Attached image'
  pic.onclick = () => openZoom(pic)
  t.append(pic)
  if (remove) {
    const x = make('button', 'x', '×')
    x.title = 'Remove image'
    x.setAttribute('aria-label', 'Remove image')
    x.onclick = remove
    t.append(x)
  }
  return t
}
