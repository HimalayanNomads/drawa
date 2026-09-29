// Pinning a window so it stays on screen while you pan and zoom. Two ways: into the sidebar on the right (stacked,
// sharing its height), or floating anywhere on the screen (drag its tab to move it). Unpinning puts it back where
// it was on the canvas: pinned windows keep their canvas position and size in their inline styles (see rect()).
import { $, make } from '../lib/dom'
import { persist } from '../lib/store'
import { world, stage, items, front, centerOn, changed, track, onChange, byIds, edgeGrip, holder, rect, view } from './canvas'
import { redraw } from './graph'
import { exitFull } from './fullview'

// inside the stage, just under the pen's capture layer: Draw mode reaches pinned windows too (canvas.css)
const dock = holder(stage.insertBefore(make('aside', 'pinbar'), $('#ink-capture')))
let wasCompact = false
dock.setAttribute('aria-label', 'Pinned windows')
dock.hidden = true
edgeGrip(dock, 300, () => shown(), () => changed())

export const docked = (el: HTMLElement) => el.classList.contains('docked')

/** Show the sidebar only when something is pinned, and tell the rest of the chrome how wide it is. */
function shown() {
  dock.hidden = !dock.querySelector('.item')
  // every pinned window collapsed: just their tabs, top right, and the canvas stays usable under the rest
  const compact = !dock.querySelector(':scope > .win:not(.min)')
  dock.classList.toggle('compact', compact)
  wasCompact = compact
  document.body.classList.toggle('has-dock', !dock.hidden && !compact)
  document.documentElement.style.setProperty('--dock-w', `${dock.offsetWidth || 420}px`)
  redraw() // arrows to pinned windows end where they sit now
}
dock.addEventListener('scroll', () => redraw(), { passive: true })
onChange(viewOnly => { // a pinned window collapsed, opened or closed
  if (viewOnly) return
  const compact = !dock.querySelector(':scope > .win:not(.min)')
  if (!dock.hidden && (compact !== wasCompact || !dock.querySelector('.item'))) shown()
  if (waiting && performance.now() - tried > 1000) adopt()
})

/** Pin a window to the sidebar, or put a pinned one back on the canvas. */
export function toggleDock(el: HTMLElement) {
  if (el.classList.contains('full')) exitFull()
  if (floating(el)) unfloat(el)
  if (docked(el)) {
    el.classList.remove('docked')
    world.append(el)
    bringBack(el)
  } else {
    el.classList.add('docked')
    dock.append(el)
    el.scrollIntoView({ block: 'nearest' })
  }
  sync(el)
  shown() // arrows to a pinned window are hidden while it's pinned
  changed()
}

/** A window's toggle button (pin, float, full view) shows whether it's on, and says what a click will do. */
export function setToggle(el: HTMLElement, cls: string, on: boolean, onTitle: string, offTitle: string) {
  const b = el.querySelector<HTMLElement>(`:scope > .win-h .${cls}`)
  if (!b) return
  b.classList.toggle('on', on)
  b.title = on ? onTitle : offTitle
  b.setAttribute('aria-label', b.title)
  b.setAttribute('aria-pressed', String(on))
}
/** The pin buttons' look follows the window's state. */
export function syncPin(el: HTMLElement) {
  setToggle(el, 'pinbtn', docked(el), 'Unpin: back to its place on the canvas (Shift+P)', 'Pin to sidebar: stays on screen while you move around (Shift+P)')
  setToggle(el, 'floatbtn', floating(el), 'Unstick: back to its place on the canvas (Shift+S)', 'Stick to screen: floats where it is while you move around (Shift+S)')
}
const sync = syncPin

/* ---------- floating: stuck to the screen wherever you put it ---------- */
// in the stage (above the canvas, under full view and the pen's layer, so you can draw on it too)
const floats = holder(stage.insertBefore(make('div', 'floats'), $('.fullview') ?? $('#ink-capture')))
export const floating = (el: HTMLElement) => el.classList.contains('floating')
const setAt = (el: HTMLElement, x: number, y: number) => {
  const nx = Math.min(Math.max(0, x), innerWidth - 120), ny = Math.min(Math.max(56, y), innerHeight - 40) // a tab stays reachable
  el.style.setProperty('--fx', `${Math.round(nx)}px`)
  el.style.setProperty('--fy', `${Math.round(ny)}px`)
}

