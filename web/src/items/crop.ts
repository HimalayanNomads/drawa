// Crop mode for a picture window, like a photo editor's: a box starts around the whole picture; drag its corners or
// edges to trim, inside it to move it, outside it to draw a new one. The tab gets a ratio button (Free, 1:1, 4:3,
// 16:9, Original), ✓ and ✕. Enter or a double-click inside applies, Esc cancels. It only picks the area;
// items/image.ts cuts and stores it.
import { make, button, iconButton, typing, ICON } from '../lib/dom'
import { track } from '../canvas/canvas'
import { onForget } from '../canvas/graph'
import { setDrawing } from '../canvas/ink'

/** An area of the picture in its pixels. */
export interface Area { x: number; y: number; w: number; h: number }
type Box = Area // the same, in fractions (0–1) of the picture: it stays put at any zoom or window size

/** A box in fractions of a `nw`×`nh` picture as whole pixels of it. */
export function toPixels(b: Box, nw: number, nh: number): Area {
  const x = Math.round(b.x * nw), y = Math.round(b.y * nh)
  return { x, y, w: Math.min(nw - x, Math.round(b.w * nw)), h: Math.min(nh - y, Math.round(b.h * nh)) }
}

const RATIOS: [string, number][] = [['Free', 0], ['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9], ['Original', -1]]
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const MIN = 24 // screen px: the box never gets smaller than this each way
// windows being cropped, and how to cancel each: one removed meanwhile (its ×, a delete, Claude's tools) cancels at once
const open = new Map<HTMLElement, (ok: boolean) => void>()
onForget(el => open.get(el)?.(false))
const inside = (b: Box) => b.x >= -1e-9 && b.y >= -1e-9 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9

/** The biggest box of width/height ratio `fr` (in fractions) centred in `b`. */
function fitRatio(b: Box, fr: number): Box {
  const w = Math.min(b.w, b.h * fr), h = w / fr
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h }
}

/** `start` dragged by (dx, dy) fractions at handle `h` ('move' for the whole box), at most `min` small, keeping width
 *  over height at `fr` when set (the opposite side or corner stays put). Null when that would leave the picture. */
export function dragBox(start: Box, h: string, dx: number, dy: number, min: { w: number; h: number }, fr = 0): Box | null {
  if (h === 'move') {
    return { ...start, x: Math.min(1 - start.w, Math.max(0, start.x + dx)), y: Math.min(1 - start.h, Math.max(0, start.y + dy)) }
  }
  let { x, y, w, h: ht } = start
  const right = x + w, bottom = y + ht
  if (h.includes('w')) { x = Math.min(right - min.w, Math.max(0, x + dx)); w = right - x }
  if (h.includes('e')) w = Math.min(1 - x, Math.max(min.w, w + dx))
  if (h.includes('n')) { y = Math.min(bottom - min.h, Math.max(0, y + dy)); ht = bottom - y }
  if (h.includes('s')) ht = Math.min(1 - y, Math.max(min.h, ht + dy))
  if (fr) {
    const sideways = /[ew]/.test(h)
    if (sideways) ht = w / fr; else w = ht * fr
    if (h.includes('n')) y = bottom - ht; else if (!h.includes('s')) y = start.y + (start.h - ht) / 2
    if (h.includes('w')) x = right - w; else if (!h.includes('e')) x = start.x + (start.w - w) / 2
    if (w < min.w - 1e-9 || ht < min.h - 1e-9) return null
  }
  const b = { x, y, w, h: ht }
  return inside(b) ? b : null
}

/** A new box dragged from (sx, sy) to (ex, ey), in fractions, keeping width over height at `fr` when set (the press
 *  point stays put and the box stops at the picture's edges). Null while it's still smaller than `min`. */
export function drawBox(sx: number, sy: number, ex: number, ey: number, min: { w: number; h: number }, fr = 0): Box | null {
  const dx = Math.sign(ex - sx) || 1, dy = Math.sign(ey - sy) || 1
  const room = { w: dx > 0 ? 1 - sx : sx, h: dy > 0 ? 1 - sy : sy } // from the press point to the edges it's heading for
  let w = Math.min(Math.abs(ex - sx), room.w), h = Math.min(Math.abs(ey - sy), room.h)
  if (fr) {
    w = Math.max(w, h * fr)
    h = w / fr
    const k = Math.min(1, room.w / w, room.h / h)
    w *= k
    h *= k
  }
  if (w < min.w || h < min.h) return null
  return { x: dx > 0 ? sx : sx - w, y: dy > 0 ? sy : sy - h, w, h }
}

/** Let the user pick part of `img` (shown in its ink box `box`): that part in the picture's pixels, or null. */
export function cropArea(box: HTMLElement, img: HTMLImageElement): Promise<Area | null> {
  setDrawing(false) // the drawing surface lies over everything and would take the presses
  const win = box.closest<HTMLElement>('.win')!, head = win.querySelector<HTMLElement>(':scope > .win-h')!, was = win.dataset.state
  win.dataset.state = 'crop'
  const nw = img.naturalWidth, nh = img.naturalHeight
  const layer = make('div', 'crop'), frame = make('div', 'crop-box'), tools = make('span', 'crop-tools')
  for (const h of HANDLES) frame.appendChild(make('i', 'crop-h')).dataset.h = h
  layer.append(frame)
  let b: Box = { x: 0, y: 0, w: 1, h: 1 }, ratio = 0
  const fr = () => { const r = RATIOS[ratio][1]; return r < 0 ? 1 : r ? r * nh / nw : 0 } // wanted w/h in fractions
  const show = () => Object.assign(frame.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` })
  show()
  return new Promise(done => {
    let over = false
    const finish = (ok: boolean) => {
      if (over) return
      over = true
      open.delete(win)
      layer.remove()
      tools.remove()
      document.removeEventListener('keydown', key, true)
      if (was === undefined) delete win.dataset.state
      else win.dataset.state = was
      const a = toPixels(b, nw, nh), whole = a.x === 0 && a.y === 0 && a.w === nw && a.h === nh
      done(ok && !whole && a.w > 0 && a.h > 0 ? a : null) // the whole picture: nothing to crop
    }
    const key = (e: KeyboardEvent) => {
      if ((e.key !== 'Enter' && e.key !== 'Escape') || typing(e.target)) return
      if (e.key === 'Enter' && (e.target as Element).closest?.('.crop-tools button')) return // Enter presses the focused ratio, ✓ or ✕
      e.preventDefault() // full view's Esc skips handled keys
      e.stopPropagation()
      finish(e.key === 'Enter')
    }
    layer.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      const t = e.target as HTMLElement, h = t.dataset.h ?? (t === frame ? 'move' : 'draw') // outside the box: a new one
      const r = layer.getBoundingClientRect(), start = b, min = { w: MIN / r.width, h: MIN / r.height }
      const sx = (e.clientX - r.left) / r.width, sy = (e.clientY - r.top) / r.height
      track(layer, e, (dx, dy) => {
        b = (h === 'draw' ? drawBox(sx, sy, sx + dx / r.width, sy + dy / r.height, min, fr()) : dragBox(start, h, dx / r.width, dy / r.height, min, fr())) ?? b
        show()
      })
    })
    layer.addEventListener('dblclick', e => { // (on the layer: a press there captures the pointer, so the box never gets it)
      e.stopPropagation()
      const f = frame.getBoundingClientRect()
      if (e.clientX >= f.left && e.clientX <= f.right && e.clientY >= f.top && e.clientY <= f.bottom) finish(true)
    })
    const shape = button(RATIOS[0][0], 'crop-ratio', () => {
      ratio = (ratio + 1) % RATIOS.length
      shape.textContent = RATIOS[ratio][0]
      if (fr()) b = fitRatio(b, fr())
      show()
    })
    shape.title = 'Aspect ratio'
    tools.append(shape, iconButton(ICON.check, 'Crop (Enter)', () => finish(true)), iconButton(ICON.x, 'Cancel (Esc)', () => finish(false)))
    head.insertBefore(tools, head.querySelector(':scope > .crop-btn'))
    box.append(layer)
    open.set(win, finish)
    document.addEventListener('keydown', key, true)
  })
}
