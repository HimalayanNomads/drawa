// Groups (issue #14): a named frame that owns a set of windows. Members stay ordinary canvas items; the group keeps
// their ids in data-members, brings them along when its tab is dragged (moveWith), always wraps them (auto-fit,
// frozen while anything is dragged), and never overlaps another group (groupgeom.ts settles that). A window joins
// by being dropped into a frame, and leaves by being dropped outside it or through its tab's Remove from group button.
// Drawings on the canvas belong to groups too (groupink.ts).
import { make, ICON, iconButton, button, confirmBox, notice, uuid, perFrame } from '../lib/dom'
import { persist, each } from '../lib/store'
import { world, toWorld, items, byIds, rect, liveRect, savedRect, place, changed, onChange, onCanvas, moveWith, movesWith, viewCenter, parked, onGone, draggable, nearestFree, spawnIn, type Rect } from '../canvas/canvas'
import { makeWindow, winTitle, titleOf, removeUndoably, undoable } from '../canvas/window'
import { referable } from '../canvas/refs'
import { setToggle } from '../canvas/dock'
import { redraw, forget } from '../canvas/graph'
import { removable, removeItem, onSelect, lockedHint } from '../canvas/select'
import { handDrag } from '../canvas/mode'
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
    // frame: its empty space is canvas to pan or box-select in (canvas/nav.ts, canvas/select.ts)
    kind: 'group', cls: 'group frame', title: o.title ?? 'Group', minW: MIN.w, minH: MIN.h,
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
  // locked: the tab doesn't drag (its buttons, renaming and double-click to collapse still work); a drag says why
  head.addEventListener('pointerdown', e => {
    if (!el.dataset.locked || (e.target as Element).closest('button')) return
    e.stopImmediatePropagation()
    addEventListener('pointerup', u => { if (Math.hypot(u.clientX - e.clientX, u.clientY - e.clientY) > 4) lockedHint() }, { once: true })
  }, true)
  // dragging its empty space drags the group (Shift+drag: a selection box; Hand mode or locked: pans, canvas/nav.ts)
  draggable(el, el, redraw, undefined, e => e.target === el && !e.shiftKey && !handDrag() && !el.dataset.locked)
  // a press on its empty space never starts a text selection: a double-click or a drag there selected the windows' text
  el.addEventListener('mousedown', e => { if (e.target === el) e.preventDefault() })
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
  if (groupOf(el) === g) return
  leave(el)
  setIds(g, [...ids(g), el.dataset.id!])
}
/** Take a window out of its group; the last one out takes the frame with it (no empty frame is kept), with Undo
 *  bringing the frame back with the window in it. Returns whether the frame went. ponytail: a window that joins another
 *  group before that Undo is listed by both; the later one wins groupOf. */
function leave(el: HTMLElement) {
  const g = groupOf(el)
  if (!g) return false
  if (lastOne(g, el)) { removeUndoably(g); return true } // (still listed: Undo puts it back in)
  setIds(g, ids(g).filter(id => id !== el.dataset.id))
  return false
}
/** Nothing but `el` keeps `g` (no other window on the page, no drawing). */
const lastOne = (g: HTMLElement, el: HTMLElement) => !groupInk(g).length && members(g).every(m => m === el)

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
  if (g.classList.contains('min')) hide(g, false) // so each window's own remove path finds it (it hides again on Undo)
  ms.forEach(removeItem)
  erase(...ink) // (Undo in Draw mode brings them back)
  removeUndoably(g) // one Undo brings the frame back with its windows, title, lock and members
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

removable('group', g => removeUndoably(g), 'A group\'s windows stay unless they are selected too.')

export const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

