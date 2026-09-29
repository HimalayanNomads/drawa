// Moving around the canvas: drag the background to pan (Hand mode, Space, the middle button), the wheel pans,
// Ctrl/Cmd+wheel (and pinch) zooms; the minimap and the zoom buttons in the corner.
import { $, make } from '../lib/dom'
import { stage, view, apply, applySoon, zoomView, zoomAt, fit, track, onChange, changed, placed, rect, centerOn, onCanvas, type Rect } from './canvas'

stage.addEventListener('pointerdown', e => {
  if (e.button > 1 || (e.target as Element).closest('.item, .fullview, .pinbar')) return
  const x = view.x, y = view.y
  stage.classList.add('panning')
  track(stage, e, (dx, dy) => { view.x = x + dx; view.y = y + dy; apply() }, () => stage.classList.remove('panning'), { keep: true })
})

// Tab can move focus into a window that's off-screen: bring the window into view. Only after Tab: a click lands on
// something already in view, and code that focuses a field decides for itself whether to move the view.
let tabbed = -1e9
addEventListener('keydown', e => { if (e.key === 'Tab') tabbed = e.timeStamp }, true)
document.addEventListener('focusin', e => {
  const t = e.target as HTMLElement, el = t.closest?.<HTMLElement>('.item')
  if (!el || !onCanvas(el) || e.timeStamp - tabbed > 500) return
  const r = t.getBoundingClientRect()
  if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) centerOn(el)
})

/** The wheel's deltas, with Shift+wheel turned sideways (some browsers leave it on deltaY). */
const deltas = (e: WheelEvent) => (e.shiftKey && !e.deltaX ? { dx: e.deltaY, dy: 0 } : { dx: e.deltaX, dy: e.deltaY })
/** Is the pointer over something that scrolls (a card's log, a list, a code block)? Then the wheel is its, even
 *  at the end of its content: reaching the bottom of a log shouldn't start panning the canvas. */
const inScroller = (el: Element | null, e: WheelEvent): boolean => {
  const { dx, dy } = deltas(e)
  const vertical = Math.abs(dy) >= Math.abs(dx)
  for (; el && el !== stage; el = el.parentElement) {
    const s = el as HTMLElement, cs = getComputedStyle(s)
    // the style first: only an element that can scroll gets its sizes read
    if (!/auto|scroll/.test(vertical ? cs.overflowY : cs.overflowX)) continue
    if (vertical ? s.scrollHeight > s.clientHeight + 1 : s.scrollWidth > s.clientWidth + 1) return true
  }
  return false
}
stage.addEventListener('wheel', e => {
  if ((e.target as Element).closest('.fullview, .floats .win, .pinbar')) return // full view, floating or pinned: its own scrolling only
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    zoomView(view.k * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY)
    applySoon()
    return
  }
  if (inScroller(e.target as Element, e)) return // let card logs, lists and code scroll natively
  e.preventDefault()
  const { dx, dy } = deltas(e)
  view.x -= dx
  view.y -= dy
  applySoon()
}, { passive: false })

/* ---------- touch: two fingers pan and pinch the canvas anywhere, windows included (on a phone they cover most
   of it), while one finger keeps scrolling a log, dragging a tab or panning the background. ---------- */
let press: { id: number; at: EventTarget } | undefined // the first finger's press, to call off what it started
stage.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return
  if (e.isPrimary) press = { id: e.pointerId, at: e.target! }
  else e.stopPropagation() // a second finger is a pinch, not a second drag
}, true)
let pinch: { d: number; x: number; y: number } | undefined
const span = (t: TouchList) => ({ d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 })
stage.addEventListener('touchmove', e => {
  if (e.touches.length !== 2) return
  // not cancelable: a log is already scrolling under the first finger, and it keeps the gesture
  if (!e.cancelable || (e.target as Element).closest('.fullview, .floats .win, .pinbar')) return
  e.preventDefault()
  const s = span(e.touches)
  if (!pinch) { // the first finger's drag, pan or stroke ends where it is (their handlers all treat a cancel as a stop)
    if (press) press.at.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: press.id, pointerType: 'touch', isPrimary: true }))
    press = undefined
    pinch = s
    return
  }
  view.x += s.x - pinch.x
  view.y += s.y - pinch.y
  if (pinch.d > 0) zoomView(view.k * s.d / pinch.d, s.x, s.y)
  pinch = s
  applySoon()
}, { passive: false })
const lift = (e: TouchEvent) => { if (e.touches.length < 2) pinch = undefined }
stage.addEventListener('touchend', lift)
stage.addEventListener('touchcancel', lift)

