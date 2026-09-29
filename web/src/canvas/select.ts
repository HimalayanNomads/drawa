// Selecting several canvas items at once: double-tap and drag on empty canvas (or Shift+drag) draws a selection
// box; Shift/Ctrl+click an item's tab adds or removes it. Dragging a selected item moves them all; Delete (or the
// bar by the selection) removes them, each through its own remove path. Only items laid out on the canvas take part:
// pinned, floating and full-view windows don't.
import { make, ICON, button, iconButton, confirmBox, shortcutOk, EDITABLE, keepOnScreen } from '../lib/dom'
import { command } from '../lib/keys'
import { stage, placed, onCanvas, hidden, rect, place, toWorld, view, onChange, moveWith, movesWith, setMoveAlong, changed, swallowNext, hits, track, type Rect, type Mover } from './canvas'
import { redraw } from './graph'
import { drawing, type Stroke } from './ink'
import { erase } from './inkundo'
import { canvasStrokes, strokeRect, markStroke, strokeMover, inkWith, inkOf, siblings, objectAt } from './inksel'
import { handDrag } from './mode'
import { anyFull } from './fullview'

const sel = new Set<HTMLElement>()
let picks = 0 // bumped on every selection change, windows or drawings (the bar's Group depends on both)
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
/** Remove one item the way a selection delete does, without asking (items/group.ts deletes a group's windows). */
export function removeItem(el: HTMLElement) {
  set(el, false)
  const fn = removers.get(el.dataset.kind!)
  if (fn) fn(el); else closeButton(el)?.click()
}

// drawings on the canvas itself (shapes, text, pen strokes) join the selection too; ink on a window moves with it
const inkSel = new Set<Stroke>()
// the frameless group double-clicked into (Excalidraw's way to pick one drawing of a group): until the selection
// is cleared, its drawings are picked one by one
let inside: string | undefined
const whole = (s: Stroke) => (s.g && s.g !== inside ? siblings(s) : [s]) // a group comes whole, unless we're inside it
function setInk(s: Stroke, on: boolean) {
  for (const o of whole(s)) { if (on) inkSel.add(o); else inkSel.delete(o); markStroke(o, on) }
  picks++
}
export const selected = () => [...sel]
export const selectedInk = () => [...inkSel]
/** Is this drawing in the selection? (canvas/shapes.ts drags the whole selection when you drag one.) */
export const inkSelected = (s: Stroke) => inkSel.has(s)
/** Click on a drawing (shape or text): select just it, or with `add` (Shift) add it to the selection. */
export function selectInk(s: Stroke, add = false) {
  const stay = !!s.g && s.g === inside // another drawing of the group we're in: still inside
  if (!add) clearSelection()
  if (stay) inside = s.g
  setInk(s, true)
  sync()
}
const watchers: (() => void)[] = []
/** Called whenever the selection changes (canvas/shapes.ts frames a single selected shape with its handles). */
export const onSelect = (f: () => void) => watchers.push(f)
/** Move everything selected together, windows and drawings, by a total offset in canvas units; `end()` when done.
 *  Whatever moves with a selected item comes too (a group's windows). */
export function selectionMover(): Mover {
  const els = [...new Set([...sel].filter(el => !el.dataset.locked).flatMap(movesWith))], starts = els.map(rect), ink = strokeMover([...new Set([...inkSel, ...inkOf(els)])], !els.length) // with windows: no undo step (moving windows has none)
  const move = (dx: number, dy: number) => { els.forEach((el, i) => place(el, starts[i].x + dx, starts[i].y + dy)); ink(dx, dy); if (els.length) redraw() }
  // a move like a drag's: 'moved' on each, so what reacts to drags (groups pushing each other aside) reacts to this too
  return Object.assign(move, { end: () => { ink.end(); changed(); els.forEach(el => el.dispatchEvent(new CustomEvent('moved', { bubbles: true }))) } })
}
/** Select every item laid out on the canvas (Ctrl/Cmd+A). */
function selectAll() { for (const el of placed()) set(el, true); for (const s of canvasStrokes()) setInk(s, true); sync() }
function set(el: HTMLElement, on: boolean) {
  if (on) sel.add(el); else sel.delete(el)
  picks++
  el.classList.toggle('selected', on)
}
export function clearSelection() {
  for (const el of [...sel]) set(el, false)
  for (const s of [...inkSel]) setInk(s, false)
  inside = undefined
  sync()
}
/** Make `el` the whole selection (W steps through windows, so Delete, the arrows and Ctrl+G act on the one it lands on). */
export function selectOnly(el: HTMLElement) { clearSelection(); set(el, true); sync() }
// double-click a grouped drawing: into its group, with just that drawing selected
document.addEventListener('dblclick', e => {
  const s = objectAt(e.target as Element)
  if (!s?.g) return
  e.stopPropagation()
  clearSelection()
  inside = s.g
  setInk(s, true)
  sync()
}, true)

moveWith(el => (sel.has(el) ? [...sel] : []))
inkWith(el => (sel.has(el) ? [...inkSel] : []))
// drawings carried by a dragged window or group: no undo step of their own, or Ctrl+Z would move them out from under it
setMoveAlong(el => { const ink = inkOf(movesWith(el)); return ink.length ? strokeMover(ink, false) : null })

