// Groups (issue #14): a named frame that owns a set of windows. Members stay ordinary canvas items; the group keeps
// their ids in data-members, brings them along when its tab is dragged (moveWith), always wraps them (auto-fit,
// frozen while anything is dragged), and never overlaps another group (groupgeom.ts settles that). A window joins
// by being dropped into a frame, and leaves by being dropped outside it or through its tab's Remove from group button.
// Drawings on the canvas belong to groups too (groupink.ts).
import { make, ICON, iconButton, confirmBox, uuid, perFrame } from '../lib/dom'
import { persist, each } from '../lib/store'
import { world, items, byIds, rect, savedRect, place, changed, onChange, onCanvas, moveWith, movesWith, viewCenter, parked, onGone, type Rect } from '../canvas/canvas'
import { makeWindow, winTitle, titleOf } from '../canvas/window'
import { referable } from '../canvas/refs'
import { setToggle } from '../canvas/dock'
import { redraw, forget } from '../canvas/graph'
import { removable, removeItem, onSelect } from '../canvas/select'
import { erase } from '../canvas/inkundo'
import { strokeMover, inkWith } from '../canvas/inksel'
import { inkIds, setInkIds, groupInk, hideInk, inkRects } from './groupink'
import './groupselect' // Ctrl+G and the selection bar's Group / Ungroup
import { frameAround, settle, inner, scaleInto, placeIn, compact, PAD, GAP, type Frame } from './groupgeom'

const MIN = { w: 320, h: 200 } // an empty group: room to drop windows into

referable('group', {
  icon: '⧉',
  name: 'Group',
  content: (g, label) => {
    const ms = members(g)
    return { text: `Group "${label}" (${ms.length} window${ms.length === 1 ? '' : 's'}): ${ms.map(titleOf).join(', ') || 'empty'}` }
  },
})

export const groups = () => items('group')
export const isGroup = (el: HTMLElement) => el.dataset.kind === 'group'
/** Windows only: bare items (notes, file nodes) have no tab to carry the Remove from group button. */
export const groupable = (el: HTMLElement) => el.classList.contains('win') && !isGroup(el)
// member ids, kept even for windows that haven't shown up yet (a card rebuilt from its process after a reload)
const ids = (g: HTMLElement): string[] => JSON.parse(g.dataset.members || '[]')
let index: Map<string, HTMLElement> | null = null // window id → its group, rebuilt after any change (setIds)
export const groupOf = (el: HTMLElement) => (index ??= new Map(groups().flatMap(g => ids(g).map(id => [id, g] as const)))).get(el.dataset.id!)
function setIds(g: HTMLElement, list: string[]) {
  const before = ids(g), found = byIds()
  g.dataset.members = JSON.stringify(list)
  index = null
  outlinesSoon()
  for (const id of before) if (!list.includes(id)) found.get(id)?.querySelector(':scope > .win-h .leavebtn')?.remove()
  adopt(g, found)
  const t = g.querySelector<HTMLElement>(':scope > .win-h .t')
  if (t) t.dataset.count = String(list.length) // shown on the tab while collapsed
}
/** Give the group's windows what membership brings: a "Remove from group" button on each tab and, while the group is
 *  collapsed, hiding. Also run on every refit, for windows that show up after the group was restored. */
function adopt(g: HTMLElement, found: Map<string, HTMLElement>) {
  const min = g.classList.contains('min')
  for (const m of members(g, found)) {
    const head = m.querySelector<HTMLElement>(':scope > .win-h')
    if (head && !head.querySelector(':scope > .leavebtn')) head.insertBefore(iconButton(ICON.ungroup, 'Remove from group', () => takeOut(m), 'leavebtn'), head.querySelector(':scope > .minbtn'))
    if (min && onCanvas(m) && !m.dataset.hiddenIn) { m.dataset.hiddenIn = g.dataset.id!; m.inert = true }
  }
  hideInk(g, min)
}
/** Nothing left in it: no windows, no drawings. */
export const empty = (g: HTMLElement) => !ids(g).length && !inkIds(g).length
/** A group's windows that exist now (`found`: one byIds() pass for many groups). */
export const members = (g: HTMLElement, found = byIds()) => ids(g).map(id => found.get(id)).filter((el): el is HTMLElement => !!el)
/** Where an item is from its styles alone (no layout read): safe between writes. */
export const styleRect = (el: HTMLElement): Rect => ({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0,
  w: parseFloat(el.style.width) || 0, h: parseFloat(el.style.height) || 0 })