// after a drag: a group pushes others aside; a window that's in no group joins the one its center landed in
document.addEventListener('moved', ev => {
  const el = ev.target as HTMLElement
  if (!el.classList?.contains('item') || !onCanvas(el)) return // a pinned window moved on screen: still in its group
  const moving = movesWith(el), moved = moving.filter(isGroup)
  if (moved.length) settleFrom(moved) // groups that moved (dragged, or along with a selection) push others aside
  if (isGroup(el)) return
  if (moving.length > 1) { moving.forEach(m => dropIn(m)); return } // a selection: its loose windows join where they land; none leave
  const from = groupOf(el)
  // a member dropped with its center outside the frame (still its pre-drag shape: it doesn't refit mid-drag) steps
  // out at once; its Undo puts it back and lets the frame grow round it
  if (from && !inside(styleRect(from), ...center(el))) {
    const went = leave(el) // the frame's own Undo puts the window back in: one Undo, not two
    redraw()
    changed()
    if (!went) {
      const n = notice('') // looks like the delete Undo (canvas/window.ts)
      n.classList.add('undo')
      n.replaceChildren(make('span', '', `Moved out of "${winTitle(from)}"`), button('Undo', '', () => {
        n.remove()
        if (!from.isConnected || !el.isConnected || groupOf(el)) return
        join(el, from)
        redraw()
        changed()
      }))
      setTimeout(() => n.remove(), 8000)
    }
  }
  dropIn(el, from) // (not back into the one it left: Undo does that)
})

/** A window in no group joins the one it was dropped on, at a spot of its own among the others: where it was dropped
 *  if that's free, else the nearest free one. A collapsed group takes it in out of sight. */
function dropIn(el: HTMLElement, not?: HTMLElement) {
  const into = dropTarget(el)
  if (!into || into === not) return
  const room = inner(styleRect(into), PAD, tabH()), ms = members(into).map(sizeOf), min = into.classList.contains('min')
  // a collapsed group was aimed at by its tab, so the drop spot means nothing: below its windows, inside the frame
  const p = min ? { x: room.x, y: Math.max(room.y, ...ms.map(o => o.y + o.h + GAP)) } : placeIn(ms, sizeOf(el), room, GAP)
  place(el, p.x, p.y)
  join(el, into)
  flash(into)
  if (min) { const n = notice(`Added to "${winTitle(into)}" (collapsed)`); setTimeout(() => n.remove(), 4000) }
  redraw()
  changed()
}

/** The group a window (in no group yet) would join if dropped now: the open one under its center, or the collapsed
 *  one whose tab is under the pointer (a window's center is rarely over a tab). */
function dropTarget(el: HTMLElement) {
  if (!groupable(el) || groupOf(el)) return undefined
  return groups().find(g => onCanvas(g) && (g.classList.contains('min') ? inside(liveRect(g), pointer.x, pointer.y) : inside(styleRect(g), ...center(el))))
}
let pointer = { x: 0, y: 0 } // in canvas units, while something is dragged
const center = (el: HTMLElement): [number, number] => { const r = rect(el); return [r.x + r.w / 2, r.y + r.h / 2] }
// while a window is dragged over a group it could join, the frame lights up ("Drop to add to group")
let over: HTMLElement | null = null
const light = (g: HTMLElement | null) => {
  if (g === over) return
  if (over) delete over.dataset.state
  if (g) g.dataset.state = 'drop'
  over = g
}
addEventListener('pointermove', perFrame((e: PointerEvent) => {
  const el = document.querySelector<HTMLElement>('#world > .item.dragging')
  if (el) pointer = toWorld(e.clientX, e.clientY)
  light((el && dropTarget(el)) ?? null)
}))
addEventListener('pointerup', () => light(null))
addEventListener('pointercancel', () => light(null))