/* ---------- the bar by the selection: how many, delete, clear ---------- */
const count = make('span', 'n')
const bar = document.body.appendChild(make('div', 'selbar float'))
bar.setAttribute('role', 'toolbar')
bar.setAttribute('aria-label', 'Selected items')
const del = button('Delete', '', () => { removeSelected() })
bar.append(count, del, iconButton(ICON.x, 'Clear selection (Esc)', clearSelection))
bar.hidden = true
const actions: { b: HTMLButtonElement; when: (els: HTMLElement[]) => boolean }[] = []
let shownFor = -1 // the selection the actions were last shown for (its `picks`)
/** A button on the bar by the selection, before Delete (items/group.ts: Group, Ungroup). `when`: shown only for
 *  selections it applies to. */
export function selectionAction(label: string, tip: string, fn: () => void, when: (els: HTMLElement[]) => boolean = () => true) {
  const b = button(label, '', fn)
  b.title = tip
  bar.insertBefore(b, del)
  actions.push({ b, when })
}

// the box round a selection of two or more (like a drawing app's group selection): screen px, so its line stays
// crisp at any zoom; moved with the selection bar on every change
const selbox = stage.appendChild(make('div', 'selbox'))
selbox.hidden = true

/** Show the bar's actions again for the same selection whose meaning changed (its drawings were just grouped). */
export function refreshActions() { picks++; sync() }
function sync() {
  for (const el of [...sel]) if (!el.isConnected || !onCanvas(el) || hidden(el)) set(el, false) // removed, pinned, in full view, in a collapsed group
  for (const s of [...inkSel]) if (!s.el?.isConnected) setInk(s, false) // erased or undone
  watchers.forEach(f => f())
  const n = sel.size + inkSel.size
  bar.hidden = !n
  selbox.hidden = n < 2
  if (!n) return
  count.textContent = `${n} selected`
  if (picks !== shownFor) { shownFor = picks; for (const a of actions) a.b.hidden = !a.when([...sel]) } // not on every pan frame
  // above the selection's top-left (on screen), kept on screen; a drawing on a window is measured where it shows
  const screen = (r: Rect) => ({ x: r.x * view.k + view.x, y: r.y * view.k + view.y, w: r.w * view.k, h: r.h * view.k })
  const rs = [...[...sel].map(el => screen(rect(el))), ...[...inkSel].map(s => {
    if (!s.host) return screen(strokeRect(s))
    const b = s.el!.getBoundingClientRect()
    return { x: b.left, y: b.top, w: b.width, h: b.height }
  })]
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y))
  if (n > 1) {
    const x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h)), m = 6
    selbox.style.cssText = `left:${x0 - m}px;top:${y0 - m}px;width:${x1 - x0 + 2 * m}px;height:${y1 - y0 + 2 * m}px`
  }
  keepOnScreen(bar, x0, y0 - bar.offsetHeight - 10, 64) // not over the toolbar
}
onChange(sync)

const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`

async function removeSelected() {
  const all = [...sel], gone = all.filter(canRemove), kept = all.length - gone.length, ink = [...inkSel]
  if (!gone.length && !ink.length) return
  const drop = () => { ink.forEach(s => setInk(s, false)); erase(...ink) }
  if (!gone.length) { // drawings only: one goes like the eraser; more ask first
    if (ink.length === 1 || await confirmBox(`Delete ${ink.length} drawings?`, 'Undo in Draw mode (Ctrl+Z) brings them back.', 'Delete')) drop()
    sync()
    return
  }
  const said = [...new Set(gone.map(el => notes.get(el.dataset.kind!)).filter(Boolean))].join(' ')
  const left = kept ? `${plural(kept)} can't be removed this way and stay${kept === 1 ? 's' : ''}.` : ''
  if (!await confirmBox(`Delete ${plural(gone.length + ink.length)}?`, `${said} ${left}`.trim() || 'They are removed from the canvas.', 'Delete')) return
  drop()
  for (const el of gone) removeItem(el)
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
  // which also cancels the browser's own blur, so a message box would keep focus and take the next shortcut key
  if (document.activeElement instanceof HTMLElement && document.activeElement.matches(EDITABLE)) document.activeElement.blur()
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
    const inBox = new Set(canvasStrokes(m, drawings).flatMap(whole)) // one drawing of a group in the box: all of it
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

command({ label: 'Select all', group: 'Selection', keys: ['Ctrl+A'] })
command({ label: 'Nudge the selection (Shift: 10px)', group: 'Selection', keys: ['←→↑↓'] })
command({ label: 'Delete the selection', group: 'Selection', keys: ['Delete'] })
command({ label: 'Clear the selection', group: 'Selection', keys: ['Esc'] })
const NUDGE: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
addEventListener('keydown', e => {
  if (e.defaultPrevented || e.altKey || drawing) return
  if (!shortcutOk(e)) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return }
  if ((!sel.size && !inkSel.size) || e.ctrlKey || e.metaKey) return
  if (e.key === 'Escape') { if (anyFull()) return; e.preventDefault(); clearSelection() } // full view backs out first
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected() }
  else if (NUDGE[e.key]) { // arrow keys nudge the selection (Shift: 10px), like Excalidraw
    e.preventDefault()
    const [dx, dy] = NUDGE[e.key], step = e.shiftKey ? 10 : 1
    const m = selectionMover()
    m(dx * step, dy * step)
    m.end()
  }
})
