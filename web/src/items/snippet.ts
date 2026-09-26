// Snippets: a piece of anything pulled out onto the canvas. Select text anywhere (a reply, a plan, a file in the
// inspector, a diff, command output) and press "Pin to canvas"; or drag a command row, shell block or code block out.
// Three types, each shown and sent to Claude as what it is: output, code (with language and file lines), text.
// Listens at the page level: the canvas layer doesn't import items.
import { tipText } from '../lib/tooltip'
import { make, button, ICON, copyButton, ping, perFrame, EDITABLE, keepOnScreen, clip, uuid } from '../lib/dom'
import { persist, each } from '../lib/store'
import { items, savedRect, dragOut, changed, nearestFree, onCanvas, rect, viewCenter, centerOn, type Rect } from '../canvas/canvas'
import { makeWindow, winTitle, removeButton } from '../canvas/window'
import { referable } from '../canvas/refs'
import { highlighter } from '../lib/markdown'
import { creatable } from '../canvas/tools'
import { addMark, markOf, markSrcOf, inspectorPath, textBefore, type MarkSrc } from './pinmarks'

type SnipType = 'output' | 'code' | 'text'
// src: where a pinned selection came from, so that text stays marked (see pinmarks.ts)
interface Snippet { id?: string; title: string; text: string; rect: Rect; type?: SnipType; lang?: string; src?: MarkSrc }
interface Source { title: string; text: string; type: SnipType; lang?: string; host: HTMLElement | null }
// saved before types existed: a language meant code, otherwise it was command output
const typeOf = (o: { type?: SnipType; lang?: string }): SnipType => o.type ?? (o.lang !== undefined ? 'code' : 'output')
const MAX = 10_000 // characters kept per snippet (the whole layout shares localStorage's ~5 MB)

/** The body's text: code goes in a <code>, highlighted in its language. */
function fill(body: HTMLElement, text: string, type: SnipType, lang?: string) {
  const t = clip(text, MAX)
  if (type !== 'code') { body.textContent = t; return }
  const code = make('code', lang ? 'language-' + lang : '', t)
  body.replaceChildren(code)
  if (lang) highlighter().then(h => { if (h.getLanguage(lang)) h.highlightElement(code) })
}

export function snippet(o: Snippet) {
  const id = o.id ?? uuid(), body = make('pre', 'xnode-b')
  const copy = copyButton(() => body.textContent ?? '', 'Copy text')
  const type = typeOf(o)
  fill(body, o.text, type, o.lang)
  const { el } = makeWindow({
    kind: 'snippet', cls: 'xnode', title: o.title, rect: o.rect, minW: 200, minH: 90,
    actions: [copy, removeButton('Remove from canvas')],
  })
  el.dataset.id = id
  el.dataset.type = type
  if (o.lang) el.dataset.lang = o.lang
  el.dataset.ink = 'x:' + id // drawing on it moves and saves with it
  el.querySelector('.win-b')!.append(body)
  if (o.src) addMark(el, { ...o.src, src: o.src })
  changed()
  return el
}

/** A size that fits the text: wide enough for typical lines, tall enough for up to ~18 of them. */
function sizeFor(text: string): { w: number; h: number } {
  const lines = text.split('\n'), longest = Math.max(...lines.slice(0, 200).map(l => l.length))
  return { w: Math.min(640, Math.max(300, longest * 7.3 + 40)), h: Math.min(440, Math.max(110, lines.length * 18 + 84)) } // + tab, padding, a scrollbar
}

