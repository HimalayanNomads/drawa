// Ink on a chat log (a host marked data-ink-rows) follows the row it was drawn over: rows off screen are laid out
// at an estimated height (content-visibility) until they render, and a replay can regroup them.
import { perFrame } from '../lib/dom'
import { changed } from './canvas'
import { strokes, type Stroke } from './ink'

const rows = (host: HTMLElement) => [...host.children].filter(c => !c.matches('svg.ink-local')) as HTMLElement[]
const rowKey = (row: Element) => (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
/** The stroke's row: the one it's already on while that's still in the log; else by the row's id, or by index checked
 *  against the row's text (rows can shift: an empty state removed, a replay that groups differently); else the row
 *  with that text nearest the old index. Only the rare re-find reads row texts. */
function rowOf(s: Stroke, host: HTMLElement) {
  if (s.row?.parentElement === host) return s.row
  const list = rows(host), at = list[s.a!]
  let best = s.rid ? list.find(r => r.dataset.id === s.rid) : undefined
  if (!best && (!s.k || (at && rowKey(at) === s.k))) best = at
  if (!best) {
    let bd = Infinity
    list.forEach((r, i) => { if (Math.abs(i - s.a!) < bd && rowKey(r) === s.k) { best = r; bd = Math.abs(i - s.a!) } })
  }
  return (s.row = best ?? at)
}
export const onHost = (host: HTMLElement) => strokes.filter(s => s.host === host)
/** Keep a rows host's strokes on their rows: reads each one's row position, then writes (no layout in between). */
export function follow(host: HTMLElement) {
  const mine = onHost(host).filter(s => s.a != null && s.el)
  const dy = mine.map(s => { const row = rowOf(s, host); return row ? row.offsetTop - s.o! : 0 })
  mine.forEach((s, i) => s.el!.setAttribute('transform', `translate(0 ${dy[i]})`))
}
/** Re-follow whenever any row changes size: rows off screen render at their real height only after a scroll has
 *  already happened, so scroll events alone miss the last change. ponytail: observes every row of an inked log (one
 *  observer, cheap per row); only rows above a stroke matter, if logs of 10k+ rows ever show up. */
const watchers = new Map<HTMLElement, { sizes: ResizeObserver; added: MutationObserver }>()
export function watchRows(host: HTMLElement) {
  const soon = perFrame(() => follow(host))
  // in the observer itself, not a frame later: it runs after layout and before paint, so ink never lags a frame
  const sizes = new ResizeObserver(() => { if (host.isConnected) follow(host); else unwatch(host) })
  sizes.observe(host)
  rows(host).forEach(r => sizes.observe(r))
  const added = new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(n => { if (n instanceof HTMLElement) sizes.observe(n) }); soon() })
  added.observe(host, { childList: true })
  watchers.set(host, { sizes, added })
}
export function unwatch(host: HTMLElement) {
  const w = watchers.get(host)
  if (!w) return
  w.sizes.disconnect()
  w.added.disconnect()
  watchers.delete(host)
}

/** The row of a rows host under a point, and where it sits now. */
export function rowAt(host: HTMLElement | undefined, e: { clientX: number; clientY: number }): { a?: number; o?: number; k?: string; rid?: string } {
  if (!host || !('inkRows' in host.dataset)) return {}
  const list = rows(host)
  const row = document.elementsFromPoint(e.clientX, e.clientY).map(el => list.find(r => r.contains(el))).find(Boolean)
    ?? list.findLast(r => r.getBoundingClientRect().top <= e.clientY) // between rows or below the last one
  return row ? { a: list.indexOf(row), o: row.offsetTop, k: rowKey(row), ...(row.dataset.id ? { rid: row.dataset.id } : {}) } : {}
}

/** Give an old stroke on a rows host the row it sits on now, so it stays with that row from here on. */
export function adopt(s: Stroke) {
  const y = s.p[0][1], list = rows(s.host!)
  const row = list.findLast(r => r.offsetTop <= y) ?? list[0]
  if (!row) return
  s.a = list.indexOf(row)
  s.o = row.offsetTop
  s.k = rowKey(row)
  changed()
}