/** Same, measured only where a size isn't set (a note's height follows its text). */
const sizeOf = (el: HTMLElement): Rect => { const r = styleRect(el); return { ...r, w: r.w || el.offsetWidth, h: r.h || el.offsetHeight } }
let tab = 0
const tabH = () => (tab ||= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tab-h')) || 34)

/** Make a group. `members`: ids of the windows it holds; `rect` a saved frame (else an empty one at the view center);
 *  `locked` pinned in place. */
export function group(o: { id?: string; title?: string; members?: string[]; ink?: string[]; rect?: Rect; locked?: boolean } = {}) {
  const c = viewCenter()
  const lock = iconButton(ICON.pin, '', () => setLocked(el, !el.dataset.locked), 'lockbtn')
  const { el, head } = makeWindow({
    kind: 'group', cls: 'group', title: o.title ?? 'Group', minW: MIN.w, minH: MIN.h,
    rect: o.rect ?? { x: c.x - MIN.w / 2, y: c.y - MIN.h / 2, ...MIN },
    actions: [lock, iconButton(ICON.ungroup, 'Ungroup, keep the windows (Ctrl+Shift+G)', () => ungroup(el)),
      iconButton(ICON.x, 'Delete group', () => { deleteGroup(el) }, 'closebtn')],
    // resizing it by hand scales its windows along (scaleMembers); otherwise it wraps them
    onChange: () => { if (el.classList.contains('resizing')) scaleMembers(el); redraw() },
  })
  el.dataset.id = o.id ?? uuid()
  setInkIds(el, o.ink ?? [])
  setIds(el, o.members ?? [])
  setLocked(el, !!o.locked)
  head.addEventListener('pointerenter', outlinesSoon)
  head.addEventListener('pointerleave', outlinesSoon)
  // a resize starts: remember the frame and where its windows were, so they scale from there (see scaleMembers)
  el.addEventListener('pointerdown', e => { if ((e.target as Element).closest('.grip')?.parentElement === el) resizing.set(el, { f: styleRect(el), ms: members(el).map(m => ({ m, r: sizeOf(m) })) }) }, true)
  // locked: the tab doesn't drag (its buttons, renaming and double-click to collapse still work)
  head.addEventListener('pointerdown', e => { if (el.dataset.locked && !(e.target as Element).closest('button')) e.stopImmediatePropagation() }, true)
  return el
}
/** data-locked: the canvas leaves it where it is (movesWith skips it); here, its tab doesn't drag and nothing pushes it. */
function setLocked(g: HTMLElement, on: boolean) {
  if (on) g.dataset.locked = '1'; else delete g.dataset.locked
  setToggle(g, 'lockbtn', on, 'Unlock: let the group move again', 'Lock in place: the group stays put, its windows still move')
  changed()
}
const resizing = new WeakMap<HTMLElement, { f: Rect; ms: { m: HTMLElement; r: Rect }[] }>()
/** While a frame is resized, its windows stretch or shrink with it (positions and sizes), from where they started. */
function scaleMembers(g: HTMLElement) {
  const start = resizing.get(g)
  if (!start) return
  const to = scaleInto(start.ms.map(x => x.r), inner(start.f, PAD, tabH()), inner(styleRect(g), PAD, tabH()))
  start.ms.forEach(({ m }, i) => {
    const r = to[i]
    place(m, r.x, r.y)
    if (m.style.width) m.style.width = `${Math.round(r.w)}px` // a size it didn't set (a note's height) stays its own
    if (m.style.height) m.style.height = `${Math.round(r.h)}px`
  })
  changed() // arrows to the windows follow as they scale
}

// Which windows are in a group: a dotted outline with corner squares round the frame and a thin one round each of
// its windows, while its tab is hovered, while it's selected or dragged, and for a moment after it changes.
const flashing = new Set<HTMLElement>()
export function flash(g: HTMLElement) {
  flashing.add(g)
  outlinesSoon()
  setTimeout(() => { flashing.delete(g); outlinesSoon() }, 1500)
}
const outlinesSoon = perFrame(() => {
  const found = byIds(), on = new Set<HTMLElement>()
  for (const g of groups()) {
    const head = g.querySelector(':scope > .win-h')
    if (!(flashing.has(g) || g.classList.contains('selected') || g.classList.contains('dragging') || head?.matches(':hover'))) continue
    on.add(g)
    members(g, found).forEach(m => on.add(m))
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-outline]')) if (!on.has(el)) delete el.dataset.outline
  for (const el of on) el.dataset.outline = '1'
})
onSelect(outlinesSoon)

/** Add a window to a group (out of any other: a window is in at most one). */
export function join(el: HTMLElement, g: HTMLElement) {
  if (groupOf(el) === g) return // (leaving first would empty a one-window group and take its frame away)
  leave(el)
  setIds(g, [...ids(g), el.dataset.id!])
}
/** Take a window out of its group; the last one out takes the frame with it (no empty frame left behind). */
function leave(el: HTMLElement) {
  const g = groupOf(el)
  if (!g) return
  setIds(g, ids(g).filter(id => id !== el.dataset.id))
  if (empty(g)) ungroup(g)
}

/** Take the frame away and leave the windows where they are. */
export function ungroup(g: HTMLElement) {
  if (g.classList.contains('min')) hide(g, false)
  setInkIds(g, [])
  setIds(g, []) // (takes the windows' Remove from group buttons away)
  forget(g)
  g.remove()
  redraw()
  changed()
}

/** A collapsed group's windows: out of sight, out of the tab order and the minimap, still where they were. */
function hide(g: HTMLElement, on: boolean) {
  // ponytail: pinned windows stay in the sidebar (hiding them would leave a blank gap there); one unpinned while its
  // group is collapsed shows until the group opens again
  for (const m of members(g)) {
    if (on && !onCanvas(m)) continue
    if (on) m.dataset.hiddenIn = g.dataset.id!
    else delete m.dataset.hiddenIn
    m.inert = on
  }
  hideInk(g, on)
  redraw()
  changed()
}
document.addEventListener('collapse', ev => {
  const g = ev.target as HTMLElement
  if (g.dataset?.kind === 'group') hide(g, (ev as CustomEvent<boolean>).detail)
})

async function deleteGroup(g: HTMLElement) {
  const ms = members(g), ink = groupInk(g), n = ms.length, d = ink.length
  const what = [n && `${n} window${n === 1 ? '' : 's'}`, d && `${d} drawing${d === 1 ? '' : 's'}`].filter(Boolean).join(' and ')
  if (what && !await confirmBox(`Delete "${winTitle(g)}" and its ${what}?`, 'To keep them, use Ungroup instead.', 'Delete all')) return
  ungroup(g) // shows hidden windows first, so each one's own remove path finds it
  ms.forEach(removeItem)
  erase(...ink) // (Undo brings them back)
}

/** Slide other groups out of the way of these (just moved, grown or made), each with its windows. */
export function settleFrom(first: HTMLElement[]) {
  const all = groups().filter(onCanvas)
  const frames: Frame[] = all.map(g => ({ id: g.dataset.id!, r: g.classList.contains('min') ? { ...styleRect(g), h: tabH() } : styleRect(g) }))
  const pushes = settle(frames, first.map(g => g.dataset.id!), all.filter(g => g.dataset.locked).map(g => g.dataset.id!))
  if (!pushes.size) return
  const found = byIds()
  for (const [id, d] of pushes) {
    const g = found.get(id)
    if (!g) continue
    for (const el of [g, ...members(g, found)]) { const r = styleRect(el); place(el, r.x + d.dx, r.y + d.dy) }
    const ink = strokeMover(groupInk(g), false) // settling isn't something the user did: nothing to undo
    ink(d.dx, d.dy)
    ink.end()
  }
  redraw()
  changed()
}

// dragging a group's tab brings its windows (hidden ones too, so they're in place when it opens again)
moveWith(el => (el.dataset.kind === 'group' ? members(el) : []))
inkWith(el => (el.dataset.kind === 'group' ? groupInk(el) : [])) // and its drawings

/** Where a pinned window will come back to: a dashed placeholder in the frame, named after it. */
function ghosts(g: HTMLElement, frame: Rect, pinned: { el: HTMLElement; r: Rect }[]) {
  const body = g.querySelector<HTMLElement>(':scope > .win-b')!, top = frame.y + tabH()
  const key = pinned.map(p => `${p.el.dataset.id}:${p.r.x - frame.x},${p.r.y - top},${p.r.w},${p.r.h}:${titleOf(p.el)}`).join('|')
  if (body.dataset.ghosts === key) return
  body.dataset.ghosts = key
  body.replaceChildren(...pinned.map(({ el, r }) => {
    const d = make('div', 'gghost', `${titleOf(el)} · pinned`)
    d.style.cssText = `left:${r.x - frame.x}px;top:${r.y - top}px;width:${r.w}px;height:${r.h}px`
    return d
  }))
}

// always wrap the windows: after anything changes on the canvas, but never mid-drag (the frame holds its shape
// while you drag, so a window can be dragged out of it). Every rect is read first, then the frames are written.
onChange(viewOnly => {
  if (viewOnly || document.querySelector('#world > .item.dragging, #world > .item.resizing')) return
  const gs = groups()
  if (!gs.length) return
  const found = byIds()
  gs.forEach(g => adopt(g, found))
  const fits = gs.filter(g => onCanvas(g) && !g.classList.contains('min')).map(g => {
    // pinned windows (sidebar, floating) count too: rect() gives their spot on the canvas, kept for their return
    const ms = members(g, found).map(el => ({ el, r: rect(el) }))
    const r = frameAround([...ms.map(m => m.r), ...inkRects(g)], PAD, tabH())
    return { g, r, pinned: ms.filter(m => !onCanvas(m.el)) }
  })
  for (const f of fits) ghosts(f.g, f.r ?? styleRect(f.g), f.pinned)
  const grew: HTMLElement[] = []
  for (const { g, r } of fits) {
    if (!r) continue // empty: keeps its size until something is dropped in
    const o = styleRect(g)
    if (o.x === Math.round(r.x) && o.y === Math.round(r.y) && o.w === Math.round(r.w) && o.h === Math.round(r.h)) continue
    place(g, r.x, r.y)
    g.style.width = `${Math.round(r.w)}px`
    g.style.height = `${Math.round(r.h)}px`
    grew.push(g)
  }
  if (!grew.length) return
  redraw()
  settleFrom(grew)
  changed() // the new frames get saved (and fit again: nothing changes, so it stops there)
})

removable('group', g => ungroup(g), 'A group\'s windows stay unless they are selected too.')

export const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

// after a drag: a group pushes others aside; a window that's in no group joins the one its center landed in
document.addEventListener('moved', ev => {
  const el = ev.target as HTMLElement
  if (!el.classList?.contains('item') || !onCanvas(el)) return // a pinned window moved on screen: still in its group
  const moving = movesWith(el), moved = moving.filter(isGroup)
  if (moved.length) settleFrom(moved) // groups that moved (dragged, or along with a selection) push others aside
  if (isGroup(el) || moving.length > 1) return // a whole selection doesn't join or leave
  const from = groupOf(el)
  // a member dropped with its center outside the frame (still its pre-drag shape: it doesn't refit mid-drag) steps
  // out; inside, it stays in and the frame grows to wrap it
  if (from && !inside(styleRect(from), ...center(el))) leave(el)
  if (groupOf(el)) return
  const into = dropTarget(el)
  if (!into) return
  // it gets a spot of its own among the others: where it was dropped if that's free, else the nearest free one
  const room = inner(styleRect(into), PAD, tabH()), p = placeIn(members(into).map(sizeOf), sizeOf(el), room, GAP)
  place(el, p.x, p.y)
  join(el, into)
  flash(into)
  redraw()
  changed()
})

/** The group a window (in no group yet) would join if dropped now: the open one under its center. */
function dropTarget(el: HTMLElement) {
  if (!groupable(el) || groupOf(el)) return undefined
  return groups().find(g => onCanvas(g) && !g.classList.contains('min') && inside(styleRect(g), ...center(el)))
}
const center = (el: HTMLElement): [number, number] => { const r = rect(el); return [r.x + r.w / 2, r.y + r.h / 2] }
// while a window is dragged over a group it could join, the frame lights up ("Drop to add to group")
let over: HTMLElement | null = null
const light = (g: HTMLElement | null) => {
  if (g === over) return
  if (over) delete over.dataset.state
  if (g) g.dataset.state = 'drop'
  over = g
}
addEventListener('pointermove', perFrame(() => {
  const el = document.querySelector<HTMLElement>('#world > .item.dragging')
  light((el && dropTarget(el)) ?? null)
}))
addEventListener('pointerup', () => light(null))
addEventListener('pointercancel', () => light(null))

/** The window's "Remove from group": it steps out to the right of the frame, and the windows left close the gap. */
function takeOut(m: HTMLElement) {
  const g = groupOf(m)
  if (!g) return
  const f = styleRect(g)
  leave(m)
  if (onCanvas(m)) place(m, f.x + f.w + GAP, parseFloat(m.style.top) || 0)
  if (g.isConnected) { // (the last one out took the frame away)
    const ms = members(g), to = compact(ms.map(sizeOf), inner(f, PAD, tabH()), GAP)
    ms.forEach((el, i) => place(el, to[i].x, to[i].y))
  }
  redraw()
  changed() // the frame fits the windows left, then settles
}

interface Saved { id: string; title: string; members: string[]; ink?: string[]; rect: Rect; locked?: boolean }
// phase 2: after the windows (phase 1). Ids of windows not there yet stay (see adopt); removed windows leave (below).
persist('groups',
  () => groups().map((g): Saved => ({ id: g.dataset.id!, title: winTitle(g), members: ids(g), ...(inkIds(g).length ? { ink: inkIds(g) } : {}), rect: savedRect(g), ...(g.dataset.locked ? { locked: true } : {}) })),
  (list: Saved[]) => {
    each(list, s => { const g = group(s); if (s.rect.min) hide(g, true) })
    redraw()
  }, 2)

// a window removed from the canvas (its ×, a delete) leaves its group; one moved to the sidebar or full view is still
// on the page and stays, and so does one only parked (a finished sub-agent's window, a delete that can still be
// undone) until it's dropped for good. ponytail: ids of windows that never show up again stay in the saved list
// (harmless: nothing resolves them); a periodic prune could drop them if lists get long
function gone(el: HTMLElement) {
  const g = groupOf(el)
  if (!g || g === el) return
  setIds(g, ids(g).filter(id => id !== el.dataset.id))
  if (empty(g)) ungroup(g) // (its drawings keep it)
}
new MutationObserver(recs => {
  recs.flatMap(r => [...r.removedNodes]).filter((n): n is HTMLElement => n instanceof HTMLElement && !n.isConnected && !!n.dataset.id && !parked(n)).forEach(gone)
}).observe(world, { childList: true })
onGone(gone)
