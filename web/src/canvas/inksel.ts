// Questions about the drawing, and handles on it: which strokes overlap an area (snapshots, what Claude reads,
// the selection box), drawn objects under the pointer, and moving strokes with the canvas selection.
import { view, type Mover } from './canvas'
import { strokes, fits, FIT, unitsPerHostPx, paint, type Stroke } from './ink'
import { SHAPE_NAME } from './shapegeom'

export type Box = { x: number; y: number; w: number; h: number }
/** A stroke's bounding box (x0, y0, x1, y1), measured once after it changes. */
function bbox(s: Stroke) {
  if (s.bb) return s.bb
  if (s.t != null) { // text: about 0.6em per character, 1.25em per line
    const lines = s.t.split('\n'), [x, y] = s.p[0]
    return (s.bb = [x, y, x + s.s * 0.6 * Math.max(...lines.map(l => l.length)), y + s.s * 1.25 * lines.length])
  }
  const xs = s.p.map(q => q[0]), ys = s.p.map(q => q[1]), m = s.s
  return (s.bb = [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m])
}
/** Does a canvas-level stroke overlap `r`? Its box first; then a point really inside (a long diagonal line's box
 *  covers far more than the line). */
const over = (s: Stroke, r: Box) => {
  const [x0, y0, x1, y1] = bbox(s)
  if (x1 < r.x || x0 > r.x + r.w || y1 < r.y || y0 > r.y + r.h) return false
  return s.t != null || !!s.sh || s.p.some(([x, y]) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
}

/** Canvas-level strokes overlapping a world-space rectangle, as SVG path data + color (for snapshots). */
export function strokesIn(r: Box) {
  return strokes.filter(s => !s.host && over(s, r)).map(s => {
    const line = s.sh ? s.el?.querySelector('.ink-line') : s.el
    return { d: line?.getAttribute('d') ?? '', area: s.el?.querySelector('.ink-fill')?.getAttribute('d') ?? '',
      color: s.el ? getComputedStyle(s.el).fill : '#000', text: s.t, at: s.p[0], size: s.s }
  })
}
/** Is anything drawn on or over this window (canvas_list's drawnOn)? Cheaper than strokesIn: stops at the first. */
export const inkOn = (el: HTMLElement, r: Box) => strokes.some(s => (s.host ? el.contains(s.host) : over(s, r)))

/** The shapes drawn on a window or over its area, for Claude to read as text: kind, and where. */
export function shapesOn(el: HTMLElement, r: Box) {
  return strokes.filter(s => s.sh && (s.host ? el.contains(s.host) : over(s, r))).map(s => {
    const [x0, y0, x1, y1] = bbox(s), pct = (v: number, a: number, len: number) => Math.round(((v - a) / len) * 100)
    const name = (s.sh === 'ellipse' ? 'an ' : 'a ') + SHAPE_NAME[s.sh!] + (s.f ? ' (filled)' : '')
    if (s.k) return `${name} over the message "${s.k}"`
    if (s.host) { // host units: FIT across for pictures and diagrams, pixels otherwise
      const w = fits(s.host) ? FIT : s.host.offsetWidth, h = fits(s.host) ? (FIT * s.host.offsetHeight) / s.host.offsetWidth : s.host.offsetHeight
      return `${name} at ${pct(x0, 0, w)}–${pct(x1, 0, w)}% across, ${pct(y0, 0, h)}–${pct(y1, 0, h)}% down`
    }
    return `${name} at ${pct(x0, r.x, r.w)}–${pct(x1, r.x, r.w)}% across, ${pct(y0, r.y, r.h)}–${pct(y1, r.y, r.h)}% down this window`
  })
}

/** What the user wrote (Text tool) on a window or over its area, for Claude to read as text. */
export function textsOn(el: HTMLElement, r: Box) {
  return strokes.filter(s => s.t && (s.host ? el.contains(s.host) : over(s, r))).map(s => s.t!)
}

/* ---------- for moving drawn objects (canvas/shapes.ts) ---------- */
/** The shape or Text-tool text this element belongs to (pen strokes aren't objects). */
export const objectAt = (t: Element) => strokes.find(s => (s.sh || s.t != null) && s.el && (s.el === t || s.el.contains(t))) ?? null
/** Stored units per screen pixel for this stroke's host (the canvas, a window, or a picture scaled to fit). */
export function unitsPerPx(s: Stroke) {
  if (!s.host) return 1 / view.k
  const k = s.host.getBoundingClientRect().width / s.host.offsetWidth
  return unitsPerHostPx(s.host) / k
}

/* ---------- for the canvas selection (canvas/select.ts): drawings on the canvas itself ---------- */
/** Canvas-level strokes, shapes and text overlapping a world-space box (all of them without one); `from`: only
 *  among these (a selection box takes the list once, then narrows it each frame). */
export const canvasStrokes = (r?: Box, from = strokes) => from.filter(s => !s.host && s.el && (!r || over(s, r)))
/** Its box in canvas units: x, y, w, h. */
export const strokeRect = (s: Stroke): Box => { const [x0, y0, x1, y1] = bbox(s); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
export const markStroke = (s: Stroke, on: boolean) => { s.sel = on; s.el?.classList.toggle('ink-sel', on) }
/** A mover for these strokes, given the total offset from where they are now in canvas units (a stroke on a window
 *  converts it to its window's units). While moving it only shifts their elements (a transform: no re-tracing of
 *  hundreds of pen outlines per frame); `end()` writes the new points and repaints once. */
export function strokeMover(list: Stroke[]): Mover {
  const f = list.map(s => view.k * unitsPerPx(s)), base = list.map(s => s.el?.getAttribute('transform') ?? '')
  let dx = 0, dy = 0
  const move = (x: number, y: number) => {
    dx = x; dy = y
    list.forEach((s, i) => s.el?.setAttribute('transform', `${base[i]} translate(${x * f[i]} ${y * f[i]})`.trim()))
  }
  return Object.assign(move, { end: () => list.forEach((s, i) => {
    if (base[i]) s.el?.setAttribute('transform', base[i]); else s.el?.removeAttribute('transform')
    if (!dx && !dy) return
    s.p = s.p.map(([x, y, ...r]) => [x + dx * f[i], y + dy * f[i], ...r])
    paint(s)
  }) })
}
