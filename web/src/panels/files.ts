// File tree (in the drawer) and the inspector: a file's diffs from every session, plus the file itself.
import { tipText } from '../lib/tooltip'
import { api, q, type TreeItem } from '../lib/api'
import { $, make, pathEl, pressed, toast, revealIn } from '../lib/dom'
import { md, enhance, enhanceMarked, highlighter } from '../lib/markdown'
import { files, pin, refreshSelection, setInspector } from '../canvas/sessionwins'
import { inFile, type Change } from './diff'
import { centerOn } from '../canvas/canvas'
import { openFileAt } from '../canvas/find'

const expanded = new Set<string>()
export let inspecting: string | null = null
let mdSource = false // markdown files: show source instead of preview (sticks until reload)
let lastInput: HTMLTextAreaElement | null = null // composer to receive "Insert path"
addEventListener('focusin', e => { if ((e.target as Element).matches?.('.card textarea')) lastInput = e.target as HTMLTextAreaElement })

/* ---------- tree ---------- */
/** A folder's entries; a huge folder ends with `{ name: '', more: N }`: the server's cut (N entries not listed). */
export async function tree(path = '', ul: HTMLElement = $('#tree')) {
  let items: TreeItem[]
  try { items = await api<TreeItem[]>('tree?path=' + q(path)) } catch (e) { return ul.replaceChildren(make('li', 'none', (e as Error).message)) }
  if (!path && !items.length) return ul.replaceChildren(make('li', 'none', 'This folder is empty. Files your sessions create will show up here.'))
  ul.replaceChildren(...items.map(it => {
    if (it.more != null) return make('li', 'more', `${it.more.toLocaleString()} more`)
    const p = path ? `${path}/${it.name}` : it.name, li = make('li'), b = make('button', it.dir ? 'dir' : 'file')
    b.append(make('span', '', it.name))
    b.title = p
    li.append(b)
    if (it.dir) {
      const sub = li.appendChild(make('ul'))
      const load = () => { li.classList.add('open'); tree(p, sub) }
      const sync = () => b.setAttribute('aria-expanded', String(expanded.has(p)))
      if (expanded.has(p)) load()
      sync()
      b.onclick = () => {
        if (expanded.delete(p)) { li.classList.remove('open'); sub.replaceChildren() } else { expanded.add(p); load() }
        sync()
      }
    } else {
      b.onclick = () => { centerOn(pin(p)); openInspector(p, 'viewer') }
      b.classList.toggle('cur', p === inspecting)
      b.classList.toggle('mod', !!files.get(p)?.changes.length)
    }
    return li
  }))
}

/* ---------- inspector ---------- */
const inspector = $('#inspector')

// the canvas's Files windows and file nodes open files here (canvas/ can't import panels/)
setInspector({ open: p => openInspector(p), current: () => inspecting })

/** `line`: in the viewer, scrolled to and marking that line. */
export function openInspector(path: string, tab?: 'changes' | 'viewer', focus?: Change, line?: number) {
  const changes = files.get(path)?.changes ?? []
  const fresh = inspecting !== path || inspector.hidden
  inspecting = path
  inspector.hidden = false
  $('#ipath').replaceChildren(pathEl('', path))
  $('#iedit').onclick = () => openFileAt(path, line, true) // in its window on the canvas: one editor, with its saving and Vim motions
  $('#nchg').textContent = changes.length ? String(changes.length) : ''
  $('#changes').replaceChildren(...(changes.length ? changes : [make('p', 'none', 'No open session has changed this file.')]))
  changes.forEach(c => inFile(c)) // numbered, in the file: once each, when first shown (not for every replayed edit)
  const which = tab ?? (fresh ? (changes.length ? 'changes' : 'viewer') : $('#viewer').hidden ? 'changes' : 'viewer')
  showTab(which)
  if (which === 'viewer' || fresh) view(path, line)
  if (focus) {
    focus.scrollIntoView({ block: 'start' })
    focus.classList.add('flash')
    setTimeout(() => focus.classList.remove('flash'), 900)
  }
  document.querySelectorAll<HTMLElement>('#tree .file').forEach(b => b.classList.toggle('cur', tipText(b) === path))
  refreshSelection()
}

export function closeInspector() {
  inspector.hidden = true
  inspecting = null
  refreshSelection()
}

// Collapse all / Expand all for the diffs in the Changes tab
const foldAll = $<HTMLButtonElement>('#foldall')
const syncFoldAll = () => {
  const list = [...document.querySelectorAll('#changes .chg')]
  foldAll.hidden = !list.length || $('#changes').hidden
  foldAll.textContent = list.length && list.every(c => c.classList.contains('folded')) ? 'Expand all' : 'Collapse all'
}
foldAll.onclick = () => {
  const fold = foldAll.textContent === 'Collapse all'
  for (const c of document.querySelectorAll('#changes .chg')) {
    c.classList.toggle('folded', fold)
    c.querySelector('.h')?.setAttribute('aria-expanded', String(!fold))
  }
  syncFoldAll()
}
$('#changes').addEventListener('click', syncFoldAll) // single folds change the label too

