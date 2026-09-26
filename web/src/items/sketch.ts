// Excalidraw sketches. On the canvas a sketch is a node showing a preview; double-click (or Edit) opens the
// full editor in a dialog. (Excalidraw miscomputes pointer positions inside a CSS-scaled parent, so it can't
// be edited in place on the zoomable canvas.)
import { $, make, ICON, iconButton, project, confirmBox, uuid } from '../lib/dom'
import { persist, each } from '../lib/store'
import { isDark, onTheme } from '../lib/theme'
import { forget } from '../canvas/graph'
import { items, savedRect, freeSpot, viewCenter, centerOn, changed, type Rect } from '../canvas/canvas'
import { makeWindow } from '../canvas/window'
import { referable } from '../canvas/refs'
import { inkBox, fitInk } from '../canvas/ink'
import { base64 } from '../lib/blobs'
import { removable } from '../canvas/select'

type Excalidraw = typeof import('@excalidraw/excalidraw')
interface Scene { elements: readonly any[]; files: Record<string, any> }

/* ---------- storage: one localStorage entry per sketch, this browser only ---------- */
// ponytail: localStorage (~5 MB per origin); pasted images can fill it. Move to server-side files if that bites.
const KEY = (id: string) => `drawa:sketch:${project.root}:${id}`
const loadScene = (id: string): Scene => {
  try { return JSON.parse(localStorage.getItem(KEY(id)) ?? 'null') ?? { elements: [], files: {} } } catch { return { elements: [], files: {} } }
}
function saveScene(id: string, s: Scene) {
  try { localStorage.setItem(KEY(id), JSON.stringify(s)); return true } catch { return false }
}

let lib: Promise<Excalidraw> | undefined // React + Excalidraw: loaded on first sketch only
const excalidraw = () => (lib ??= (async () => {
  (window as any).EXCALIDRAW_ASSET_PATH = location.origin + '/excalidraw/' // fonts are self-hosted (see postinstall)
  await import('@excalidraw/excalidraw/index.css')
  return import('@excalidraw/excalidraw')
})())
const dark = isDark

/* ---------- the node on the canvas ---------- */
let count = 0
export function sketch(opts: { id?: string; title?: string; rect?: Rect; edit?: boolean } = {}) {
  const id = opts.id ?? uuid()
  const c = viewCenter()
  const { el: node, body } = makeWindow({
    kind: 'sketch', cls: 'snode', title: opts.title ?? `Whiteboard ${++count}`, minW: 220, minH: 160,
    rect: opts.rect ?? freeSpot({ x: c.x - 210, y: c.y - 150, w: 420, h: 300 }),
    actions: [
      iconButton(ICON.pencil, 'Edit whiteboard', () => edit(node)),
      iconButton(ICON.x, 'Delete whiteboard', async () => {
        if (!await confirmBox('Delete this whiteboard?', 'The drawing is removed from this browser and can\'t be recovered.', 'Delete whiteboard')) return
        discard(node)
      }),
    ],
  })
  node.dataset.id = id
  node.dataset.ink = 's:' + id
  body.classList.add('snode-b')
  body.append(inkBox('sf:' + id)) // drawing on the picture stays on the same spot at any size
  body.ondblclick = () => edit(node)
  preview(node)
  if (opts.edit) { centerOn(node); edit(node, !opts.id) }
  changed()
  return node
}

async function preview(node: HTMLElement) {
  const body = node.querySelector<HTMLElement>('.snode-b')!
  const scene = loadScene(node.dataset.id!)
  body.querySelector(':scope > .none')?.remove()
  if (!scene.elements.some(e => !e.isDeleted)) return body.prepend(make('p', 'none', 'Empty whiteboard. Double-click to draw.'))
  const { exportToSvg } = await excalidraw()
  const svg = await exportToSvg({
    elements: scene.elements as any,
    files: scene.files,
    appState: { exportBackground: false, exportWithDarkMode: dark() },
    exportPadding: 16,
  })
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  fitInk(body.querySelector<HTMLElement>(':scope > .ink-box')!, svg)
}