/** The window's "Remove from group": it steps out to the right of the frame, and the windows left close the gap. */
function takeOut(m: HTMLElement) {
  const g = groupOf(m)
  if (!g) return
  const f = styleRect(g), r = sizeOf(m)
  const went = leave(m)
  if (onCanvas(m)) { const p = nearestFree({ ...r, x: f.x + f.w + GAP }); place(m, p.x, p.y) } // not on top of another window
  const ms = went ? [] : members(g), to = compact(ms.map(sizeOf), inner(f, PAD, tabH()), GAP)
  ms.forEach((el, i) => place(el, to[i].x, to[i].y))
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
// a window made beside a member (an agent, a diagram, canvas_create near it) or in a frame (a picture dropped or
// pasted there) is made inside its group: spotBeside / spotAt ask here for the spot, and the window joins when it
// shows up there
const spawning: { g: HTMLElement; x: number; y: number }[] = []
spawnIn((from, w, h) => {
  const item = from instanceof HTMLElement, open = (g: HTMLElement) => onCanvas(g) && !g.classList.contains('min')
  // a spot handed out already (canvas_create's, asked again by addImage at the picture's real size) keeps its group,
  // even when that spot is outside the frame; any other is in a frame by its corner (where a drop aimed) or its
  // middle (a paste centered on the view)
  const pending = item ? undefined : spawning.find(s => s.x === Math.round(from.x) && s.y === Math.round(from.y))
  const g = item ? groupOf(from) : pending?.g ?? groups().find(g => open(g) && [[from.x, from.y], [from.x + w / 2, from.y + h / 2]].some(([x, y]) => inside(styleRect(g), x, y)))
  if (!g || !open(g)) return null
  const f = item ? rect(from) : from, want = item ? { x: f.x + f.w + GAP, y: f.y, w, h } : from
  const r = placeIn(members(g).map(sizeOf), want, inner(styleRect(g), PAD, tabH()), GAP)
  const x = Math.round(r.x), y = Math.round(r.y)
  if (pending) { pending.x = x; pending.y = y; return r }
  const at = { g, x, y }
  spawning.push(at)
  setTimeout(() => spawning.splice(spawning.indexOf(at) >>> 0, 1), 10000) // made elsewhere after all (a saved spot won)
  return r
})
function arrived(el: HTMLElement) {
  const i = spawning.findIndex(s => s.x === parseFloat(el.style.left) && s.y === parseFloat(el.style.top))
  if (i < 0 || !groupable(el) || groupOf(el) || !spawning[i].g.isConnected) return
  join(el, spawning.splice(i, 1)[0].g)
}
/** A frame taken off the page for now (deleted, Undo still showing): its windows lose what membership gave them
 *  (adopt gives it back if it returns). */
function release(g: HTMLElement) {
  for (const m of members(g)) {
    m.querySelector(':scope > .win-h .leavebtn')?.remove()
    if (m.dataset.hiddenIn === g.dataset.id) { delete m.dataset.hiddenIn; m.inert = false }
  }
  hideInk(g, false)
}

function gone(el: HTMLElement) {
  const g = groupOf(el)
  if (!g || g === el) return
  if (lastOne(g, el)) removeUndoably(g) // removed some other way than its ×: the frame still doesn't stay empty
  else setIds(g, ids(g).filter(id => id !== el.dataset.id))
}
/** A last window deleted with its × (Undo still showing): the frame goes in the same Undo, keeping it listed. A window
 *  parked for another reason (a finished sub-agent's) leaves its frame be. */
function deleting(el: HTMLElement) {
  const g = groupOf(el)
  if (g && g !== el && undoable(el) && lastOne(g, el)) removeUndoably(g)
}
const isEl = (n: Node): n is HTMLElement => n instanceof HTMLElement && !!n.dataset.id
new MutationObserver(recs => {
  const out = recs.flatMap(r => [...r.removedNodes]).filter(isEl), added = recs.flatMap(r => [...r.addedNodes]).filter(isEl)
  if ([...out, ...added].some(isGroup)) index = null // a frame parked or back: who's in which group changed
  out.filter(n => !n.isConnected && parked(n) && isGroup(n)).forEach(release)
  out.filter(n => !n.isConnected && !parked(n)).forEach(gone)
  out.filter(n => !n.isConnected && parked(n) && !isGroup(n)).forEach(deleting)
  added.filter(n => n.isConnected).forEach(arrived)
}).observe(world, { childList: true })
onGone(gone)
