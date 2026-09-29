// The infinite canvas: viewport (pan / zoom), draggable items, fit, minimap.
// Items are absolutely positioned in #world, in world coordinates; #world carries the view transform.
// Every item carries class "item" and data-kind (session, file, run, diagram, sketch, plan, note, ...):
// that's all the canvas, the minimap and the saved layout need to know about it.
import { $, make, perFrame, EDITABLE, uuid } from '../lib/dom'
import { persist, each, saveSoon } from '../lib/store'

export const stage = $('#stage')
export const world = $('#world')
const inkworld = $('#inkworld') // drawing layer: same transform, stacked above every item
export const view = { x: 0, y: 0, k: 1 }
// Fit may go below MIN, so a canvas spread past ~9000px shows whole; from there the wheel can zoom in but not out.
// ponytail: FIT_MIN still cuts off a canvas wider than ~45000px (its middle shows)
const MIN = 0.15, MAX = 2, FIT_MIN = 0.03
const clamp = (k: number) => Math.min(MAX, Math.max(MIN, k))

const listeners: ((viewOnly: boolean) => void)[] = []
/** Called (once per frame) after any view change or item move (minimap, arrows, layout saving). `viewOnly`: only
 *  the pan/zoom changed since last time, nothing moved on the canvas; world-space things can skip their work. */
export const onChange = (f: (viewOnly: boolean) => void) => listeners.push(f)
let queued = false, moved = false
export function changed(viewOnly = false) {
  if (!viewOnly) moved = true
  if (queued) return
  queued = true
  requestAnimationFrame(() => { queued = false; const v = !moved; moved = false; listeners.forEach(f => f(v)) })
}

// The dot grid: a layer one cell bigger than the screen, moved by a transform (the offset modulo a cell), so a pan
// only moves a composited layer instead of repainting a full-screen background. Its spacing (a repaint) changes
// only with the zoom; the dots stay 1px at any zoom, as before.
// ponytail: during a glide the grid shifts by the offset modulo a cell, not the whole way the world flies (a
// slight drift for .45s); exact at rest. A JS-driven glide would fix it if anyone notices.
const grid = stage.insertBefore(make('div', 'grid'), world)
const zLabel = $('#z-label')
let gridG = 0
export function apply(glide = false) {
  for (const el of [world, inkworld, stage]) el.classList.toggle('glide', glide)
  if (glide) setTimeout(() => { for (const el of [world, inkworld, stage]) el.classList.remove('glide') }, 460)
  world.style.transform = inkworld.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
  const g = 24 * view.k, mod = (a: number) => ((a % g) + g) % g - g
  if (g !== gridG) { grid.style.backgroundSize = `${g}px ${g}px`; gridG = g; zLabel.textContent = Math.round(view.k * 100) + '%'; grid.hidden = view.k < MIN } // (under MIN the dots are a grey haze)
  grid.style.transform = `translate(${mod(view.x)}px, ${mod(view.y)}px)`
  changed(true)
}
/** For input that fires many times a frame (pointer pans, wheels, trackpads): the view updates now, the DOM once a frame. */
export const applySoon = perFrame(() => apply())

export function zoomView(k: number, cx: number, cy: number) {
  k = Math.min(MAX, Math.max(Math.min(MIN, view.k), k)) // under MIN (a fit): no further out
  view.x = cx - (cx - view.x) * (k / view.k)
  view.y = cy - (cy - view.y) * (k / view.k)
  view.k = k
}
export function zoomAt(k: number, cx = innerWidth / 2, cy = innerHeight / 2, glide = false) {
  zoomView(k, cx, cy)
  apply(glide)
}

/* ---------- items ---------- */
export interface Rect { x: number; y: number; w: number; h: number; min?: boolean }

/** Where items live: the canvas, and where windows go when lifted off it (sidebar, floating, full view). Items are
 *  always direct children of these, so listing them never walks into chat logs. */
const holders: Element[] = [world]
/** A place items can be moved to off the canvas (canvas/dock.ts, canvas/fullview.ts). */
export const holder = <T extends Element>(el: T) => { holders.push(el); return el }

