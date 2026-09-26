// The infinite canvas: viewport (pan / zoom), draggable items, fit, minimap.
// Items are absolutely positioned in #world, in world coordinates; #world carries the view transform.
// Every item carries class "item" and data-kind (session, file, run, diagram, sketch, plan, note, ...):
// that's all the canvas, the minimap and the saved layout need to know about it.
import { $, make, perFrame, EDITABLE, uuid } from '../lib/dom'

export const stage = $('#stage')
export const world = $('#world')
const inkworld = $('#inkworld') // drawing layer: same transform, stacked above every item
export const view = { x: 0, y: 0, k: 1 }
const MIN = 0.15, MAX = 2
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

export function apply(glide = false) {
  for (const el of [world, inkworld, stage]) el.classList.toggle('glide', glide)
  if (glide) setTimeout(() => { for (const el of [world, inkworld, stage]) el.classList.remove('glide') }, 460)
  world.style.transform = inkworld.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
  const g = 24 * view.k
  stage.style.backgroundSize = `${g}px ${g}px`
  stage.style.backgroundPosition = `${view.x}px ${view.y}px`
  $('#z-label').textContent = Math.round(view.k * 100) + '%'
  changed(true)
}

export function zoomAt(k: number, cx = innerWidth / 2, cy = innerHeight / 2, glide = false) {
  k = clamp(k)
  view.x = cx - (cx - view.x) * (k / view.k)
  view.y = cy - (cy - view.y) * (k / view.k)
  view.k = k
  apply(glide)
}

/* ---------- items ---------- */
export interface Rect { x: number; y: number; w: number; h: number; min?: boolean }

/** Make `el` a canvas item of this kind and put it in the world. */
export function addItem<T extends HTMLElement>(el: T, kind: string): T {
  el.classList.add('item')
  el.dataset.kind = kind
  el.dataset.id ||= uuid() // for canvas tools; kinds with their own ids overwrite it
  world.append(el)
  return el
}
/** Every canvas item, including windows pinned to the sidebar (they still belong to the canvas). */
const HOLDERS = ['#world', '.pinbar', '.floats', '.fullview'] // the canvas, and where windows go when lifted off it
export const items = (kind?: string) => [...document.querySelectorAll<HTMLElement>(HOLDERS.map(h => `${h} .item${kind ? `[data-kind="${kind}"]` : ''}`).join())]
/** Only what's laid out on the canvas itself: placement, fit and the minimap ignore pinned windows. */
const placed = () => items().filter(onCanvas)
/** Canvas items by their data-id: one DOM query, for restoring many saved references at once. */
export const byIds = () => new Map(items().map(el => [el.dataset.id!, el]))
export const byId = (id: string) => items().find(el => el.dataset.id === id)
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
  // pinned or in full view: its canvas size is kept in its styles (what it gets back on the canvas)
  ...(!onCanvas(el) ? { w: parseFloat(el.style.width) || el.offsetWidth, h: parseFloat(el.style.height) || el.offsetHeight } : { w: el.offsetWidth, h: el.offsetHeight }) })
/** Same, but with a collapsed window's expanded height: what saved layouts store. */
export const savedRect = (el: HTMLElement): Rect => {
  const min = el.classList.contains('min')
  const r = rect(el) // (pinned to the sidebar: its canvas size, not its size in the sidebar)
  return { ...r, h: min ? Number(el.dataset.fullH) || r.h : r.h, min } // min: false too, so a window collapsed by default stays open once you open it
}

let z = 10 // stacking inside #world only
export const front = (el: HTMLElement) => { el.style.zIndex = String(++z) }

/** Asked while an item is dragged (final=false, to highlight a target) and when it's released (final=true).
 *  Return true if the pointer is over something that takes the item: on release it then snaps back to where it was. */
type DropHandler = (el: HTMLElement, x: number, y: number, final: boolean) => boolean
let dropHandler: DropHandler | undefined
export const onDrop = (f: DropHandler) => { dropHandler = f }

