// Text you pinned to the canvas stays marked where it came from (a reply, a plan, a file in the inspector...):
// a soft highlight drawn with the CSS Custom Highlight API, so the chat's DOM is never touched (streaming and
// content-visibility keep working). Click marked text to jump to its snippet. A mark is saved with its snippet as
// host key + exact text + a little text before it, and found again by text search when the host is back.
import { ping, perFrame, reducedMotion } from '../lib/dom'
import { tipText, tipAt, hideTip } from '../lib/tooltip'
import { onChange, onCanvas, centerOn, front } from '../canvas/canvas'
import { winTitle } from '../canvas/refs'

/** Where a mark lives, saved with the snippet: `h` host key (a data-ink key, or f:<path> for the inspector). */
export interface MarkSrc { h: string; text: string; before: string }
interface Mark { snip: HTMLElement; src: MarkSrc | null; host: HTMLElement | null; text: string; before: string; range: Range | null; miss?: Miss }
/** A search that found nothing: the host's size then, so the next search waits for new content and reads only that. */
interface Miss { host: HTMLElement; kids: number; tail: number; n: number }
const MISSES = 40 // then the mark stays unmarked until reload (the text is gone for good, or reworded)
const marks: Mark[] = []
const hl = typeof Highlight === 'function' ? new Highlight() : null
if (hl) CSS.highlights.set('pinned', hl)

/* ---------- hosts: something with a stable name, so the mark can come back after a reload ---------- */
/** The path of the file open in the inspector ('' when none). */
export const inspectorPath = () => tipText(document.querySelector('#ipath :is([title], [data-tip])'))
function hostOf(node: Node): { el: HTMLElement; key: string | null } | null {
  const el = node instanceof Element ? node : node.parentElement
  const src = el?.closest<HTMLElement>('#viewer .src')
  if (src) return { el: src, key: 'f:' + inspectorPath() }
  const ink = el?.closest<HTMLElement>('[data-ink]:not(.item)') // a chat log, a plan's text (not a whole window)
  if (ink) return { el: ink, key: ink.dataset.ink! }
  const any = el?.closest<HTMLElement>('.win-b, pre, #inspector') // no stable name: marked until reload
  return any ? { el: any, key: null } : null
}
function findHost(key: string): HTMLElement | null {
  if (key.startsWith('f:')) return inspectorPath() === key.slice(2) ? document.querySelector('#viewer .src') : null
  return document.querySelector(`[data-ink="${CSS.escape(key)}"]`)
}

/** What to remember about a selection, and its host. Range.toString() is the text nodes' own text (unlike a
 *  Selection's, which adds line breaks), so it can be found again in the host's textContent. */
export function markOf(range: Range): { src: MarkSrc | null; host: HTMLElement; text: string; before: string } | null {
  const h = hostOf(range.commonAncestorContainer)
  if (!h || !h.el.contains(range.startContainer)) return null
  const text = range.toString(), before = textBefore(h.el, range).slice(-40)
  return { src: h.key ? { h: h.key, text, before } : null, host: h.el, text, before }
}

/** The text of `el` before where `range` starts. */
export function textBefore(el: Node, range: Range) {
  const pre = document.createRange()
  pre.setStart(el, 0)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString()
}

/* ---------- finding the text again ---------- */
/** A range over [start, end) character offsets of el's text (from `from`, an element in it, when given). */
function rangeAt(el: HTMLElement, start: number, end: number, from?: Element): Range | null {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), r = document.createRange()
  if (from) w.currentNode = from
  let at = 0, began = false
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    const len = n.data.length
    if (!began && start <= at + len) { r.setStart(n, start - at); began = true }
    if (began && end <= at + len) { r.setEnd(n, end - at); return r }
    at += len
  }
  return null
}
function resolve(m: Mark) {
  if (m.range && !m.range.collapsed && m.range.toString() === m.text && m.host?.contains(m.range.startContainer)) return
  m.range = null
  if (m.src && !m.host?.isConnected) m.host = findHost(m.src.h)
  if (!m.host?.isConnected) return
  watch(m.host)
  // after a miss, search again only when the host grew (a row added, or its last row streaming), and only from
  // its last row seen then: a streaming chat would otherwise re-read its whole text every 250ms
  // (the ink layer isn't a row: a file preview's is its last child, while its text is replaced before it)
  const host = m.host, kids = host.childElementCount
  let last = host.lastElementChild
  if (last?.matches('svg.ink-local')) last = last.previousElementSibling
  const tail = last?.textContent?.length ?? 0
  const miss = m.miss?.host === host ? m.miss : undefined
  if (miss && (miss.n >= MISSES || (kids <= miss.kids && tail <= miss.tail))) return
  let from = miss ? host.children[Math.max(0, miss.kids - 1)] : undefined
  if (from?.matches('svg.ink-local')) from = from.previousElementSibling ?? undefined
  let all: string
  if (from) { const r = document.createRange(); r.setStartBefore(from); r.setEnd(host, host.childNodes.length); all = r.toString() }
  else all = host.textContent ?? ''
  let i = all.indexOf(m.before + m.text)
  // the text around it changed: fall back to the text alone, only when that's unambiguous (long, and there once)
  if (i >= 0) i += m.before.length
  else if (m.text.length >= 20 && (i = all.indexOf(m.text)) >= 0 && all.indexOf(m.text, i + 1) >= 0) i = -1
  if (i >= 0) m.range = rangeAt(host, i, i + m.text.length, from)
  m.miss = m.range ? undefined : { host, kids, tail, n: (miss?.n ?? 0) + 1 }
}

