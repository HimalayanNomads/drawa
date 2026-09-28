// File previews: a project file in a window, opened from Ctrl+K. Code is highlighted, Markdown rendered, pictures
// shown. Only the path is saved: the file is read from disk when the window opens (again after a reload, or with
// the reload button), so it shows the file as it is without filling localStorage. One window per file.
import { api, q } from '../lib/api'
import { make, iconButton, ICON } from '../lib/dom'
import { enhanceMarked } from '../lib/markdown'
import { persist, each } from '../lib/store'
import { items, savedRect, freeSpot, viewCenter, changed, type Rect } from '../canvas/canvas'
import { makeWindow, removeButton, winTitle } from '../canvas/window'
import { referable } from '../canvas/refs'
import { inkBox } from '../canvas/ink'
import { toggleFull, isFull } from '../canvas/fullview'
import { openZoom } from '../lib/zoom'
import { fileOpener } from '../canvas/find'
import { sourceView, mdView, isMarkdown } from '../panels/files'

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i // what /api/raw serves
interface Saved { path: string; title: string; rect: Rect }

// before any window: the tab's glyph is this icon. Claude gets the path and reads the file itself, so a big file
// isn't pasted into the message and it sees the file as it is when it reads it.
referable('preview', {
  icon: '◫',
  name: 'file',
  label: el => el.dataset.path ?? '',
  content: el => ({ text: `File: ${el.dataset.path} (read it if you need its contents)` }),
})

/** A text file as shown: Markdown rendered, anything else as code. `lines`: only the start (Ctrl+K's preview). */
async function textView(path: string, lines?: number) {
  try {
    let { text } = await api<{ text: string | null }>('file?path=' + q(path))
    if (text != null && lines) text = text.split('\n', lines).join('\n')
    return text != null && isMarkdown(path) ? mdView(path, text) : await sourceView(path, text)
  } catch (e) {
    return make('p', 'none', (e as Error).message)
  }
}

/** Show `node` in the ink host, keeping the ink layer drawn on it. Markdown built off-page is finished here. */
function fill(host: HTMLElement, node: Node) {
  for (const c of [...host.children]) if (!c.matches('svg.ink-local')) c.remove()
  host.prepend(node)
  enhanceMarked(host)
}

/** The picture, drawn in its ink host. `again`: the reload button, so it skips the copy the page already has. */
function picture(el: HTMLElement, host: HTMLElement, again: boolean) {
  const img = make('img', 'inode-img')
  img.alt = winTitle(el)
  img.onload = () => inkBox(host.dataset.ink!, host, img.naturalWidth, img.naturalHeight)
  img.onclick = () => (isFull(el) ? openZoom(img) : toggleFull(el)) // as a picture window: full view, then zoom and pan
  img.onerror = () => { if (img.isConnected) fill(host, make('p', 'none', "This picture can't be read: moved, deleted, or over 20 MB.")) }
  img.src = '/api/raw?path=' + q(el.dataset.path!) + (again ? '&v=' + Date.now() : '')
  return img
}

export function preview(o: { path: string; title?: string; rect: Rect }) {
  const { el, body } = makeWindow({
    kind: 'preview', cls: 'pvnode', title: o.title || o.path.split('/').pop()!, rect: o.rect, minW: 200, minH: 120,
    actions: [iconButton(ICON.reload, 'Read the file again', () => load(true)), removeButton('Remove from canvas')],
  })
  const key = 'pv:' + o.path, image = IMAGE.test(o.path)
  el.dataset.id = 'preview:' + o.path // the same after a reload: arrows and canvas tools find it by this
  el.dataset.path = o.path
  // the ink host is made once, here: strokes stay on it through the reload button, and restoring ink (phase 2)
  // finds it before the file is read. A picture's keeps its spot at any size; text's scrolls with the text.
  const host = image ? inkBox(key) : make('div', 'pvnode-s')
  host.dataset.ink = key
  if (image) body.classList.add('inode-b')
  host.append(make('p', 'none', 'Reading…'))
  body.append(host)
  let loads = 0 // only the newest read is shown, when the reload button is pressed while one is still coming
  const load = async (again = false) => {
    const n = ++loads, view = image ? picture(el, host, again) : await textView(o.path)
    if (n === loads) fill(host, view)
  }
  load()
  return el
}

fileOpener(path => {
  const open = items('preview').find(el => el.dataset.path === path)
  if (open) return open // a file already open is flown to rather than opened twice
  const c = viewCenter(), el = preview({ path, rect: freeSpot({ x: c.x - 260, y: c.y - 200, w: 520, h: 400 }) })
  changed()
  return el
}, async path => IMAGE.test(path) ? Object.assign(make('img', 'finder-img'), { src: '/api/raw?path=' + q(path), alt: '' }) : textView(path, 200))

persist('previews',
  () => items('preview').map((el): Saved => ({ path: el.dataset.path!, title: winTitle(el), rect: savedRect(el) })),
  (list: Saved[]) => each(list, preview))