/** Stick a window to the screen where it is now, or put a floating one back on the canvas. */
export function toggleFloat(el: HTMLElement) {
  if (el.classList.contains('full')) exitFull()
  if (floating(el)) { unfloat(el); bringBack(el) }
  else {
    const b = el.getBoundingClientRect()
    if (docked(el)) { el.classList.remove('docked'); shown() }
    el.classList.add('floating')
    setAt(el, b.left, b.top)
    floats.append(el)
    raise(el)
  }
  sync(el)
  redraw()
  changed()
}
/** Back on the canvas, on top; the camera goes to it only if its spot is off screen (a window you just unpinned
 *  from next to where it belongs shouldn't send the view flying). */
function bringBack(el: HTMLElement) {
  front(el)
  const r = rect(el), x = (r.x + r.w / 2) * view.k + view.x, y = (r.y + r.h / 2) * view.k + view.y
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) centerOn(el)
}
function unfloat(el: HTMLElement) {
  el.classList.remove('floating')
  world.append(el)
  sync(el)
}
let zf = 0
const raise = (el: HTMLElement) => { el.style.setProperty('--fz', String(++zf)) }

// move a floating window by its tab (the canvas's own dragging is for windows on the canvas)
floats.addEventListener('pointerdown', e => {
  const t = e.target as Element, el = t.closest<HTMLElement>('.floating')
  if (!el) return
  raise(el)
  if (e.button !== 0 || !t.closest('.win-h') || t.closest('button, [contenteditable="plaintext-only"]')) return
  const sx = parseFloat(el.style.getPropertyValue('--fx')), sy = parseFloat(el.style.getPropertyValue('--fy'))
  el.classList.add('dragging')
  track(el.querySelector<HTMLElement>('.win-h')!, e as PointerEvent, (dx, dy) => { setAt(el, sx + dx, sy + dy); redraw() }, () => { el.classList.remove('dragging'); changed() }, { late: true })
})

// a smaller window (a phone turned, a smaller screen): keep every floating window's tab reachable
addEventListener('resize', () => { for (const el of floats.querySelectorAll<HTMLElement>(':scope > .floating')) setAt(el, parseFloat(el.style.getPropertyValue('--fx')), parseFloat(el.style.getPropertyValue('--fy'))) })

type Float = { id: string; x: number; y: number }
// saved pins and floats whose windows aren't on the canvas (yet): kept and written back, so a window that loads late
// (or failed to load once) is still pinned when it shows up. ponytail: kept forever if it never does (a few bytes).
let waitFloat: Float[] = [], waitDock: string[] = [], waiting = false, tried = 0
function adopt() {
  tried = performance.now()
  const ids = byIds()
  waitFloat = waitFloat.filter(f => {
    const el = ids.get(f.id)
    if (el && !floating(el)) { el.classList.add('floating'); setAt(el, f.x, f.y); floats.append(el); raise(el); sync(el) }
    return !el
  })
  waitDock = waitDock.filter(id => {
    const el = ids.get(id)
    if (el && !docked(el)) { el.classList.add('docked'); dock.append(el); sync(el) }
    return !el
  })
  waiting = !!(waitFloat.length || waitDock.length)
  shown()
}
persist('floating', () => [...items().filter(floating).map(el => ({ id: el.dataset.id!, x: parseFloat(el.style.getPropertyValue('--fx')), y: parseFloat(el.style.getPropertyValue('--fy')) })), ...waitFloat],
  (list: Float[]) => { waitFloat = list; adopt() }, 2)

// saved with the layout: which windows are pinned, in order, and the sidebar's width (after the windows exist)
persist('dock', () => ({ ids: [...items().filter(docked).map(el => el.dataset.id!), ...waitDock], w: dock.style.width || undefined }), (v: { ids: string[]; w?: string }) => {
  if (v.w) dock.style.width = v.w
  waitDock = v.ids ?? []
  adopt()
}, 2) // every kind has an id that's the same after a reload (commands, Files and plans too), so all of them stay pinned