/** Make `el` a canvas item of this kind and put it in the world. */
export function addItem<T extends HTMLElement>(el: T, kind: string): T {
  el.classList.add('item')
  el.dataset.kind = kind
  el.dataset.id ||= uuid() // for canvas tools; kinds with their own ids overwrite it
  world.append(el)
  return el
}

const away = new WeakSet<HTMLElement>(), goneFns: ((el: HTMLElement) => void)[] = []
/** Take an item off the page for now; it may come back (a finished sub-agent's window, a delete that can still be
 *  undone), so what holds on to it by id (a group's member list) keeps it. Returns what puts it back where it was. */
export function park(el: HTMLElement) {
  const parent = el.parentElement, next = el.nextSibling
  away.add(el)
  el.remove()
  return () => { away.delete(el); parent?.insertBefore(el, next?.parentNode === parent ? next : null) }
}
export const parked = (el: HTMLElement) => away.has(el)
/** A parked item isn't coming back after all: whoever kept it lets go (`onGone`). */
export function drop(el: HTMLElement) { away.delete(el); goneFns.forEach(f => f(el)) }
export const onGone = (f: (el: HTMLElement) => void) => goneFns.push(f)
/** Every canvas item, including windows pinned to the sidebar (they still belong to the canvas). */
export const items = (kind?: string) => holders.flatMap(h => [...h.children]).filter((el): el is HTMLElement =>
  el.classList.contains('item') && (!kind || (el as HTMLElement).dataset.kind === kind))
/** Only what's laid out on the canvas itself: placement, fit and the minimap ignore pinned windows, and windows
 *  hidden inside a collapsed group (data-hidden-in, items/group.ts). */
export const placed = () => [...world.children].filter((el): el is HTMLElement => el.classList.contains('item') && !hidden(el as HTMLElement))
/** Inside a collapsed group (items/group.ts sets data-hidden-in): out of sight, so placement, arrows, Ctrl+K and the
 *  selection leave it alone. */
export const hidden = (el: HTMLElement) => !!el.dataset.hiddenIn
/** Can you see this window now: page visible, not collapsed, on screen. For polling only while it's watched. */
export function watched(el: HTMLElement) {
  if (document.hidden || el.classList.contains('min') || !el.isConnected) return false
  const r = el.getBoundingClientRect()
  return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight
}
/** Canvas items by their data-id: one pass, for restoring many saved references at once. */
export const byIds = () => new Map(items().map(el => [el.dataset.id!, el]))
/** An id as Claude sees it: UUIDs cut to 8 characters, readable ids (git, f:path, l:card…) kept whole. */
export const shortId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) ? id.slice(0, 8) : id
/** Where an item appears right now, in canvas units: on the canvas its layout rect, when pinned to the sidebar the
 *  canvas spot under it on screen (edges to pinned windows end there). Reads layout: not for loops over many items. */
export function liveRect(el: HTMLElement): Rect {
  const on = onCanvas(el)
  let r: Rect
  if (on) r = rect(el) // world geometry: no screen read needed
  else { const b = el.getBoundingClientRect(), p = toWorld(b.left, b.top); r = { x: p.x, y: p.y, w: b.width / view.k, h: b.height / view.k } }
  // collapsed: only its tab is showing, so that's what arrows attach to (not its full width)
  const tab = el.classList.contains('min') ? el.querySelector<HTMLElement>(':scope > .win-h') : null
  if (tab) r.w = (tab.offsetLeft + tab.offsetWidth) / (on ? 1 : view.k)
  return r
}
/** Is it laid out on the canvas right now (not pinned to the sidebar, not in full view)? */
export const onCanvas = (el: HTMLElement) => el.parentElement === world

