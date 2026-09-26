// Selecting several canvas items at once: double-tap and drag on empty canvas (or Shift+drag) draws a selection
// box; Shift/Ctrl+click an item's tab adds or removes it. Dragging a selected item moves them all; Delete (or the
// bar by the selection) removes them, each through its own remove path. Only items laid out on the canvas take part:
// pinned, floating and full-view windows don't.
import { make, ICON, button, iconButton, confirmBox, shortcutOk, EDITABLE, keepOnScreen } from '../lib/dom'
import { stage, placed, onCanvas, rect, place, toWorld, view, onChange, setGroup, setMoveAlong, changed, swallowNext, hits, track, type Rect, type Mover } from './canvas'
import { redraw } from './graph'
import { drawing, remove, type Stroke } from './ink'
import { canvasStrokes, strokeRect, markStroke, strokeMover } from './inksel'
import { handDrag } from './mode'

const sel = new Set<HTMLElement>()
const removers = new Map<string, (el: HTMLElement) => void>(), notes = new Map<string, string>()
/** How items of this kind are removed when a selection is deleted, without asking again (the selection asks once).
 *  Kinds that don't register are removed by clicking their own × button; kinds with neither are left alone.
 *  `fn` null: its × still does it. `note`: a line the delete confirmation adds when the selection has this kind
 *  (what removing it really means, e.g. a session's conversation stays in History). */
export const removable = (kind: string, fn: ((el: HTMLElement) => void) | null, note?: string) => {
  if (fn) removers.set(kind, fn)
  if (note) notes.set(kind, note)
}

/** The item's own × (every kind's close/remove button carries .closebtn). */
const closeButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(':scope > .win-h .closebtn, :scope > .closebtn')
const canRemove = (el: HTMLElement) => removers.has(el.dataset.kind!) || !!closeButton(el)

// drawings on the canvas itself (shapes, text, pen strokes) join the selection too; ink on a window moves with it
const inkSel = new Set<Stroke>()
function setInk(s: Stroke, on: boolean) { if (on) inkSel.add(s); else inkSel.delete(s); markStroke(s, on) }
export const selected = () => [...sel]
export const selectedInk = () => [...inkSel]
/** Is this drawing in the selection? (canvas/shapes.ts drags the whole selection when you drag one.) */
export const inkSelected = (s: Stroke) => inkSel.has(s)
/** Click on a drawing (shape or text): select just it, or with `add` (Shift) add it to the selection. */
export function selectInk(s: Stroke, add = false) {
  if (!add) clearSelection()
  setInk(s, true)
  sync()
}
const watchers: (() => void)[] = []
/** Called whenever the selection changes (canvas/shapes.ts frames a single selected shape with its handles). */
export const onSelect = (f: () => void) => watchers.push(f)
/** Move everything selected together, windows and drawings, by a total offset in canvas units; `end()` when done. */
export function selectionMover(): Mover {
  const els = [...sel], starts = els.map(rect), ink = strokeMover([...inkSel])
  const move = (dx: number, dy: number) => { els.forEach((el, i) => place(el, starts[i].x + dx, starts[i].y + dy)); ink(dx, dy); if (els.length) redraw() }
  return Object.assign(move, { end: () => { ink.end(); changed() } })
}
/** Select every item laid out on the canvas (Ctrl/Cmd+A). */
function selectAll() { for (const el of placed()) set(el, true); for (const s of canvasStrokes()) setInk(s, true); sync() }
function set(el: HTMLElement, on: boolean) {
  if (on) sel.add(el); else sel.delete(el)
  el.classList.toggle('selected', on)
}
function clearSelection() { for (const el of [...sel]) set(el, false); for (const s of [...inkSel]) setInk(s, false); sync() }

setGroup(el => (sel.has(el) ? [...sel] : [el]))
setMoveAlong(el => (sel.has(el) && inkSel.size ? strokeMover([...inkSel]) : null))

/* ---------- the bar by the selection: how many, delete, clear ---------- */
const count = make('span', 'n')
const bar = document.body.appendChild(make('div', 'selbar float'))
bar.setAttribute('role', 'toolbar')
bar.setAttribute('aria-label', 'Selected items')
bar.append(count, button('Delete', '', () => { removeSelected() }), iconButton(ICON.x, 'Clear selection (Esc)', clearSelection))
bar.hidden = true

function sync() {
  for (const el of [...sel]) if (!el.isConnected || !onCanvas(el)) set(el, false) // removed, pinned or in full view
  for (const s of [...inkSel]) if (!s.el?.isConnected) setInk(s, false) // erased or undone
  watchers.forEach(f => f())
  const n = sel.size + inkSel.size
  bar.hidden = !n
  if (!n) return
  count.textContent = `${n} selected`
  // above the selection's top-left (on screen), kept on screen; a drawing on a window is measured where it shows
  const screen = (r: Rect) => ({ x: r.x * view.k + view.x, y: r.y * view.k + view.y })
  const ps = [...[...sel].map(el => screen(rect(el))), ...[...inkSel].map(s => (s.host ? s.el!.getBoundingClientRect() : screen(strokeRect(s))))]
  keepOnScreen(bar, Math.min(...ps.map(p => p.x)), Math.min(...ps.map(p => p.y)) - bar.offsetHeight - 10, 64) // not over the toolbar
}
onChange(sync)