export function showTab(which: 'changes' | 'viewer') {
  for (const b of document.querySelectorAll<HTMLElement>('.seg [data-r]')) pressed(b, b.dataset.r === which)
  $('#changes').hidden = which !== 'changes'
  $('#viewer').hidden = which !== 'viewer'
  syncFoldAll()
}

export const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p)

/** A file's text as code with line numbers, highlighted by its extension. Also the preview window's body.
 *  `first`: the number of the text's first line, when it's part of a file; `at`: a line to mark (revealIn finds it). */
export async function sourceView(p: string, text: string | null, { first = 1, at }: { first?: number; at?: number } = {}) {
  const src = make('div', 'src'), ln = make('pre', 'ln'), pre = make('pre'), code = make('code', '', text ?? 'Binary file, not shown.')
  src.dataset.path = p // pinning a selection names the file and its lines (snippet.ts)
  if (first > 1) src.dataset.first = String(first)
  const lines = text == null ? 1 : text.replace(/\n$/, '').split('\n').length
  ln.textContent = Array.from({ length: lines }, (_, i) => i + first).join('\n')
  pre.append(code)
  src.append(ln, pre)
  // a band behind the line, placed by CSS from its index: no layout read to draw it
  if (at && text != null && at >= first && at < first + lines) {
    const mark = src.appendChild(make('i', 'src-at'))
    mark.style.setProperty('--at', String(at - first))
    mark.dataset.reveal = ''
  }
  const ext = p.split('.').pop()!
  if (text != null && text.length < 300_000) {
    const hljs = await highlighter()
    if (hljs.getLanguage(ext)) code.className = 'language-' + ext
    hljs.highlightElement(code)
  }
  return src
}

const NON_RELATIVE_URL = /^([a-z][\w+.-]*:|\/|#)/i

/** A Markdown file rendered, its relative pictures and links resolved from the file's folder. */
export function mdView(p: string, text: string) {
  const out = make('div', 'md mdview')
  out.innerHTML = md(text)
  enhance(out)
  const dir = 'http://p/' + p.slice(0, p.lastIndexOf('/') + 1)
  for (const img of out.querySelectorAll('img')) {
    const s = img.getAttribute('src') ?? ''
    if (!s || NON_RELATIVE_URL.test(s)) continue
    try { img.src = '/api/raw?path=' + q(decodeURIComponent(new URL(s, dir).pathname.slice(1))) } catch { /* a stray % in the path: left as written */ }
  }
  for (const a of out.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')?.trim() ?? ''
    if (!href || NON_RELATIVE_URL.test(href)) continue
    try {
      const url = new URL(href, dir)
      if (url.origin !== 'http://p') continue // backslashes can also start an external URL
      const path = decodeURIComponent(url.pathname.slice(1)) // file links ignore their query and heading fragment
      a.addEventListener('click', e => { e.preventDefault(); openInspector(path, 'viewer') })
    } catch { /* a stray % in the path: left as written */ }
  }
  return out
}

/** A file was just saved (items/fileedit.ts): the File tab showing it reads it again. */
export const saved = (p: string) => { if (inspecting === p && !inspector.hidden && !$('#viewer').hidden) view(p) }

export async function view(p: string, at?: number) {
  const viewer = $('#viewer')
  // another file's text under this path would read as this file's while it loads
  if (viewer.dataset.path !== p) { viewer.replaceChildren(make('p', 'none', 'Reading…')); viewer.dataset.path = p }
  const head = make('div', 'vhead'), ins = make('button', 'btn', 'Insert path')
  ins.title = 'Add this path to the message you are writing'
  ins.onclick = () => {
    const ta = lastInput?.isConnected ? lastInput : document.querySelector<HTMLTextAreaElement>('.card textarea')
    if (!ta) return toast('Open a session to insert this path into its message.')
    ta.setRangeText(p + ' ', ta.selectionStart, ta.selectionEnd, 'end')
    ta.focus()
  }

  let text: string | null = null, src: HTMLElement
  try {
    ({ text } = await api<{ text: string | null }>('file?path=' + q(p)))
    src = await sourceView(p, text, { at })
  } catch (e) {
    src = make('p', 'none', (e as Error).message)
  }
  if (inspecting !== p) return // user moved on while loading

  if (text != null && isMarkdown(p) && !at) { // at a line: the source, where lines are
    const preview = mdView(p, text), toggle = make('button', 'btn')
    const sync = () => { preview.hidden = mdSource; src.hidden = !mdSource; toggle.textContent = mdSource ? 'Preview' : 'Source' }
    toggle.onclick = () => { mdSource = !mdSource; sync() }
    sync()
    head.append(toggle, ins)
    $('#viewer').replaceChildren(head, preview, src)
    enhanceMarked($('#viewer')) // built off-page: diagrams and code tools need it shown first
  } else {
    head.append(ins)
    $('#viewer').replaceChildren(head, src)
    revealIn($('#viewer'))
  }
}