/* ---------- where snippets come from ---------- */
const host = (n: Element) => n.closest<HTMLElement>('.item')
const firstLine = (t: string) => t.split('\n').find(l => l.trim())?.trim().slice(0, 48) ?? ''
const langOf = (code: Element | null) => /language-([\w+#-]+)/.exec(code?.className ?? '')?.[1] ?? ''

/** A commands-window row or a shell block: its command (title) and the whole output. */
function outputSource(t: Element): Source | null {
  const row = t.closest<HTMLDetailsElement>('.tcmd')
  if (row) return { title: tipText(row).split('\n')[0] || 'command', text: row.querySelector('pre')?.textContent ?? '', type: 'output', host: host(row) }
  const sh = t.closest<HTMLElement>('.shell')
  if (sh) {
    const cmd = sh.querySelector('.sh-cmd')?.textContent ?? ''
    return { title: cmd.split('\n')[0], text: `$ ${cmd}\n${sh.querySelector('.sh-o')?.textContent ?? ''}`, type: 'output', host: host(sh) }
  }
  return null
}

/** A code block in a reply, plan or preview. */
function codeSource(block: Element): Source {
  const code = block.querySelector('pre > code'), text = (code?.textContent ?? '').replace(/\n$/, ''), lang = langOf(code)
  const first = firstLine(text) || 'code'
  return { title: lang ? `${lang} · ${first}` : first, text, type: 'code', lang, host: host(block) }
}

/** What a selection is, judged by where it sits. `null`: nothing to pin (inputs, window tabs, the toolbar). */
function selectionSource(node: Element, range: Range, text: string): Source | null {
  if (node.closest(`${EDITABLE}, .win-h, #bar, .pinsel`)) return null
  // a file open in the inspector: code, titled with its path and the selected line numbers
  const src = node.closest('#viewer .src')
  if (src) {
    if (node.closest('.ln')) return null
    const code = src.querySelector('pre:not(.ln) code')!, path = inspectorPath() || 'file'
    const start = textBefore(code, range).split('\n').length, end = start + text.replace(/\n$/, '').split('\n').length - 1
    return { title: `${path}:${start}${end > start ? '-' + end : ''}`, text, type: 'code', lang: path.split('.').pop() ?? '', host: null }
  }
  // a diff (inspector's Changes, the Git window): code from that file
  const diff = node.closest('.diff')
  if (diff) {
    const file = tipText(diff.closest('.gfile')?.querySelector('.gname')).split(' (')[0] || inspectorPath() || 'diff'
    return { title: `diff · ${file}`, text, type: 'code', lang: '', host: host(diff) }
  }
  const block = node.closest('.codeblock, pre:has(> code)')
  if (block && !block.closest('.xnode')) return { ...codeSource(block.closest('.codeblock') ?? block), text }
  // command output: commands window, shell blocks, tool output in a card
  if (node.closest('.tcmd pre, .shell .sh-o')) return { ...outputSource(node)!, text }
  if (node.closest('.io pre')) {
    const d = node.closest('details.tool')
    const title = `${d?.querySelector('summary b')?.textContent ?? 'Output'} ${d?.querySelector('summary .arg')?.textContent ?? ''}`.trim()
    return { title, text, type: 'output', host: host(node) }
  }
  // anything else you can read on the canvas or in the inspector: plain text
  if (node.closest('#world .item, #inspector')) return { title: firstLine(text) || 'excerpt', text, type: 'text', host: host(node) }
  return null
}

// drag out of its window: a code block's grip, a command row (its summary line) or a shell block (its header)
document.addEventListener('pointerdown', e => {
  const t = e.target as Element, grip = t.closest<HTMLElement>('.codeblock .pullbtn')
  if (e.button !== 0) return
  const handle = grip ?? (t.closest('button, a') ? null : t.closest<HTMLElement>('#world .tcmd > summary, #world .shell > .sh-h'))
  const src = grip ? codeSource(grip.closest('.codeblock')!) : handle && outputSource(t)
  if (handle && src) dragOut(handle, e, (x, y) => snippet({ ...src, rect: { x, y, ...sizeFor(src.text) } }))
})
// a plain click on a code block's grip pins it beside the window
document.addEventListener('click', e => { // (a drag's closing click is swallowed by dragOut)
  const btn = (e.target as Element).closest<HTMLElement>('.codeblock .pullbtn')
  if (btn) pin(codeSource(btn.closest('.codeblock')!))
})

function pin(src: Source, mark?: ReturnType<typeof markOf>) {
  const size = sizeFor(src.text)
  // right beside where it came from, in the nearest gap: nothing else moves or gets covered
  const h = src.host && onCanvas(src.host) ? rect(src.host) : null, c = viewCenter()
  const want = h ? { x: h.x + h.w + 40, y: h.y, ...size } : { x: c.x - size.w / 2, y: c.y - size.h / 2, ...size }
  const el = snippet({ ...src, text: src.text.replace(/\n+$/, ''), rect: nearestFree(want) })
  if (mark) addMark(el, mark) // the text it came from stays marked; click it to come back here
  centerOn(el)
  ping(el)
}

// select text anywhere: a "Pin to canvas" button appears by the selection
const pinBtn = document.body.appendChild(button('', 'pinsel', () => {
  if (!picked) return
  const sel = getSelection()
  pin(picked, sel?.rangeCount ? markOf(sel.getRangeAt(0)) : null)
  sel?.removeAllRanges()
}))
pinBtn.innerHTML = ICON.pin + 'Pin to canvas'
pinBtn.hidden = true
let picked: Source | null = null
document.addEventListener('selectionchange', () => {
  const sel = getSelection(), text = sel?.toString() ?? ''
  const a = sel?.anchorNode, node = a ? (a instanceof Element ? a : a.parentElement) : null
  const src = sel && sel.rangeCount && text.trim() && node ? selectionSource(node, sel.getRangeAt(0), text) : null
  if (!src) { pinBtn.hidden = true; picked = null; return }
  picked = src
  placePin()
})
/** Put the button by where you finished selecting (the selection's end can be scrolled out of view), inside what's
 *  visible of its window; hidden while that's off screen. Called again whenever the canvas or a window moves. */
function placePin() {
  const sel = getSelection()
  if (!picked || !sel?.rangeCount || !sel.focusNode) { pinBtn.hidden = true; return }
  const a = sel.anchorNode, node = a instanceof Element ? a : a?.parentElement
  const end = document.createRange()
  end.setStart(sel.focusNode, sel.focusOffset)
  const r = end.getClientRects()[0] ?? sel.getRangeAt(0).getBoundingClientRect()
  const box = node?.closest('.log, .win-b, #viewer, #inspector')?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight)
  const off = box.bottom < 40 || box.top > innerHeight - 40 || box.right < 40 || box.left > innerWidth - 40
  pinBtn.hidden = off
  if (!off) keepOnScreen(pinBtn, Math.min(r.right, box.right - pinBtn.offsetWidth - 8) + 6, Math.min(Math.max(r.bottom, box.top), box.bottom - 40) + 6)
}
const follow = perFrame(() => { if (picked) placePin() })
// the canvas pans and zooms by transform (no scroll event): follow wheel, drags and any scroll
addEventListener('scroll', follow, true)
addEventListener('wheel', follow, { passive: true, capture: true })
addEventListener('pointermove', e => { if (e.buttons) follow() }, { passive: true })
addEventListener('resize', follow)
pinBtn.addEventListener('pointerdown', e => e.preventDefault()) // keep the selection while clicking

/* ---------- saved, and sendable ---------- */
const text = (el: HTMLElement) => el.querySelector('.xnode-b')?.textContent ?? ''
const title = winTitle
creatable('snippet', {
  size: a => sizeFor(String(a.text)),
  create: (a, r) => {
    const type: SnipType = ['code', 'text', 'output'].includes(a.type) ? a.type : 'code'
    return snippet({ title: String(a.title ?? (firstLine(String(a.text)) || type)), text: String(a.text), type, lang: type === 'code' ? String(a.lang ?? '') : undefined, rect: r })
  },
  update: (el, a) => fill(el.querySelector('.xnode-b')!, String(a.text), el.dataset.type as SnipType, el.dataset.lang),
})
persist('snippets',
  () => items('snippet').map(el => ({ id: el.dataset.id!, title: title(el), text: text(el), type: el.dataset.type as SnipType, lang: el.dataset.lang, rect: savedRect(el), src: markSrcOf(el) })),
  (list: Snippet[]) => each(list, snippet))
referable('snippet', {
  icon: '$',
  content: el => el.dataset.type === 'code'
    ? { text: `Code from my canvas (${title(el)}):\n\`\`\`${el.dataset.lang ?? ''}\n${text(el)}\n\`\`\`` }
    : el.dataset.type === 'text'
      ? { text: `Excerpt from my canvas:\n${text(el).split('\n').map(l => '> ' + l).join('\n')}` }
      : { text: `Command output from my canvas ($ ${title(el)}):\n\`\`\`\n${text(el)}\n\`\`\`` },
})
