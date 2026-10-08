// Pictures on the canvas: paste one (Ctrl+V with nothing focused) or drop image files on the canvas; Claude can put
// one there too (canvas_create kind "image", e.g. a screenshot it took of the app). The pixels are stored by the
// server (a file named by its hash, `src`), so every browser and address sees them; pictures from before that live
// in this browser's IndexedDB (lib/blobs) and move to the server the first time they're shown. Draw on it to point at things, then @ it or drop it on a
// card: Claude gets the picture, with your drawing when there is one.
import { make, ping, toast, typing, uuid, button, iconButton, confirmBox, saveFile, ICON } from '../lib/dom'
import { post } from '../lib/api'
import { persist, each } from '../lib/store'
import { getBlob, putBlob, dropBlob, base64 } from '../lib/blobs'
import { items, rect, savedRect, toWorld, viewCenter, changed, spotAt, type Rect } from '../canvas/canvas'
import { makeWindow, winTitle, removeButton } from '../canvas/window'
import { onReconnect } from '../lib/connection'
import { toggleFull, isFull } from '../canvas/fullview'
import { referable } from '../canvas/refs'
import { creatable } from '../canvas/tools'
import { snapshot } from '../canvas/snapshot'
import { hasInk, strokesIn, inkBox, clearInk } from '../canvas/ink'
import { cropArea } from './crop'
import { readImages } from '../session/images'

interface Saved { id: string; title: string; rect: Rect; src?: string }

/** Store a picture on the server; its key, or null when that failed (then it stays in this browser only). */
const upload = (data: string) => post('images', { data }).then((r: { key?: string }) => r.key ?? null, () => null)
const TAB = 30 // the window's tab, above the picture

/** A window size that shows the whole picture at up to 560×440. */
function fit(w: number, h: number) {
  const k = Math.min(1, 560 / w, 440 / h)
  return { w: Math.max(200, Math.round(w * k)), h: Math.max(120, Math.round(h * k) + TAB) }
}

/** Pictures that failed while the server was away, reloaded (once each) when it's back. */
const retry = new Map<HTMLImageElement, string>()
onReconnect(() => {
  for (const [img, url] of retry) img.src = url + '?r=' + Date.now()
  retry.clear()
})

function imageWindow(o: Saved) {
  const img = make('img', 'inode-img')
  img.alt = o.title
  img.draggable = false
  const box = inkBox('im:' + o.id) // drawing on the picture stays on the same spot at any size
  const { el, body } = makeWindow({
    kind: 'image', cls: 'inode', title: o.title, rect: o.rect, minW: 160, minH: 100,
    aspect: () => (img.naturalWidth && !el.classList.contains('min') ? img.naturalWidth / img.naturalHeight : undefined),
    actions: [
      iconButton(ICON.download, 'Download picture', () => download(el, img)),
      iconButton(ICON.crop, 'Crop picture', () => crop(el, box, img), 'crop-btn'),
      removeButton('Remove from canvas', () => { dropBlob(o.id).catch(() => {}); if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src) }),
    ],
  })
  el.dataset.id = o.id
  if (o.src) el.dataset.src = o.src
  el.dataset.ink = 'i:' + o.id // drawing on the window around the picture moves and saves with it
  img.onload = () => inkBox('im:' + o.id, box, img.naturalWidth, img.naturalHeight)
  el.addEventListener('rename', e => { img.alt = (e as CustomEvent<string>).detail })
  body.classList.add('inode-b')
  box.append(img)
  body.append(box)
  img.onclick = () => { if (!isFull(el)) toggleFull(el) } // click: full view, where it zooms and pans (Esc to come back)
  const gone = () => body.replaceChildren(make('p', 'none', "This picture isn't stored anymore (it was kept in another browser, or its data was cleared)."))
  if (o.src) {
    // missing (404): gone for good. No answer (server down, restarting): try again once it's back. Any other answer:
    // the server is there, so waiting for it to come back would wait forever; say so, with a Retry. The address is
    // read when it fails, not when the window is made: a crop gives the window a new picture
    img.onerror = () => {
      if (!el.dataset.src) return // cropped while the server was away: a picture kept in this browser, not on the server
      const url = '/api/images/' + el.dataset.src
      fetch(url).then(r => r.status, () => 0).then(status => {
        if (status === 404) return gone()
        if (status) return body.replaceChildren(make('p', 'none', `This picture couldn't be loaded (${status === 200 ? 'not a readable image' : `the server answered ${status}`}).`),
          button('Retry', '', () => { body.replaceChildren(box); img.src = url + '?r=' + Date.now() }))
        img.alt = `${o.title} (couldn't load; retrying when the server is back)`
        retry.set(img, url)
      })
    }
    img.src = '/api/images/' + o.src
  }
  else getBlob(o.id).catch(() => undefined).then(async b => {
    if (!b) return gone() // not in this browser, or IndexedDB couldn't be read
    img.src = URL.createObjectURL(b)
    const key = await upload(await base64(b)) // an older picture: give it to the server so every browser has it
    if (key) { el.dataset.src = key; dropBlob(o.id).catch(() => {}); changed() }
  }).catch(() => {})
  return el
}

/** Save the stored picture (without the drawing on it) as a file named after the window. */
async function download(el: HTMLElement, img: HTMLImageElement) {
  const b = img.src && await fetch(img.src).then(r => (r.ok ? r.blob() : null), () => null)
  if (!b) return toast("Couldn't download the picture.")
  // the extension follows the bytes: a big WebP or GIF was stored as a JPEG
  const ext = (b.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '')
  saveFile(b, `${winTitle(el).replace(/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i, '').trim() || 'picture'}.${ext}`)
}

