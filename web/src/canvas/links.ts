// Your arrows between canvas items (Draw mode's Arrow tool, like Excalidraw's): press on one item, drag, release on
// another. They stay attached as the items move, pin or float. Click one to label it or delete it. Claude sees
// them in canvas_list and can draw them too (canvas_link).
import { make, ICON, iconButton, EDITABLE, closestAt, uuid } from '../lib/dom'
import { persist } from '../lib/store'
import { world, byIds, liveRect, onChange, onCanvas, changed, toWorld, shortId, track, hidden, type Rect } from './canvas'

const NS = 'http://www.w3.org/2000/svg'
// its own layer, big enough to contain every arrow: pointer hits only count inside an SVG's box (session arrows'
// layer is 1px and never needs them). The inner group puts world (0,0) at the layer's center.
const R = 50_000
const layer = world.insertBefore(document.createElementNS(NS, 'svg'), world.children[1] ?? null) as SVGSVGElement
layer.setAttribute('class', 'ulinks')
layer.setAttribute('aria-hidden', 'true')
const svg = layer.appendChild(document.createElementNS(NS, 'g'))
svg.setAttribute('transform', `translate(${R},${R})`)
interface Link { id: string; from: HTMLElement; to: HTMLElement; label: string; color: string; g: SVGGElement; text: HTMLElement }
const links: Link[] = []
let selected: Link | null = null

/** A window's rect below its tab, which is hidden unless hovered. Items without a tab (notes, file chips) and a
 *  collapsed window (only its tab) stay whole. */
let tab = 0
function body(el: HTMLElement): Rect {
  const r = liveRect(el)
  if (!el.classList.contains('win') || el.classList.contains('min')) return r
  tab ||= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tab-h')) || 34
  return { ...r, y: r.y + tab, h: r.h - tab }
}