export const place = (el: HTMLElement, x: number, y: number) => { el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px` }
/** Where an item is and how big it looks right now (edges, minimap, placement). */
export const rect = (el: HTMLElement): Rect => ({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0,
  // pinned or in full view (or placing in bulk): its canvas size is kept in its styles (what it gets back on the canvas)
  ...(!onCanvas(el) || inBulk ? { w: parseFloat(el.style.width) || el.offsetWidth, h: parseFloat(el.style.height) || el.offsetHeight } : { w: el.offsetWidth, h: el.offsetHeight }) })
/** Same, but with a collapsed window's expanded height: what saved layouts store. */
export const savedRect = (el: HTMLElement): Rect => {
  const min = el.classList.contains('min')
  const r = rect(el) // (pinned to the sidebar: its canvas size, not its size in the sidebar)
  return { ...r, h: min ? Number(el.dataset.fullH) || r.h : r.h, min } // min: false too, so a window collapsed by default stays open once you open it
}

let z = 10 // stacking inside #world only
export const front = (el: HTMLElement) => { if (el.style.zIndex !== String(z)) { el.style.zIndex = String(++z); saveSoon() } }
// which one is on top survives a reload: ids bottom to top, raised in that order once the items exist. Layouts from
// before (no key) stack in load order, as they always did. ponytail: an item that shows up later (a card rebuilt
// from its process) lands on top.
persist('z', () => items().filter(el => el.style.zIndex).sort((a, b) => +a.style.zIndex - +b.style.zIndex).map(el => el.dataset.id!),
  (ids: string[]) => { const found = byIds(); each(ids, id => { const el = found.get(id); if (el) front(el) }) }, 2)
// a press anywhere on an item (not only its tab) brings it to the front: overlapping windows swap as you click them
world.addEventListener('pointerdown', e => { const el = (e.target as Element).closest<HTMLElement>('#world > .item'); if (el) front(el) }, true)

/** Asked while an item is dragged (final=false, to highlight a target) and when it's released (final=true).
 *  Return true if the pointer is over something that takes the item: on release it then snaps back to where it was. */
type DropHandler = (el: HTMLElement, x: number, y: number, final: boolean) => boolean
let dropHandler: DropHandler | undefined
export const onDrop = (f: DropHandler) => { dropHandler = f }

/** What else moves when an item is dragged. Each registered function answers for one item: canvas/select.ts (the
 *  selection it's in), items/group.ts (a group's windows). */
const withs: ((el: HTMLElement) => HTMLElement[])[] = []
export const moveWith = (f: (el: HTMLElement) => HTMLElement[]) => { withs.push(f) }
/** `el` and everything that moves with it, followed through: a selected group brings its windows along. */
export function movesWith(el: HTMLElement): HTMLElement[] {
  const all = new Set([el])
  // a Set's loop also visits what's added; a locked item (data-locked: a pinned group) stays put
  for (const x of all) for (const f of withs) for (const y of f(x)) if (!y.dataset.locked) all.add(y)
  return [...all]
}
/** Moves things by a total offset in canvas units while a drag runs; `end()` settles them when it's over. */
export type Mover = ((dx: number, dy: number) => void) & { end: () => void }
/** Anything else that moves with `el`'s group (selected drawings): called when a drag starts, returns a mover or null. */
let moveAlong: (el: HTMLElement) => Mover | null = () => null
export const setMoveAlong = (f: typeof moveAlong) => { moveAlong = f }

/** Drag `el` by `handle` (with the rest of the selection, if it's selected). A press that doesn't move counts as a click. */
export function draggable(el: HTMLElement, handle: HTMLElement, onMove: () => void, onClick?: () => void) {
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !onCanvas(el) || (e.target as Element).closest(`button, a, .log, .compose, ${EDITABLE}`)) return
    e.stopPropagation()
    front(el)
    const sx = e.clientX, sy = e.clientY, o = rect(el)
    // (off the canvas too: a pinned window's canvas spot, what it comes back to, moves with its group)
    const group = movesWith(el).filter(g => g !== el), starts = group.map(rect), along = moveAlong(el)
    const alone = !group.length && !along // a group isn't dropped onto a card
    let moved = false, done = false
    // the pointer is captured only once it really drags: capturing on press would re-target a double-click to the
    // handle, and the tab's title couldn't be double-clicked to rename it. Until then the window follows the pointer.
    const step = (ev: PointerEvent) => {
      if (done) return
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      if (!moved && Math.hypot(dx, dy) < 4) return
      if (!moved) { handle.setPointerCapture(ev.pointerId); getSelection()?.removeAllRanges() } // a drag, not a text selection
      moved = true
      el.classList.add('dragging')
      place(el, o.x + dx / view.k, o.y + dy / view.k)
      group.forEach((g, i) => place(g, starts[i].x + dx / view.k, starts[i].y + dy / view.k))
      along?.(dx / view.k, dy / view.k)
      if (alone) dropHandler?.(el, ev.clientX, ev.clientY, false)
      onMove()
      if (!alone) changed() // other items' arrows follow too
    }
    const move = perFrame(step) // high-rate mice send several moves a frame: place and hit-test once
    const up = (ev: PointerEvent) => {
      if (ev.type === 'pointerup') step(ev) // where the pointer really ended (a pointercancel's coordinates are 0,0)
      done = true
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      el.classList.remove('dragging')
      if (moved && alone && dropHandler?.(el, ev.clientX, ev.clientY, true)) { place(el, o.x, o.y); onMove() }
      along?.end()
      if (moved) { changed(); el.dispatchEvent(new CustomEvent('moved', { bubbles: true })) } // e.g. taken out of a gathered pile
      else if (ev.type === 'pointerup') onClick?.() // a cancelled touch isn't a click
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  })
}

/** A grip on a right-docked panel's left edge: drag to widen it (min `minW`, and never past the screen). */
export function edgeGrip(panel: HTMLElement, minW: number, onMove?: () => void, onEnd?: () => void) {
  const grip = panel.appendChild(make('div', 'edge-grip'))
  grip.title = 'Drag to resize'
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    const w = panel.offsetWidth
    panel.classList.add('resizing')
    track(grip, e, dx => { panel.style.width = `${Math.min(innerWidth - 24, Math.max(minW, w - dx))}px`; onMove?.() },
      () => { panel.classList.remove('resizing'); onEnd?.() })
  })
}

/** Follow one pointer press on `handle`: move(dx, dy, ev) in screen px, end(ev) on release or cancel (check
 *  `ev.type`: a cancelled press's coordinates are 0,0). Options: `keep` leaves the press's default and propagation
 *  alone (a canvas press should still blur what's focused); `every` sees every move, not one per frame (pen ink);
 *  `late` captures the pointer only once it really drags (a title under the handle can still be double-clicked:
 *  capturing on press sends the double-click to the handle). */
export function track(handle: Element, e: PointerEvent, move: (dx: number, dy: number, ev: PointerEvent) => void, end?: (ev: PointerEvent) => void,
  o: { keep?: boolean; every?: boolean; late?: boolean } = {}) {
  if (!o.keep) { e.preventDefault(); e.stopPropagation() }
  const sx = e.clientX, sy = e.clientY, id = e.pointerId, on: EventTarget = o.late ? window : handle // uncaptured: moves go elsewhere
  let done = false, held = !o.late
  if (held) handle.setPointerCapture(id)
  const step = (ev: PointerEvent) => {
    if (done || ev.pointerId !== id) return
    if (!held && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
    if (!held) { handle.setPointerCapture(id); held = true }
    move(ev.clientX - sx, ev.clientY - sy, ev)
  }
  // once a frame (high-rate mice send several moves per frame); nothing after the end, which applies the last one
  const mv = (o.every ? step : perFrame(step)) as (ev: Event) => void
  const up = (ev: Event) => {
    const p = ev as PointerEvent
    if (done || p.pointerId !== id) return
    if (ev.type === 'pointerup' && held) move(p.clientX - sx, p.clientY - sy, p) // where it really ended
    done = true
    on.removeEventListener('pointermove', mv)
    on.removeEventListener('pointerup', up)
    on.removeEventListener('pointercancel', up)
    end?.(p)
  }
  on.addEventListener('pointermove', mv)
  on.addEventListener('pointerup', up)
  on.addEventListener('pointercancel', up)
}

/** Drag something out of a window onto the canvas. Past a few px, `create(x, y)` makes the new item at the
 *  pointer (held at `grab`, e.g. by its tab), and it follows the pointer. The click ending a drag is swallowed,
 *  so a row that toggles on click doesn't toggle too. Returns nothing: a press that doesn't move stays a click. */
export function dragOut(handle: HTMLElement, e: PointerEvent, create: (x: number, y: number) => HTMLElement, grab = { x: 60, y: 17 }) {
  let node: HTMLElement | undefined
  track(handle, e, (dx, dy) => {
    if (!node && Math.hypot(dx, dy) < 8) return
    const p = toWorld(e.clientX + dx, e.clientY + dy)
    if (!node) { node = create(p.x - grab.x, p.y - grab.y); node.classList.add('dragging') }
    place(node, p.x - grab.x, p.y - grab.y)
  }, () => {
    if (!node) return
    node.classList.remove('dragging')
    changed()
    swallowNext('click', 0) // the drag's closing click; none came: don't eat the next one
  })
}

/** Eat the next `type` event page-wide (the one a gesture ends with), unless none comes within `ms`. */
export function swallowNext(type: string, ms: number) {
  const eat = (ev: Event) => { ev.stopImmediatePropagation(); ev.preventDefault() }
  addEventListener(type, eat, { capture: true, once: true })
  setTimeout(() => removeEventListener(type, eat, { capture: true }), ms)
}

/** Resize grips on the left, right and bottom edges and both bottom corners (the top is the tab, which drags), in
 *  world units so they track the pointer at any zoom. The left side moves the window too, so its right edge stays
 *  put. `widthOnly`: the height follows the content (text notes): only the sides and a corner, for width. */
export function resizable(el: HTMLElement, minW: number, minH: number, onResize: () => void, widthOnly = false) {
  const edges = widthOnly ? ['e', 'w', 'se'] : ['e', 'w', 's', 'se', 'sw']
  for (const edge of edges) {
    const grip = el.appendChild(make('div', 'grip'))
    grip.dataset.edge = edge
    grip.title = 'Drag to resize'
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      e.stopPropagation()
      front(el)
      const w = el.offsetWidth, h = el.offsetHeight, k = onCanvas(el) ? view.k : 1 // floating: not scaled
      const x = parseFloat(el.style.left) || 0, fx = parseFloat(el.style.getPropertyValue('--fx')) || 0
      const left = edge.includes('w'), right = edge.includes('e'), down = edge.includes('s') && !widthOnly
      el.style.setProperty('--resize-cursor', getComputedStyle(grip).cursor) // before .resizing overrides it: a side edge stays ew/ns
      el.classList.add('resizing')
      track(grip, e, (dx, dy) => {
        if (right) el.style.width = `${Math.max(minW, Math.round(w + dx / k))}px`
        if (left) {
          const nw = Math.max(minW, Math.round(w - dx / k)), moved = w - nw // what the left edge actually moved, in window px
          el.style.width = `${nw}px`
          if (el.classList.contains('floating')) el.style.setProperty('--fx', `${Math.round(fx + moved)}px`)
          else el.style.left = `${Math.round(x + moved)}px`
        }
        if (down) el.style.height = `${Math.max(minH, Math.round(h + dy / k))}px`
        onResize()
      }, () => { el.classList.remove('resizing'); el.style.removeProperty('--resize-cursor'); changed() })
    })
  }
}

export const hits = (a: Rect, b: Rect, pad = 16) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad

/* ---------- placing new items: a free spot that overlaps nothing ---------- */
// Bulk mode (a transcript replaying makes many windows at once): the canvas is measured once and every spot handed
// out is added to that list, instead of reading layout after each window is written. ponytail: a spot handed out
// but not used (a saved position won) still counts as taken until bulk mode ends.
let inBulk = false, taken: Rect[] | null = null
/** Many items are being placed at once (the session owner sets it around a replay): no layout reads per item. */
export const bulk = (on: boolean) => { inBulk = on; taken = null }
const occupied = () => (inBulk ? (taken ??= placed().map(rect)) : placed().map(rect))
const take = (r: Rect) => { taken?.push(r); return r }
/** Move `r` down (then right) until it overlaps nothing on the canvas. */
export function freeSpot(r: Rect, step = 56): Rect {
  const others = occupied()
  for (let i = 0; i < 400 && others.some(o => hits(r, o)); i++) r = i % 12 === 11 ? { ...r, x: r.x + r.w + 40, y: r.y - step * 11 } : { ...r, y: r.y + step }
  return take(r)
}
/** The free spot nearest to `r` (in any direction) where it overlaps nothing: for things that should land right
 *  by where they came from. Searches rings outward and stops at the first ring with a free spot. */
export function nearestFree(r: Rect, step = 24, reach = 60): Rect {
  const near = { x: r.x - reach * step, y: r.y - reach * step, w: r.w + 2 * reach * step, h: r.h + 2 * reach * step }
  const others = occupied().filter(o => hits(near, o)) // only what the search can bump into
  if (!others.some(o => hits(r, o))) return take(r)
  for (let ring = 1; ring <= reach; ring++) {
    let best: Rect | null = null, bd = Infinity
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue // this ring's edge only
      const d = Math.hypot(i, j * 1.3) // a little cheaper sideways than up or down: reading order
      if (d >= bd) continue
      const c = { ...r, x: r.x + i * step, y: r.y + j * step }
      if (!others.some(o => hits(c, o))) { best = c; bd = d }
    }
    if (best) return take(best)
  }
  return freeSpot(r)
}
/** Just right of everything on the canvas, top-aligned with the current view. */
export function nextColumn(w: number, h: number): Rect {
  const all = occupied()
  const x = all.length ? Math.max(...all.map(r => r.x + r.w)) + 160 : 0
  const y = all.length ? Math.min(...all.map(r => r.y)) : 0
  return freeSpot({ x, y, w, h })
}
/** Beside an item (right of it, top-aligned), or the middle of the view when there's none. */
export function spotBeside(el: HTMLElement | null | undefined, w: number, h: number, dx = 150, dy = 0): Rect {
  if (!el) { const c = viewCenter(); return freeSpot({ x: c.x - w / 2, y: c.y - h / 2, w, h }) }
  const r = rect(el)
  return freeSpot({ x: r.x + r.w + dx, y: r.y + dy, w, h })
}
export const toWorld = (cx: number, cy: number) => ({ x: (cx - view.x) / view.k, y: (cy - view.y) / view.k })
export const viewCenter = () => ({ x: (innerWidth / 2 - view.x) / view.k, y: (innerHeight / 2 - view.y) / view.k })

/** Bring `el` to the middle of the screen. The zoom stays, unless the window would be too small to read (under
 *  50%) or wouldn't fit: then it zooms to fit the window, never past 100%. */
export function centerOn(el: HTMLElement, glide = true) {
  const r = rect(el)
  const fits = Math.min((innerWidth - 32) / r.w, (innerHeight - 96) / r.h)
  if (view.k < 0.5 || view.k > fits) view.k = clamp(Math.min(1, fits))
  view.x = innerWidth / 2 - (r.x + r.w / 2) * view.k
  view.y = innerHeight / 2 - (r.y + r.h / 2) * view.k
  apply(glide)
}

/** Zoom to show everything (or just `rs`, e.g. the selection). */
export function fit(glide = true, rs = placed().map(rect)) {
  if (!rs.length) return
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y))
  const x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h))
  const pad = 80, top = 64 // keep clear of the toolbar
  const k = Math.max(FIT_MIN, Math.min((innerWidth - pad * 2) / (x1 - x0), (innerHeight - top - pad * 2) / (y1 - y0), 1))
  view.k = k
  view.x = (innerWidth - (x1 - x0) * k) / 2 - x0 * k
  view.y = top + (innerHeight - top - (y1 - y0) * k) / 2 - y0 * k
  apply(glide)
}

addEventListener('resize', () => changed())