/** Crop a picture window to an area the user picks. The cut picture is stored like a new one and replaces it. */
async function crop(el: HTMLElement, box: HTMLElement, img: HTMLImageElement) {
  if (!img.naturalWidth || el.dataset.state === 'crop') return // not loaded (or gone), or already cropping
  const inked = hasInk(box) // only what's drawn on the picture; the frame's ink doesn't depend on its pixels
  if (inked && !await confirmBox('Crop picture', 'The drawing on this picture will be removed.', 'Crop')) return
  const a = await cropArea(box, img)
  if (!a) return
  try {
    const type = (await fetch(img.src).then(r => r.blob())).type // cached; keeps JPEG and WebP from growing into PNG
    const c = Object.assign(document.createElement('canvas'), { width: a.w, height: a.h })
    c.getContext('2d')!.drawImage(img, a.x, a.y, a.w, a.h, 0, 0, a.w, a.h)
    const blob = await new Promise<Blob | null>(res => c.toBlob(res, /^image\/(jpeg|webp)$/.test(type) ? type : 'image/png'))
    if (!blob) throw new Error('empty picture')
    const key = await upload(await base64(blob))
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src)
    if (key) { el.dataset.src = key; img.src = '/api/images/' + key; dropBlob(el.dataset.id!).catch(() => {}) }
    else { await putBlob(el.dataset.id!, blob); delete el.dataset.src; img.src = URL.createObjectURL(blob) } // server away: this browser keeps it
  } catch {
    return toast("Couldn't crop the picture.")
  }
  if (inked) clearInk(box)
  const s = fit(a.w, a.h) // img.onload reshapes the ink box to the new picture
  el.style.width = s.w + 'px'
  el.style.height = s.h + 'px'
  changed()
}

/** Put a picture on the canvas. `at`: its top-left corner in canvas pixels (default: the middle of the view). In a
 *  group's frame, it joins the group. */
export async function addImage(blob: Blob, title: string, at?: { x: number; y: number }) {
  const [img] = await readImages([new File([blob], title, { type: blob.type })]) // scaled to what Claude can use
  if (!img) throw new Error("That file couldn't be read as an image.")
  URL.revokeObjectURL(img.url) // shown from the server (or IndexedDB) instead
  const size = fit(img.w!, img.h!), id = uuid()
  const src = await upload(img.data) ?? undefined
  if (!src) await putBlob(id, img.blob!) // the server is unreachable: keep it in this browser for now
  const c = viewCenter(), r = spotAt({ ...(at ?? { x: c.x - size.w / 2, y: c.y - size.h / 2 }), ...size })
  const el = imageWindow({ id, title, rect: r, src })
  changed()
  return el
}

/* ---------- paste and drop ---------- */
const imageFiles = (l?: FileList | null) => [...l ?? []].filter(f => f.type.startsWith('image/'))

document.addEventListener('paste', e => {
  const files = imageFiles(e.clipboardData?.files)
  if (!files.length || e.defaultPrevented || typing(e.target)) return // a message box takes it as an attachment
  e.preventDefault()
  files.forEach(f => addImage(f, f.name === 'image.png' ? 'Pasted image' : f.name).then(ping, e => toast(`Couldn't add the picture: ${(e as Error).message}`)))
})
addEventListener('drop', e => {
  const files = imageFiles(e.dataTransfer?.files), t = e.target as Element
  if (!files.length || t.closest?.('.dock, .pinbar') || !t.closest?.('#stage')) return // a message box attaches it; not onto pinned windows
  const p = toWorld(e.clientX, e.clientY)
  files.forEach((f, i) => addImage(f, f.name, { x: p.x + i * 40, y: p.y + i * 40 }).then(ping, e => toast(`Couldn't add ${f.name}: ${(e as Error).message}`)))
})

/* ---------- Claude, saving, sending ---------- */
creatable('image', {
  needs: 'path',
  size: () => ({ w: 480, h: 360 }),
  create: async (a, r) => {
    // the server already stored Claude's file (a.image is its key); addImage scales it to what Claude can take back,
    // storing that copy (the same key when no scaling was needed)
    const res = await fetch('/api/images/' + encodeURIComponent(String(a.image ?? '')))
    if (!res.ok) throw new Error("The image didn't reach the canvas page. Try again.")
    const name = String(a.path).split('/').pop() ?? 'image'
    return addImage(await res.blob(), String(a.title ?? name), { x: r.x, y: r.y })
  },
})
persist('images',
  () => items('image').map((el): Saved => ({ id: el.dataset.id!, title: winTitle(el), rect: savedRect(el), src: el.dataset.src })),
  (list: Saved[]) => each(list, imageWindow))
referable('image', {
  icon: '▣',
  picture: true,
  content: async (el, label) => {
    const text = `Image from my canvas ("${label}")`
    // drawn on: the picture as it looks with the drawing; otherwise the stored original, full detail
    if (hasInk(el) || strokesIn(rect(el)).length) return { text: text + ', with what I drew on it', image: (await snapshot(el, { always: true }))! }
    const b = await (el.dataset.src
      ? fetch('/api/images/' + el.dataset.src).then(r => (r.ok ? r.blob() : undefined))
      : getBlob(el.dataset.id!)).catch(() => undefined)
    return b ? { text, image: await base64(b), imageType: b.type } : { text: text + ' (no longer stored)' }
  },
})