/** What moves when `el` is dragged: itself, or the whole selection it's part of (set by canvas/select.ts). */
let groupOf = (el: HTMLElement) => [el]
export const setGroup = (f: (el: HTMLElement) => HTMLElement[]) => { groupOf = f }
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
    const group = groupOf(el).filter(g => g !== el && onCanvas(g)), starts = group.map(rect), along = moveAlong(el)
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

/** Follow one pointer press on `handle`: move(dx, dy) in screen px, end() on release. */
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

export function track(handle: Element, e: PointerEvent, move: (dx: number, dy: number) => void, end?: () => void) {
  e.preventDefault()
  e.stopPropagation()
  const sx = e.clientX, sy = e.clientY
  handle.setPointerCapture(e.pointerId)
  let done = false
  // once a frame (high-rate mice send several moves per frame); nothing after the end, which applies the last one
  const mv = perFrame((ev: PointerEvent) => { if (!done) move(ev.clientX - sx, ev.clientY - sy) }) as (ev: Event) => void
  const up = (ev: Event) => {
    if (done) return
    if (ev.type === 'pointerup') move((ev as PointerEvent).clientX - sx, (ev as PointerEvent).clientY - sy) // where it really ended
    done = true
    handle.removeEventListener('pointermove', mv)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    end?.()
  }
  handle.addEventListener('pointermove', mv)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
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
/** Move `r` down (then right) until it overlaps nothing on the canvas. */
export function freeSpot(r: Rect, step = 56): Rect {
  const others = placed().map(rect)
  for (let i = 0; i < 400 && others.some(o => hits(r, o)); i++) r = i % 12 === 11 ? { ...r, x: r.x + r.w + 40, y: r.y - step * 11 } : { ...r, y: r.y + step }
  return r
}
/** The free spot nearest to `r` (in any direction) where it overlaps nothing: for things that should land right
 *  by where they came from. Searches rings outward and stops at the first ring with a free spot. */
export function nearestFree(r: Rect, step = 24, reach = 60): Rect {
  const near = { x: r.x - reach * step, y: r.y - reach * step, w: r.w + 2 * reach * step, h: r.h + 2 * reach * step }
  const others = placed().map(rect).filter(o => hits(near, o)) // only what the search can bump into
  if (!others.some(o => hits(r, o))) return r
  for (let ring = 1; ring <= reach; ring++) {
    let best: Rect | null = null, bd = Infinity
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue // this ring's edge only
      const d = Math.hypot(i, j * 1.3) // a little cheaper sideways than up or down: reading order
      if (d >= bd) continue
      const c = { ...r, x: r.x + i * step, y: r.y + j * step }
      if (!others.some(o => hits(c, o))) { best = c; bd = d }
    }
    if (best) return best
  }
  return freeSpot(r)
}
/** Just right of everything on the canvas, top-aligned with the current view. */
export function nextColumn(w: number, h: number): Rect {
  const all = placed().map(rect)
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
  const k = clamp(Math.min((innerWidth - pad * 2) / (x1 - x0), (innerHeight - top - pad * 2) / (y1 - y0), 1))
  view.k = k
  view.x = (innerWidth - (x1 - x0) * k) / 2 - x0 * k
  view.y = top + (innerHeight - top - (y1 - y0) * k) / 2 - y0 * k
  apply(glide)
}

/* ---------- input: pan by dragging the background, wheel pans, Ctrl/Cmd+wheel (and pinch) zooms ---------- */
stage.addEventListener('pointerdown', e => {
  if (e.button > 1 || (e.target as Element).closest('.item, .fullview, .pinbar')) return
  const sx = e.clientX - view.x, sy = e.clientY - view.y
  stage.setPointerCapture(e.pointerId)
  stage.classList.add('panning')
  const move = (ev: PointerEvent) => { view.x = ev.clientX - sx; view.y = ev.clientY - sy; apply() }
  const up = () => { stage.classList.remove('panning'); stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerup', up) }
  stage.addEventListener('pointermove', move)
  stage.addEventListener('pointerup', up)
})

/** Is the pointer over something that scrolls (a card's log, a list, a code block)? Then the wheel is its, even
 *  at the end of its content: reaching the bottom of a log shouldn't start panning the canvas. */
const inScroller = (el: Element | null, e: WheelEvent): boolean => {
  const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX)
  for (; el && el !== stage; el = el.parentElement) {
    const s = el as HTMLElement, cs = getComputedStyle(s)
    if (vertical ? s.scrollHeight > s.clientHeight + 1 && /auto|scroll/.test(cs.overflowY) : s.scrollWidth > s.clientWidth + 1 && /auto|scroll/.test(cs.overflowX)) return true
  }
  return false
}
stage.addEventListener('wheel', e => {
  if ((e.target as Element).closest('.fullview, .floats .win, .pinbar')) return // full view, floating or pinned: its own scrolling only
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    zoomAt(view.k * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY)
    return
  }
  if (inScroller(e.target as Element, e)) return // let card logs, lists and code scroll natively
  e.preventDefault()
  view.x -= e.deltaX
  view.y -= e.deltaY
  apply()
}, { passive: false })

