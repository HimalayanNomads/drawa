// Drawings in groups (issue #71): canvas-level strokes (pen, shapes, text; not ink on a window) belong to a group the
// way elements belong to an Excalidraw frame: drawn or dropped with their centre in its open frame, or grouped with
// Ctrl+G. They move with it, hide while it's collapsed and are wrapped by its frame; dragged out of it, they leave.
// The group keeps their ids in data-strokes; a stroke gets an id the first time it joins. items/group.ts and
// groupselect.ts use these helpers; the handler at the end takes in what lands in a frame.
import { uuid } from '../lib/dom'
import { strokes, onInkPlaced, type Stroke } from '../canvas/ink'
import { strokeRect } from '../canvas/inksel'
import { changed, onCanvas, type Rect } from '../canvas/canvas'
import { groups, styleRect, inside, flash, empty, ungroup } from './group'

export const inkIds = (g: HTMLElement): string[] => JSON.parse(g.dataset.strokes || '[]')
export function setInkIds(g: HTMLElement, list: string[]) {
  if (list.length) g.dataset.strokes = JSON.stringify(list)
  else delete g.dataset.strokes
}
/** A group's drawings that exist now. ponytail: an erased stroke's id stays in the list (nothing resolves it), and a
 *  group of drawings only keeps its empty frame once they're all erased; prune on erase if that ever matters. */
export function groupInk(g: HTMLElement) {
  const want = new Set(inkIds(g))
  return want.size ? strokes.filter(s => s.id && want.has(s.id)) : []
}
/** The group a drawing is in, out of `gs`. */
export const inkGroupOf = (s: Stroke, gs: HTMLElement[]) => (s.id ? gs.find(g => inkIds(g).includes(s.id!)) : undefined)
/** Only drawings on the canvas itself can join: ink on a window already goes wherever its window goes. */
export const groupableInk = (s: Stroke) => !s.host

/** Put drawings in `g`, out of whichever of `gs` held them (a drawing is in at most one group). */
export function joinInk(list: Stroke[], g: HTMLElement, gs: HTMLElement[]) {
  const add = list.filter(groupableInk).map(s => (s.id ??= uuid()))
  for (const other of gs) if (other !== g) leaveInk(other, add)
  setInkIds(g, [...new Set([...inkIds(g), ...add])])
}
export const leaveInk = (g: HTMLElement, ids: string[]) => setInkIds(g, inkIds(g).filter(id => !ids.includes(id)))

/** A collapsed group's drawings: out of sight and out of the selection (canvasStrokes skips them). Run on every change,
 *  since a stroke repainted or restored later needs it too. */
export function hideInk(g: HTMLElement, on: boolean) {
  for (const s of groupInk(g)) {
    if (!s.el || !!s.el.dataset.hiddenIn === on) continue
    if (on) s.el.dataset.hiddenIn = g.dataset.id!
    else delete s.el.dataset.hiddenIn
  }
}
/** Where a group's drawings are, for its frame to wrap them. */
export const inkRects = (g: HTMLElement): Rect[] => groupInk(g).map(strokeRect)
/** A drawing's centre, where it counts as being. */
export function inkCentre(s: Stroke) {
  const r = strokeRect(s)
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

// a drawing lands (drawn, written, dragged): it joins the open frame its centre is in, and leaves its group once it's
// out of that group's frame, like an Excalidraw frame. A collapsed group neither takes nor loses any.
onInkPlaced(list => {
  const gs = groups(), open = gs.filter(g => onCanvas(g) && !g.classList.contains('min'))
  let any = false
  for (const s of list.filter(groupableInk)) {
    const c = inkCentre(s), from = inkGroupOf(s, gs), into = open.find(g => inside(styleRect(g), c.x, c.y))
    if (into === from || from?.classList.contains('min')) continue
    if (into) { joinInk([s], into, gs); flash(into) }
    else leaveInk(from!, [s.id!])
    if (from && empty(from)) ungroup(from)
    any = true
  }
  if (any) changed() // frames fit what they hold now
})