/* ---------- minimap: one box per item, colored by data-kind (and data-state, e.g. a busy session) ---------- */
const mm = $('#mm'), minimap = $('#minimap')
let mmScale = 1, mmOrigin = { x: 0, y: 0 }, mmKey = '', stale = true
// boxes are made and dropped as items come and go, and moved only when their item moved or the frame shifted;
// a pan or zoom only moves the viewport box (unless it widens the frame)
const boxes = new Map<HTMLElement, { i: HTMLElement; r: Rect; moved: boolean }>()
const vp = mm.appendChild(make('i'))
vp.dataset.k = 'vp'
const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
function measure() {
  const now = placed(), rs = now.map(rect) // every read first, then the writes
  const seen = new Set(now)
  for (const [el, b] of boxes) if (!seen.has(el)) { b.i.remove(); boxes.delete(el) }
  now.forEach((el, n) => {
    const b = boxes.get(el)
    if (b) { if (!same(b.r, rs[n])) { b.r = rs[n]; b.moved = true }; return }
    const i = mm.insertBefore(make('i'), vp)
    i.dataset.kind = el.dataset.kind!
    boxes.set(el, { i, r: rs[n], moved: true })
  })
}
onChange(viewOnly => {
  if (minimap.offsetParent === null) { stale ||= !viewOnly; return } // hidden on small screens
  if (!viewOnly || stale) { measure(); stale = false }
  const W = minimap.clientWidth, H = minimap.clientHeight
  const v: Rect = { x: -view.x / view.k, y: -view.y / view.k, w: innerWidth / view.k, h: innerHeight / view.k }
  const all = [...[...boxes.values()].map(b => b.r), v]
  const x0 = Math.min(...all.map(r => r.x)), y0 = Math.min(...all.map(r => r.y))
  const x1 = Math.max(...all.map(r => r.x + r.w)), y1 = Math.max(...all.map(r => r.y + r.h))
  mmScale = Math.min((W - 12) / (x1 - x0), (H - 12) / (y1 - y0))
  mmOrigin = { x: x0 - (W / mmScale - (x1 - x0)) / 2, y: y0 - (H / mmScale - (y1 - y0)) / 2 }
  const at = (i: HTMLElement, r: Rect) => { i.style.cssText = `left:${(r.x - mmOrigin.x) * mmScale}px;top:${(r.y - mmOrigin.y) * mmScale}px;width:${Math.max(2, r.w * mmScale)}px;height:${Math.max(2, r.h * mmScale)}px` }
  const key = `${mmScale},${mmOrigin.x},${mmOrigin.y}`, shifted = key !== mmKey
  mmKey = key
  for (const [el, b] of boxes) {
    if (shifted || b.moved) { at(b.i, b.r); b.moved = false }
    if ((el.dataset.state ?? '') !== (b.i.dataset.s ?? '')) b.i.dataset.s = el.dataset.state ?? '' // busy/asking sessions light up without moving
  }
  at(vp, v)
})

/* ---------- the minimap shows while the view moves and folds away after a quiet spell; hovering the corner keeps it
   (CSS), and a session starting to ask brings it back so its box can say which one needs you ---------- */
const nav = $('#nav')
let quiet = 0, lastView = ''
function wake() {
  delete nav.dataset.state
  clearTimeout(quiet)
  quiet = setTimeout(() => { nav.dataset.state = 'quiet' }, 1500)
}
onChange(() => {
  const at = `${view.x},${view.y},${view.k}` // only the view: items resizing while Claude streams shouldn't wake it
  if (at !== lastView) { lastView = at; wake() }
})
new MutationObserver(recs => {
  if (!recs.some(r => (r.target as HTMLElement).dataset.state === 'asking' && r.oldValue !== 'asking')) return
  wake()
  changed(true) // repaint the boxes' states now, not at the next pan
}).observe(stage, { subtree: true, attributeFilter: ['data-state'], attributeOldValue: true })

// press to jump there, drag to keep moving: the map's scale is held from the press (moving the view reshapes the
// map, and the point under the pointer would run away from it)
minimap.addEventListener('pointerdown', e => {
  if (e.button !== 0) return
  const b = minimap.getBoundingClientRect(), k = mmScale, o = mmOrigin
  const go = (x: number, y: number, glide = false) => {
    view.x = innerWidth / 2 - ((x - b.left) / k + o.x) * view.k
    view.y = innerHeight / 2 - ((y - b.top) / k + o.y) * view.k
    apply(glide)
  }
  go(e.clientX, e.clientY, true)
  track(minimap, e, (dx, dy) => { if (dx || dy) go(e.clientX + dx, e.clientY + dy) }) // (a click keeps its glide)
})

$('#z-in').onclick = () => zoomAt(view.k * 1.25, undefined, undefined, true)
$('#z-out').onclick = () => zoomAt(view.k / 1.25, undefined, undefined, true)
$('#z-label').onclick = () => zoomAt(1, undefined, undefined, true)
$('#z-fit').onclick = () => fit()
