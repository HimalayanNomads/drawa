// Find a window: Ctrl/Cmd+K (or the toolbar's search button) lists everything on the canvas; type to filter by
// title and content, Enter flies to it, brings it to the front and expands it if it was collapsed. Project files
// matching the query are listed below the windows, the highlighted one previewed beside the list; picking one opens
// it in a window (see fileOpener).
import { api, q as enc } from '../lib/api'
import { enhanceMarked } from '../lib/markdown'
import { $, make, ping, reducedMotion } from '../lib/dom'
import { items, centerOn, front, onCanvas, hidden } from './canvas'
import { refIcon, kindName } from './refs'
import { titleOf, expand, focusInput } from './window'

const box = document.body.appendChild(make('div', 'finder'))
box.hidden = true
box.setAttribute('role', 'dialog')
box.setAttribute('aria-label', 'Find a window or file')
const input = box.appendChild(make('input'))
input.placeholder = 'Find a window or a file'
input.setAttribute('aria-label', 'Find a window or file')
const body = box.appendChild(make('div', 'finder-b'))
const list = body.appendChild(make('div', 'finder-list'))
list.setAttribute('role', 'listbox')
const peekBox = body.appendChild(make('div', 'finder-peek'))
peekBox.onmousedown = e => e.preventDefault() // keeps focus in the input, whose blur closes the finder (wheel scrolling still works)

const TEXT = 40_000
/** What a window's content search covers: a chat log's newest ~40k characters (read row by row from the end, so a
 *  huge transcript isn't turned into one string), other windows' first 40k. */
function textOf(el: HTMLElement) {
  const log = el.querySelector('.log')
  if (!log) return (el.querySelector('.win-b, .ntext')?.textContent ?? el.textContent ?? '').slice(0, TEXT)
  const parts: string[] = []
  let n = 0
  for (let r = log.lastElementChild; r && n < TEXT; r = r.previousElementSibling) { const t = r.textContent ?? ''; parts.push(t); n += t.length }
  return parts.reverse().join('\n').slice(-TEXT)
}

interface Hit { el?: HTMLElement; path?: string; title: string; kind: string; excerpt: string; score: number }
interface Entry { el: HTMLElement; title: string; t: string; kind: string; body: string; b: string }
let hits: Hit[] = [], sel = 0, index: Entry[] = []
/** Read every window's title and text once, when the finder opens: typing then only filters this. */
function build() {
  // most recently brought to the front first: that's the order you used them in
  index = items().filter(el => !hidden(el)).sort( // a collapsed group's windows: find the group instead
    (a, b) => (Number(b.style.zIndex) || 0) - (Number(a.style.zIndex) || 0)).map(el => {
    const title = titleOf(el) || kindName(el.dataset.kind ?? ''), body = textOf(el)
    return { el, title, t: title.toLowerCase(), kind: el.dataset.kind ?? '', body, b: body.toLowerCase() }
  })
}

let openFile: ((path: string) => HTMLElement) | null = null, peekFile: ((path: string) => Promise<HTMLElement>) | null = null
/** List project files too: picking one calls `open`, which returns its window (an open one, or a new one); the
 *  highlighted one is shown beside the list with what `peek` draws. */
export const fileOpener = (open: typeof openFile, peek: typeof peekFile) => { openFile = open; peekFile = peek }

// the highlighted file's preview, kept while the finder is open so going back to a file is instant.
// ponytail: kept unbounded until close (a few hundred files at most per open); an LRU if that grows.
let peeked = ''
const peeks = new Map<string, Promise<HTMLElement>>()
const peekOf = (path: string) => { let v = peeks.get(path); if (!v) peeks.set(path, v = peekFile!(path)); return v }
function peek() {
  box.classList.toggle('peeking', !!peekFile && !!input.value.trim()) // wide while searching, so neither the highlight nor typing resizes it
  const path = hits[sel]?.path ?? ''
  if (path === peeked) return
  peeked = path
  if (!path || !peekFile) return void peekBox.replaceChildren()
  // the last preview stays until this one is drawn: no blank flash between files
  peekOf(path).then(v => { if (peeked === path && !box.hidden) { peekBox.replaceChildren(v); enhanceMarked(peekBox) } }).catch(() => {})
}

