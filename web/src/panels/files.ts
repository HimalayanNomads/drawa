// File tree (in the drawer) and the inspector: a file's diffs from every session, plus the file itself.
import { tipText } from '../lib/tooltip'
import { api, q, type TreeItem } from '../lib/api'
import { $, make, pathEl } from '../lib/dom'
import { md, enhance, highlighter } from '../lib/markdown'
import { files, pin, refreshSelection, setInspector } from '../canvas/sessionwins'
import type { Change } from './diff'
import { centerOn } from '../canvas/canvas'

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
  if (!path && !items.length) return ul.replaceChildren(make('li', 'none', 'This folder is empty. Files Claude creates will show up here.'))
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

export function openInspector(path: string, tab?: 'changes' | 'viewer', focus?: Change) {
  const changes = files.get(path)?.changes ?? []
  const fresh = inspecting !== path || inspector.hidden
  inspecting = path
  inspector.hidden = false
  $('#ipath').replaceChildren(pathEl('', path))
  $('#nchg').textContent = changes.length ? String(changes.length) : ''
  $('#changes').replaceChildren(...(changes.length ? changes : [make('p', 'none', 'Claude has not changed this file in any open session.')]))
  const which = tab ?? (fresh ? (changes.length ? 'changes' : 'viewer') : $('#viewer').hidden ? 'changes' : 'viewer')
  showTab(which)
  if (which === 'viewer' || fresh) view(path)
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
  for (const b of document.querySelectorAll<HTMLElement>('[data-r]')) b.classList.toggle('on', b.dataset.r === which)
  $('#changes').hidden = which !== 'changes'
  $('#viewer').hidden = which !== 'viewer'
  syncFoldAll()
}

export async function view(p: string) {
  const head = make('div', 'vhead'), ins = make('button', 'btn', 'Insert path')
  ins.title = 'Add this path to the message you are writing'
  ins.onclick = () => {
    const ta = lastInput?.isConnected ? lastInput : document.querySelector<HTMLTextAreaElement>('.card textarea')
    if (!ta) return
    ta.setRangeText(p + ' ', ta.selectionStart, ta.selectionEnd, 'end')
    ta.focus()
  }

  const src = make('div', 'src'), ln = make('pre', 'ln'), pre = make('pre'), code = make('code')
  let text: string | null = null
  try {
    ({ text } = await api<{ text: string | null }>('file?path=' + q(p)))
    code.textContent = text ?? 'Binary file, not shown.'
    const lines = text == null ? 1 : text.replace(/\n$/, '').split('\n').length
    ln.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n')
    const ext = p.split('.').pop()!
    if (text != null && text.length < 300_000) {
      const hljs = await highlighter()
      if (hljs.getLanguage(ext)) code.className = 'language-' + ext
      hljs.highlightElement(code)
    }
  } catch (e) {
    code.textContent = (e as Error).message
  }
  if (inspecting !== p) return // user moved on while loading
  pre.append(code)
  src.append(ln, pre)

  if (text != null && /\.(md|markdown|mdx)$/i.test(p)) {
    // ponytail: relative images/links won't resolve, the server doesn't serve project files raw
    const preview = make('div', 'md mdview'), toggle = make('button', 'btn')
    preview.innerHTML = md(text)
    enhance(preview)
    const sync = () => { preview.hidden = mdSource; src.hidden = !mdSource; toggle.textContent = mdSource ? 'Preview' : 'Source' }
    toggle.onclick = () => { mdSource = !mdSource; sync() }
    sync()
    head.append(toggle, ins)
    $('#viewer').replaceChildren(head, preview, src)
  } else {
    head.append(ins)
    $('#viewer').replaceChildren(head, src)
  }
}