let timer = 0, tries = 0
/** Rebuild the highlight: drop marks whose snippet is gone, find the ones whose text moved or re-rendered. */
function refresh() {
  for (const m of [...marks]) if (!m.snip.isConnected) marks.splice(marks.indexOf(m), 1)
  marks.forEach(resolve)
  hl?.clear()
  for (const m of marks) if (m.range) hl?.add(m.range)
  for (const [host, obs] of watched) if (!marks.some(m => m.host === host)) { obs.disconnect(); watched.delete(host) }
  // a host that isn't there yet (a session still replaying after a reload): look again shortly, for up to ~30s;
  // after that only a change on the canvas (onChange) or in a watched host looks again
  clearTimeout(timer)
  if (marks.some(m => !m.range && m.src) && ++tries <= 30) timer = setTimeout(refresh, 1000)
}
let soon = 0
const later = () => { soon ||= window.setTimeout(() => { soon = 0; refresh() }, 250) } // streaming mutates often
const watched = new Map<HTMLElement, MutationObserver>() // disconnected once no mark lives in the host
function watch(host: HTMLElement) {
  if (watched.has(host)) return
  const obs = new MutationObserver(later)
  obs.observe(host, { childList: true, subtree: true, characterData: true })
  watched.set(host, obs)
}
onChange(viewOnly => { if (!viewOnly) later() }) // a snippet removed, windows restored (a pan changes nothing here)

/** Mark the text a snippet came from. */
export function addMark(snip: HTMLElement, m: { src: MarkSrc | null; host?: HTMLElement | null; text: string; before: string }) {
  if (!m.text.trim()) return
  marks.push({ snip, src: m.src, host: m.host ?? null, text: m.text, before: m.before, range: null })
  tries = 0
  refresh()
}
export const markSrcOf = (snip: HTMLElement) => marks.find(m => m.snip === snip)?.src ?? undefined

/* ---------- pointing at marked text: a hint, and a click jumps to the snippet ---------- */
function markAt(x: number, y: number): Mark | undefined {
  if (!marks.length) return
  const p = document.caretPositionFromPoint?.(x, y), r = p ? null : document.caretRangeFromPoint?.(x, y)
  const node = p?.offsetNode ?? r?.startContainer, off = p?.offset ?? r?.startOffset ?? 0
  if (!node) return
  return marks.find(m => { try { return !!m.range?.isPointInRange(node, off) && m.range.getBoundingClientRect().width > 0 } catch { return false } })
}
let over: HTMLElement | null = null
const hover = perFrame((e: PointerEvent) => {
  const m = markAt(e.clientX, e.clientY), t = e.target instanceof HTMLElement ? e.target : null
  over?.classList.remove('pinhover')
  over = m ? t : null
  over?.classList.add('pinhover')
  if (m) tipAt(`Pinned to canvas as “${winTitle(m.snip) || 'snippet'}”. Click to show it.`, e.clientX, e.clientY)
  else hideTip()
})
addEventListener('pointermove', e => { if (marks.length && !e.buttons) hover(e) }, { passive: true })
addEventListener('click', e => {
  if (!getSelection()?.isCollapsed) return // finishing a selection isn't a click on the mark
  const m = markAt(e.clientX, e.clientY)
  if (!m) return
  hideTip()
  const s = m.snip
  if (onCanvas(s)) { front(s); centerOn(s) } else s.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }) // pinned/floating/full view
  ping(s)
})