const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`

async function removeSelected() {
  const all = [...sel], gone = all.filter(canRemove), kept = all.length - gone.length, ink = [...inkSel]
  if (!gone.length && !ink.length) return
  const drop = () => { ink.forEach(s => setInk(s, false)); remove(...ink) }
  if (!gone.length) { // drawings only: one goes like the eraser; more ask first (undo can't bring them back)
    if (ink.length === 1 || await confirmBox(`Delete ${ink.length} drawings?`, "Undo can't bring them back.", 'Delete')) drop()
    sync()
    return
  }
  const said = [...new Set(gone.map(el => notes.get(el.dataset.kind!)).filter(Boolean))].join(' ')
  const left = kept ? `${plural(kept)} can't be removed this way and stay${kept === 1 ? 's' : ''}.` : ''
  if (!await confirmBox(`Delete ${plural(gone.length + ink.length)}?`, `${said} ${left}`.trim() || 'They are removed from the canvas.', 'Delete')) return
  drop()
  for (const el of gone) {
    set(el, false)
    const fn = removers.get(el.dataset.kind!)
    if (fn) fn(el); else closeButton(el)?.click()
  }
  sync()
  changed()
}

/* ---------- picking: Shift/Ctrl+click an item's tab (or a bare node like a note) ---------- */
document.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !(e.shiftKey || e.ctrlKey || e.metaKey) || drawing) return
  const t = e.target as Element, el = t.closest<HTMLElement>('#world > .item')
  if (!el || t.closest(`button, a, ${EDITABLE}`)) return
  if (el.classList.contains('win') && !t.closest('.win-h')) return // inside a window's body: its own clicks
  e.preventDefault()
  e.stopPropagation() // not a drag
  set(el, !sel.has(el))
  sync()
}, true)

/* ---------- the selection box: drag on empty canvas in Select mode; in Hand mode double-tap and drag (or Shift+drag) ---------- */
const box = stage.appendChild(make('div', 'marquee'))
box.hidden = true
const empty = (t: Element) => t === stage || t.matches('#world, #edges, #inkworld')
let last = { t: 0, x: 0, y: 0 }

stage.addEventListener('pointerdown', e => {
  const t = e.target as Element
  if (e.button !== 0 || drawing || !empty(t)) return
  const again = e.timeStamp - last.t < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 24
  last = { t: e.timeStamp, x: e.clientX, y: e.clientY }
  if (!again && !e.shiftKey && handDrag()) {
    // Hand mode (or Space held): a plain press pans; if it's a click (no drag), it clears the selection
    const up = (ev: PointerEvent) => { if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) clearSelection() }
    addEventListener('pointerup', up, { once: true })
    return
  }
  e.stopImmediatePropagation() // not a pan
  e.preventDefault() // and not a text selection: selected note text would turn the next drag into the browser's own
  getSelection()?.removeAllRanges()
  const start = toWorld(e.clientX, e.clientY), before = e.shiftKey ? new Set(sel) : new Set<HTMLElement>()
  const inkBefore = e.shiftKey ? new Set(inkSel) : new Set<Stroke>()
  const candidates = placed().map(el => ({ el, r: rect(el) })), drawings = canvasStrokes()
  let moved = false
  track(stage, e, (_x, _y, ev) => {
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
    moved = true
    const x0 = Math.min(e.clientX, ev.clientX), y0 = Math.min(e.clientY, ev.clientY)
    box.hidden = false
    box.style.cssText = `left:${x0}px;top:${y0}px;width:${Math.abs(ev.clientX - e.clientX)}px;height:${Math.abs(ev.clientY - e.clientY)}px`
    const p = toWorld(ev.clientX, ev.clientY)
    const m: Rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }
    let changes = 0
    for (const { el, r } of candidates) {
      const on = before.has(el) || hits(r, m, 0)
      if (on !== sel.has(el)) { set(el, on); changes++ } // only what crossed the box's edge
    }
    const inBox = new Set(canvasStrokes(m, drawings))
    for (const s of new Set([...inkSel, ...inBox])) {
      const on = inkBefore.has(s) || inBox.has(s)
      if (on !== inkSel.has(s)) { setInk(s, on); changes++ }
    }
    if (changes) sync()
  }, () => {
    box.hidden = true
    if (!moved) { if (!again && !e.shiftKey) clearSelection(); return } // a click clears; a double-click still makes a note
    swallowNext('dblclick', 400) // a double-tap-drag's own dblclick mustn't make a note
  })
}, true)

const NUDGE: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
addEventListener('keydown', e => {
  if (e.defaultPrevented || e.altKey || drawing) return
  if (!shortcutOk(e)) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return }
  if ((!sel.size && !inkSel.size) || e.ctrlKey || e.metaKey) return
  if (e.key === 'Escape') clearSelection()
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected() }
  else if (NUDGE[e.key]) { // arrow keys nudge the selection (Shift: 10px), like Excalidraw
    e.preventDefault()
    const [dx, dy] = NUDGE[e.key], step = e.shiftKey ? 10 : 1
    const m = selectionMover()
    m(dx * step, dy * step)
    m.end()
  }
})