/** Where an arrow between two rects starts and ends: the sides facing each other, and a gentle curve. */
function curve(ab: Rect, bb: Rect) {
  const ca = { x: ab.x + ab.w / 2, y: ab.y + ab.h / 2 }, cb = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }
  const across = Math.abs(cb.x - ca.x) / (ab.w + bb.w) >= Math.abs(cb.y - ca.y) / (ab.h + bb.h) // side by side, or stacked
  const s = across ? { x: cb.x > ca.x ? ab.x + ab.w : ab.x, y: ca.y } : { x: ca.x, y: cb.y > ca.y ? ab.y + ab.h : ab.y }
  const t = across ? { x: cb.x > ca.x ? bb.x - 6 : bb.x + bb.w + 6, y: cb.y } : { x: cb.x, y: cb.y > ca.y ? bb.y - 6 : bb.y + bb.h + 6 }
  const d = Math.max(40, (across ? Math.abs(t.x - s.x) : Math.abs(t.y - s.y)) / 2)
  const c1 = across ? { x: s.x + Math.sign(t.x - s.x) * d, y: s.y } : { x: s.x, y: s.y + Math.sign(t.y - s.y) * d }
  const c2 = across ? { x: t.x - Math.sign(t.x - s.x) * d, y: t.y } : { x: t.x, y: t.y - Math.sign(t.y - s.y) * d }
  return { s, c1, c2, t }
}
/** The path (and its arrowhead, aimed along the curve's end) for a curve. */
function shape(k: ReturnType<typeof curve>) {
  const { s, c1, c2, t } = k, ang = Math.atan2(t.y - c2.y, t.x - c2.x), L = 11, W = 0.45
  const head = `M${t.x + Math.cos(ang) * 4},${t.y + Math.sin(ang) * 4} L${t.x - Math.cos(ang - W) * L},${t.y - Math.sin(ang - W) * L} L${t.x - Math.cos(ang + W) * L},${t.y - Math.sin(ang + W) * L}Z`
  return { line: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`, head, mid: { x: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8, y: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 } }
}

/** Measure first (layout reads), then `write` (DOM writes): so a batch of arrows lays out once, not per arrow. */
function measure(l: Link) {
  const hide = l.from.classList.contains('full') || l.to.classList.contains('full') || hidden(l.from) || hidden(l.to)
  const k = hide ? null : shape(curve(body(l.from), body(l.to)))
  return () => write(l, k)
}
const draw = (l: Link) => measure(l)()
function write(l: Link, k: ReturnType<typeof shape> | null) {
  l.g.style.display = l.text.style.display = k ? '' : 'none'
  if (!k) return
  const { line, head, mid } = k
  const [hit, path, tip] = l.g.children as unknown as SVGPathElement[]
  hit.setAttribute('d', line)
  path.setAttribute('d', line)
  tip.setAttribute('d', head)
  l.text.style.left = `${mid.x}px`
  l.text.style.top = `${mid.y}px`
  l.text.hidden = !l.label && selected !== l
}

/** An arrow's SVG: a wide invisible hit path, the line, and its head. */
function group(cls: string) {
  const g = svg.appendChild(document.createElementNS(NS, 'g')) as SVGGElement
  g.setAttribute('class', cls)
  for (const c of ['hit', 'line', 'tip']) g.appendChild(document.createElementNS(NS, 'path')).setAttribute('class', c)
  return g
}

export function addLink(from: HTMLElement, to: HTMLElement, label = '', color = 'ink', id: string = uuid()): Link {
  const g = group(`ulink c-${color}`)
  const text = world.appendChild(make('div', 'ulabel'))
  const l: Link = { id, from, to, label, color, g, text }
  text.textContent = label
  g.addEventListener('pointerdown', e => { if (e.button === 0) { e.stopPropagation(); select(l) } })
  text.addEventListener('pointerdown', e => { e.stopPropagation(); select(l) })
  links.push(l)
  draw(l)
  changed()
  return l
}

function removeLink(l: Link) {
  if (selected === l) select(null)
  l.g.remove()
  l.text.remove()
  links.splice(links.indexOf(l), 1)
  changed()
}

/** An item is leaving (maybe for a moment: a delete that can be undone): its arrows go now. Returns what puts them
 *  back. */
export function dropLinks(el: HTMLElement) {
  const mine = links.filter(l => l.from === el || l.to === el)
  mine.forEach(removeLink)
  return () => mine.forEach(l => { if (l.from.isConnected && l.to.isConnected) addLink(l.from, l.to, l.label, l.color, l.id) })
}

/* ---------- selecting: the label becomes editable, with a delete button ---------- */
const del = iconButton(ICON.x, 'Delete arrow (Delete)', () => { if (selected) removeLink(selected) }, 'udel')
del.addEventListener('pointerdown', e => e.stopPropagation()) // else the canvas pan captures the pointer and the click never lands here
function select(l: Link | null) {
  if (selected === l) return
  if (selected) {
    selected.g.classList.remove('on')
    selected.text.classList.remove('on')
    selected.text.contentEditable = 'false'
    selected.label = (selected.text.textContent ?? '').trim()
    selected.text.textContent = selected.label
    draw(selected)
    changed()
  }
  selected = l
  del.remove()
  if (!l) return
  l.g.classList.add('on')
  l.text.classList.add('on')
  l.text.contentEditable = 'plaintext-only'
  l.text.dataset.placeholder = 'Label'
  l.text.after(del)
  del.style.left = l.text.style.left
  del.style.top = l.text.style.top
  draw(l)
}
addEventListener('pointerdown', e => { if (selected && !(e.target as Element).closest('.ulabel.on, .udel')) select(null) }, true)
addEventListener('keydown', e => {
  if (!selected) return
  const typing = e.target === selected.text
  if (!typing && e.target instanceof Element && e.target.closest(EDITABLE)) return // typing elsewhere: not the arrow's key
  if (typing) { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); select(null) } return }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeLink(selected) }
  else if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); select(null) }
})

/* ---------- drawing one: press on an item, release on another (the Arrow tool in Draw mode) ---------- */
const itemAt = (x: number, y: number) => closestAt(x, y, '.item')

/** Start an arrow from the item under this press; follows the pointer until release. */
export function startLink(e: PointerEvent, color: string, over: HTMLElement) {
  const from = itemAt(e.clientX, e.clientY)
  if (!from) return
  const g = group(`ulink c-${color} drafting`)
  const [, line, tip] = g.children as unknown as SVGPathElement[]
  const move = (ev: PointerEvent) => {
    const p = toWorld(ev.clientX, ev.clientY), to = itemAt(ev.clientX, ev.clientY)
    const k = to && to !== from ? curve(body(from), body(to)) : curve(body(from), { x: p.x, y: p.y, w: 0, h: 0 })
    const { line: d, head } = shape(k)
    line.setAttribute('d', d)
    tip.setAttribute('d', head)
  }
  track(over, e, (_x, _y, ev) => move(ev), ev => {
    g.remove()
    if (ev.type !== 'pointerup') return // cancelled (a touch the browser took over): no arrow
    const to = itemAt(ev.clientX, ev.clientY)
    if (to && to !== from) { select(addLink(from, to, '', color)); selected?.text.focus() } // type a label now, or just move on
  }, { keep: true })
  move(e)
}

/* ---------- keeping up, saving, and what Claude sees ---------- */
onChange(viewOnly => {
  if (!viewOnly && waiting.length && performance.now() - tried > 1000) adopt() // at most once a second: it queries every item
  const todo = []
  for (const l of [...links]) {
    if (!l.from.isConnected || !l.to.isConnected) { removeLink(l); continue } // an end left the canvas
    if (viewOnly && onCanvas(l.from) && onCanvas(l.to)) continue // world coordinates: a pan or zoom doesn't move it
    todo.push(measure(l))
  }
  todo.forEach(w => w())
})
const idOf = (el: HTMLElement) => el.dataset.id ?? ''
export const userLinks = () => links.map(l => ({ from: shortId(idOf(l.from)), to: shortId(idOf(l.to)), ...(l.label ? { label: l.label } : {}) }))
type Saved = { id: string; from: string; to: string; label: string; color: string }
// saved arrows whose ends aren't on the canvas (yet): kept and written back, so a window that comes late (or failed
// to load once) doesn't lose its arrows at the next save; attached when both ends show up
// ponytail: an arrow whose end was deleted in another tab waits forever (a few bytes); prune by age if that grows
let waiting: Saved[] = [], tried = 0
function adopt() {
  tried = performance.now()
  const ids = byIds()
  waiting = waiting.filter(s => {
    const a = ids.get(s.from), b = ids.get(s.to)
    if (a && b) addLink(a, b, s.label, s.color, s.id)
    return !(a && b)
  })
}
persist('links',
  () => [...links.map(l => ({ id: l.id, from: idOf(l.from), to: idOf(l.to), label: l.label, color: l.color })), ...waiting],
  (list: Saved[]) => { waiting = list; adopt() }, 2)