// files matching the query: the server's fuzzy search (the same as @ in a message), asked once typing pauses
let found: string[] = [], fileQ = '', typing = 0
function findFiles() {
  clearTimeout(typing)
  const q = fileQ = input.value.trim()
  found = [] // the last query's files aren't this one's: none are pickable until the answer comes
  if (!q || !openFile) return
  typing = setTimeout(() => api<string[]>('files?q=' + enc(q)).then(list => { if (fileQ === q && !box.hidden) { found = list; draw(); if (peekFile) list.slice(0, 3).forEach(peekOf) } }).catch(() => {}), 120)
}
const fileHit = (path: string): Hit => {
  const cut = path.lastIndexOf('/')
  return { path, title: path.slice(cut + 1), kind: 'preview', excerpt: path.slice(0, cut + 1), score: 0 }
}

function search(q: string): Hit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const out: Hit[] = []
  for (const { el, title, t, kind, body, b } of index) {
    if (!el.isConnected) continue
    if (!words.length) { out.push({ el, title, kind, excerpt: '', score: 0 }); continue }
    // every word must match somewhere: the title counts most, then the kind, then the content
    let score = 0, inBody = -1
    for (const w of words) {
      if (t.includes(w)) score += 10
      else if (kindName(kind).startsWith(w)) score += 4
      else if (b.includes(w)) { score += 1; if (inBody < 0) inBody = b.indexOf(w) }
      else { score = -1; break }
    }
    if (score < 0) continue
    // a content match shows where it was found, as the result's second line
    const excerpt = inBody >= 0 ? '…' + body.slice(Math.max(0, inBody - 30), inBody + 60).replace(/\s+/g, ' ').trim() + '…' : ''
    out.push({ el, title, kind, excerpt, score })
  }
  return words.length ? out.sort((a, b) => b.score - a.score) : out
}

function draw() {
  hits = [...search(input.value).slice(0, 50), ...found.map(fileHit)]
  sel = Math.min(sel, Math.max(0, hits.length - 1))
  list.replaceChildren(...(hits.length ? hits.flatMap((h, i) => {
    const row = make('button', 'finder-row' + (i === sel ? ' on' : ''))
    row.setAttribute('role', 'option')
    row.dataset.kind = h.kind
    const main = make('span', 'fr-main')
    main.append(make('b', '', h.title || '(untitled)'), ...(h.excerpt ? [make('small', '', h.excerpt)] : []))
    row.append(make('i', 'fr-g', refIcon(h.kind)), main, make('span', 'fr-k', kindName(h.kind)))
    row.onmousedown = e => { e.preventDefault(); pick(h) }
    // mousemove, not mouseenter: a redraw puts a new row under a resting pointer, which would take the highlight back from the arrow keys
    row.onmousemove = () => { if (sel === i) return; list.querySelector('.on')?.classList.remove('on'); row.classList.add('on'); sel = i; peek() }
    if (!h.path || hits[i - 1]?.path) return [row]
    const head = make('p', 'finder-sec', 'Files') // the files start: their own section, below the windows
    head.setAttribute('role', 'presentation')
    return [head, row]
  }) : [make('p', 'none', 'Nothing matches.')]))
  list.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  peek()
}

const pick = (h: Hit) => { const el = h.el ?? openFile?.(h.path!); if (el) go(el) }

/** Fly to a window: expand it if collapsed, bring it forward, and put the cursor in it when it takes typing. */
function go(el: HTMLElement) {
  close()
  expand(el)
  if (!onCanvas(el)) el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }) // pinned (or in full view): already on screen
  else { front(el); centerOn(el) }
  setTimeout(() => ping(el), 300) // after the glide
  focusInput(el)
}

function openFinder() {
  box.hidden = false
  input.value = ''
  sel = 0
  build()
  draw()
  input.focus()
}
const close = () => { box.hidden = true; index = []; found = []; peeked = ''; peeks.clear(); clearTimeout(typing); peekBox.replaceChildren() } // don't hold on to big texts

input.addEventListener('input', () => { sel = 0; findFiles(); draw() })
input.addEventListener('keydown', e => {
  e.stopPropagation() // typing here isn't a canvas shortcut
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % Math.max(1, hits.length); draw() }
  else if (e.key === 'Enter') { e.preventDefault(); if (hits[sel]) pick(hits[sel]) }
  else if (e.key === 'Escape') { e.preventDefault(); close() }
})
input.onblur = close // rows keep focus in the input (mousedown is prevented), so this is a real blur
// Ctrl/Cmd+K from anywhere, even while typing in a card
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); box.hidden ? openFinder() : close() }
}, true)
$('#btn-find').onclick = () => openFinder()