/** PNG (base64) of a sketch, for sending to Claude; null if it's empty. */
async function sketchPng(id: string): Promise<string | null> {
  const scene = loadScene(id)
  if (!scene.elements.some(e => !e.isDeleted)) return null
  const { exportToBlob } = await excalidraw()
  const blob = await exportToBlob({
    elements: scene.elements as any,
    files: scene.files,
    mimeType: 'image/png',
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
    exportPadding: 24,
  })
  return base64(blob)
}

onTheme(() => items('sketch').forEach(preview)) // previews are drawn in the theme's colors
persist('sketches',
  () => items('sketch').map(n => ({ id: n.dataset.id!, title: n.querySelector('.t')!.textContent ?? '', ...savedRect(n) })),
  (list: (Rect & { id: string; title: string })[]) => each(list, s => sketch({ id: s.id, title: s.title, rect: s })))
referable('sketch', {
  icon: '✎',
  name: 'whiteboard',
  content: async (el, label) => {
    const image = await sketchPng(el.dataset.id!)
    return image ? { text: `Whiteboard "${label}"`, image } : { text: `Whiteboard "${label}": (empty)` }
  },
})

/* ---------- the editor dialog ---------- */
const dialog = $<HTMLDialogElement>('#sketcher')
const host = dialog.querySelector<HTMLElement>('.host')!
const nameInput = dialog.querySelector<HTMLInputElement>('input')!
const status = dialog.querySelector<HTMLElement>('.status')!
// isNew: created by this editing session (Cancel, or Done with nothing drawn, removes it again)
let open: { node: HTMLElement; scene: Scene; original: string; isNew: boolean; unmount: () => void } | undefined
let timer = 0

async function edit(node: HTMLElement, isNew = false) {
  const id = node.dataset.id!
  const [{ Excalidraw }, React, { createRoot }] = await Promise.all([excalidraw(), import('react'), import('react-dom/client')])
  const scene = loadScene(id)
  nameInput.value = node.querySelector('.t')!.textContent ?? ''
  status.textContent = ''
  const root = createRoot(host)
  open = { node, scene, original: JSON.stringify(scene), isNew, unmount: () => root.unmount() }
  root.render(React.createElement(Excalidraw, {
    initialData: { elements: scene.elements as any, files: scene.files, scrollToContent: true },
    theme: dark() ? 'dark' : 'light',
    handleKeyboardGlobally: true, // modal dialog: tool keys work without clicking the drawing first
    onChange: (elements: readonly any[], _app: unknown, files: Record<string, any>) => {
      if (!open) return
      open.scene = { elements, files }
      clearTimeout(timer)
      timer = setTimeout(() => { status.textContent = saveScene(id, open!.scene) ? 'Saved' : 'Not saved: browser storage is full' }, 300)
    },
  }))
  dialog.showModal()
  nameInput.blur() // showModal focuses the name field; tool keys (R, O, A...) should go to the drawing
}

removable('sketch', node => discard(node)) // its × asks first; a deleted selection has already asked
function discard(node: HTMLElement) {
  try { localStorage.removeItem(KEY(node.dataset.id!)) } catch {}
  forget(node)
  node.remove()
  changed()
}

function close(keep: boolean) {
  if (!open) return
  clearTimeout(timer)
  const { node, scene, original, isNew, unmount } = open
  open = undefined
  unmount()
  dialog.close()
  const empty = !scene.elements.some(e => !e.isDeleted)
  if (isNew && (!keep || empty)) return discard(node) // nothing to keep: no leftover empty sketch
  saveScene(node.dataset.id!, keep ? scene : JSON.parse(original)) // Cancel: back to how it was before this edit
  if (!keep) return preview(node)
  node.querySelector('.t')!.textContent = nameInput.value.trim() || 'Whiteboard'
  preview(node)
  changed()
}

dialog.querySelector<HTMLButtonElement>('.done')!.onclick = () => close(true)
dialog.querySelector<HTMLButtonElement>('.cancel')!.onclick = () => close(false)
dialog.addEventListener('cancel', e => e.preventDefault()) // Esc belongs to Excalidraw (deselect, exit tool); close with Done
