// Go to definition from a diff: a name in a diff's text is underlined under the pointer, and a click (or the name
// typed in the diff's header box) asks where it's defined (lib/symbols.ts). One definition shows its source around
// the line; several are listed to pick from; none opens nothing (a local variable is the usual case, not an error).
// Open file puts the file in a window on the canvas, at the line. Rows stay plain text: the name under the pointer
// is found from the caret position there, and underlined with the CSS Custom Highlight API.
import { api, q } from '../lib/api'
import { make, button, iconButton, ICON, keepOnScreen, perFrame, revealIn } from '../lib/dom'
import { definitions, symbolsOn, type CodeSymbol } from '../lib/symbols'
import { openFileAt, stickFileAt } from '../canvas/find'
import { sourceView } from './files'

const box = document.body.appendChild(make('div', 'defs float'))
box.hidden = true
box.setAttribute('role', 'dialog')
const AROUND = 4 // lines above the definition; the snippet shows 16 in all

const NAME = /[\w$]/
/** The identifier (a name, not a number) at a screen point inside `within`, with its range; null when there's none. */
function nameAt(x: number, y: number, within: Element) {
  const p = document.caretPositionFromPoint?.(x, y), r = p ? null : document.caretRangeFromPoint?.(x, y)
  const node = p?.offsetNode ?? r?.startContainer, off = p?.offset ?? r?.startOffset ?? 0
  if (!node || node.nodeType !== Node.TEXT_NODE || !within.contains(node)) return null
  const t = node.textContent ?? ''
  let a = off, b = off
  while (a > 0 && NAME.test(t[a - 1])) a--
  while (b < t.length && NAME.test(t[b])) b++
  if (!/^[A-Za-z_$]/.test(t.slice(a, b))) return null
  const range = new Range()
  range.setStart(node, a); range.setEnd(node, b)
  // the caret snaps to the nearest character: past the end of a line, or between words, isn't on the name
  const rc = range.getBoundingClientRect()
  return x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom ? { name: t.slice(a, b), range } : null
}

const ROWS = '.diff > :is(.add, .del, .eq)' // code rows: not hunk headers, folds or a pull request's comments
const hl = typeof Highlight === 'function' ? new Highlight() : null
if (hl) CSS.highlights.set('def-name', hl)
let under: HTMLElement | null = null
const hover = perFrame((t: Element | null, x: number, y: number) => {
  const row = t?.closest<HTMLElement>(ROWS), at = row ? nameAt(x, y, row) : null
  hl?.clear()
  under?.classList.remove('def-on')
  under = at ? row! : null
  if (!at) return
  hl?.add(at.range)
  row!.classList.add('def-on')
})

type Look = (name: string, x: number, y: number) => void
/** Make the names in diffs inside `el` lead somewhere: hovering underlines one, clicking runs `look` on it (where
 *  it's defined, or with showRefs where it's used). Such a click is `defaultPrevented`, so a diff's own click (a pull
 *  request's line comment) can skip it. */
export function definable(el: HTMLElement, look: Look = showDefs) {
  const on = () => look !== showDefs || symbolsOn() // where it's used is a text search: no ctags needed
  el.addEventListener('pointermove', e => hover(on() ? e.target as Element : null, e.clientX, e.clientY))
  el.addEventListener('pointerleave', () => hover(null, 0, 0))
  el.addEventListener('click', e => {
    const row = (e.target as Element).closest(ROWS)
    if (!row || !on() || !getSelection()?.isCollapsed) return // selecting text isn't asking
    const at = nameAt(e.clientX, e.clientY, row)
    if (!at) return
    e.preventDefault()
    look(at.name, e.clientX, e.clientY + 14)
  }, true) // capturing: before the diff's own click handlers
}

/** The header box: type a name, Enter shows where it's defined. */
export function defField() {
  const f = make('input', 'def-q')
  f.placeholder = 'Go to definition'
  f.setAttribute('aria-label', 'Go to the definition of a name')
  f.spellcheck = false
  f.oninput = () => f.removeAttribute('aria-invalid')
  f.onclick = e => e.stopPropagation() // the header folds the diff on click
  f.onkeydown = e => {
    e.stopPropagation() // typing here isn't a shortcut, and Enter or Space here isn't the header's fold
    if (e.key !== 'Enter' || e.isComposing || !f.value.trim()) return
    e.preventDefault()
    const r = f.getBoundingClientRect()
    showDefs(f.value.trim(), r.left, r.bottom + 6, f)
  }
  return f
}

let asked = 0, from: HTMLElement | null = null, x0 = 0, y0 = 0
/** Look `name` up and show where it's defined near (x, y). Nothing opens when it isn't a known definition; `field`
 *  (where it was typed) says so with its border instead. */
export async function showDefs(name: string, x: number, y: number, field?: HTMLElement) {
  const n = ++asked, defs = await definitions(name)
  if (n !== asked) return
  if (!defs.length) {
    close()
    field?.setAttribute('aria-invalid', 'true')
    return
  }
  from = field ?? null; x0 = x; y0 = y
  if (defs.length === 1) one(name, defs[0])
  else several(name, defs)
}