/* ---------- minimap: one box per item, colored by data-kind (and data-state, e.g. a busy session) ---------- */
const mm = $('#mm'), minimap = $('#minimap')
let mmScale = 1, mmOrigin = { x: 0, y: 0 }
// the items' boxes are measured and built only when something moved; a pan or zoom only re-scales from these
let mmItems: { el: HTMLElement; r: Rect; i: HTMLElement }[] = [], mmVp = make('i'), mmKey = ''
mmVp.dataset.k = 'vp'
onChange(viewOnly => {
  if (minimap.offsetParent === null) return // hidden on small screens
  const W = minimap.clientWidth, H = minimap.clientHeight
  const vp: Rect = { x: -view.x / view.k, y: -view.y / view.k, w: innerWidth / view.k, h: innerHeight / view.k }
  if (!viewOnly || !mmItems.length) {
    mmItems = placed().map(el => {
      const i = make('i')
      i.dataset.k = el.dataset.kind!
      if (el.dataset.state) i.dataset.s = el.dataset.state
      return { el, r: rect(el), i }
    })
    mm.replaceChildren(...mmItems.map(m => m.i), mmVp)
    mmKey = ''
  }
  const all = [...mmItems.map(m => m.r), vp]
  const x0 = Math.min(...all.map(r => r.x)), y0 = Math.min(...all.map(r => r.y))
  const x1 = Math.max(...all.map(r => r.x + r.w)), y1 = Math.max(...all.map(r => r.y + r.h))
  mmScale = Math.min((W - 12) / (x1 - x0), (H - 12) / (y1 - y0))
  mmOrigin = { x: x0 - (W / mmScale - (x1 - x0)) / 2, y: y0 - (H / mmScale - (y1 - y0)) / 2 }
  const at = (i: HTMLElement, r: Rect) => { i.style.cssText = `left:${(r.x - mmOrigin.x) * mmScale}px;top:${(r.y - mmOrigin.y) * mmScale}px;width:${Math.max(2, r.w * mmScale)}px;height:${Math.max(2, r.h * mmScale)}px` }
  const key = `${mmScale},${mmOrigin.x},${mmOrigin.y}`
  if (key !== mmKey) { mmItems.forEach(m => at(m.i, m.r)); mmKey = key } // the frame shifted: every box moves
  at(mmVp, vp)
  for (const m of mmItems) if ((m.el.dataset.state ?? '') !== (m.i.dataset.s ?? '')) m.i.dataset.s = m.el.dataset.state ?? '' // busy/asking sessions light up without moving
})
minimap.addEventListener('pointerdown', e => {
  const b = minimap.getBoundingClientRect()
  const wx = (e.clientX - b.left) / mmScale + mmOrigin.x, wy = (e.clientY - b.top) / mmScale + mmOrigin.y
  view.x = innerWidth / 2 - wx * view.k
  view.y = innerHeight / 2 - wy * view.k
  apply(true)
})

$('#z-in').onclick = () => zoomAt(view.k * 1.25, undefined, undefined, true)
$('#z-out').onclick = () => zoomAt(view.k / 1.25, undefined, undefined, true)
$('#z-label').onclick = () => zoomAt(1, undefined, undefined, true)
$('#z-fit').onclick = () => fit()
addEventListener('resize', () => changed())