type Ref = { path: string; line: number; text: string }
/** Where `name` is used in the project (a whole-word search, comments and strings too), listed near (x, y). Picking
 *  one opens its file at the line in a small window stuck to the screen beside the list, which stays open to step
 *  through the rest. */
export async function showRefs(name: string, x: number, y: number) {
  const n = ++asked
  from = null; x0 = x; y0 = y
  show(head(name, 'Searching…'))
  const refs = await api<Ref[]>('refs?name=' + q(name)).catch(() => [] as Ref[])
  if (n !== asked) return
  if (!refs.length) { show(head(name, 'no uses found in the project')); return }
  const list = make('div', 'defs-list')
  list.setAttribute('role', 'listbox')
  for (const r of refs) {
    const row = make('button', 'finder-row')
    row.setAttribute('role', 'option')
    row.dataset.kind = 'preview'
    const main = make('span', 'fr-main'), text = make('small', 'ref-t')
    const at = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).exec(r.text)
    if (at) text.append(r.text.slice(0, at.index), make('mark', '', name), r.text.slice(at.index + name.length))
    else text.textContent = r.text
    main.append(make('b', '', `${r.path}:${r.line}`), text)
    row.append(main)
    row.onclick = () => stickFileAt(r.path, r.line, ...besideBox())
    list.append(row)
  }
  show(head(name, refs.length === 200 ? 'the first 200 uses' : `${refs.length} use${refs.length > 1 ? 's' : ''}`), list)
  list.querySelector('button')?.focus()
}

/** Where a 380×260 window fits beside the open box: right, else left, else (a phone) below or above it. */
function besideBox(): [number, number] {
  const b = box.getBoundingClientRect()
  if (b.right + 388 <= innerWidth) return [b.right + 8, b.top]
  if (b.left >= 388) return [b.left - 388, b.top]
  return [8, b.bottom + 268 <= innerHeight ? b.bottom + 8 : Math.max(8, b.top - 268)]
}

function head(name: string, note: string, back?: () => void) {
  const h = make('div', 'defs-h')
  if (back) h.append(button('‹ All', 'defs-back', back))
  h.append(make('b', '', name), make('span', '', note), iconButton(ICON.x, 'Close (Esc)', () => close()))
  return h
}

const where = (s: CodeSymbol) => `${s.path}:${s.line}`

function several(name: string, defs: CodeSymbol[]) {
  const list = make('div', 'defs-list')
  list.setAttribute('role', 'listbox')
  for (const s of defs) {
    const row = make('button', 'finder-row')
    row.setAttribute('role', 'option')
    row.dataset.kind = 'preview'
    const main = make('span', 'fr-main')
    main.append(make('b', '', where(s)), ...(s.scope ? [make('small', '', s.scope)] : []))
    row.append(main, make('span', 'fr-k', s.kind))
    row.onclick = () => one(name, s, () => several(name, defs))
    list.append(row)
  }
  show(head(name, `${defs.length} definitions`), list)
  list.querySelector('button')?.focus()
}

async function one(name: string, s: CodeSymbol, back?: () => void) {
  const n = ++asked
  const text = (await api<{ text: string | null }>('file?path=' + q(s.path)).catch(() => null))?.text
  if (n !== asked) return
  const first = Math.max(1, s.line - AROUND)
  const snippet = text == null ? make('p', 'none', "This file can't be read now.")
    : await sourceView(s.path, text.split('\n', first + 15).slice(first - 1).join('\n'), { first, at: s.line })
  if (n !== asked) return
  const code = make('div', 'defs-code')
  code.append(snippet)
  const open = button('Open file', 'primary', () => { close(false); openFileAt(s.path, s.line) })
  const foot = make('div', 'defs-f')
  foot.append(make('span', '', where(s)), open)
  show(head(name, s.scope ? `${s.kind} in ${s.scope}` : s.kind, back), code, foot)
  revealIn(code)
  open.focus()
}

function show(...parts: HTMLElement[]) {
  box.replaceChildren(...parts)
  box.hidden = false
  keepOnScreen(box, x0, y0)
}

function close(restore = true) {
  asked++
  if (box.hidden) return
  box.hidden = true
  box.replaceChildren()
  if (restore && from?.isConnected) from.focus()
  from = null
}

// Escape closes this first, wherever focus is: not the inspector under it
addEventListener('keydown', e => { if (e.key === 'Escape' && !box.hidden) { e.preventDefault(); e.stopPropagation(); close() } }, true)
box.addEventListener('keydown', e => {
  e.stopPropagation() // keys here aren't canvas shortcuts
  const rows = [...box.querySelectorAll<HTMLElement>('.defs-list button')], i = rows.indexOf(document.activeElement as HTMLElement)
  if (i >= 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus()
  }
})
addEventListener('pointerdown', e => { if (!box.hidden && !box.contains(e.target as Node)) close(false) }, true)
