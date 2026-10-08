// A diff block for every Edit / MultiEdit / Write. Blocks live on their file's node; the inspector shows them. Names in
// them lead to their definitions (defs.ts).
import { diffLines } from 'diff'
import { make, iconButton, ICON } from '../lib/dom'
import { api, q } from '../lib/api'
import type { Session } from '../session/session'
import { definable, defField } from './defs'
import { openFileAt } from '../canvas/find'
import { files, paint } from '../canvas/sessionwins'
import { openInspector } from './files'

export type Change = HTMLDivElement & { file: string; add: number; del: number; tool: string; inp: Record<string, any>; full?: boolean }
const MAX_LINES = 600 // rows drawn up front; the rest wait behind a row you click
const AROUND = 6 // unchanged file lines kept next to a change; longer stretches fold into a row that opens them

type Kind = 'add' | 'del' | 'eq'
interface Row { k: Kind; t: string; n?: number }
function addRow(box: ParentNode, r: Row) {
  const d = box.appendChild(make('div', r.k, r.t))
  d.dataset.s = r.k === 'add' ? '+' : r.k === 'del' ? '−' : ''
  if (r.n) d.dataset.n = String(r.n)
}
/** A folded stretch: `label` until clicked, then its rows. Keeps big diffs light without hiding anything for good. */
function folded(rows: Row[], label: string) {
  const s = make('div', 'sep more', label)
  s.title = 'Show these lines'
  s.tabIndex = 0
  s.setAttribute('role', 'button')
  s.onclick = e => {
    e.stopPropagation()
    const f = document.createDocumentFragment()
    rows.forEach(r => addRow(f, r))
    const box = s.parentElement
    s.replaceWith(f)
    if (e.detail === 0 && box) { box.tabIndex = -1; box.focus({ preventScroll: true }) } // opened from the keyboard: keep focus nearby instead of losing it with the row
  }
  s.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); s.click() } }
  return s
}

export function change(S: Session, tool: string, file: string, inp: Record<string, any>): Change | undefined {
  const pairs: [string, string][] | null =
    tool === 'Write' ? [['', inp.content ?? '']]
    : tool === 'Edit' ? [[inp.old_string ?? '', inp.new_string ?? '']]
    : tool === 'MultiEdit' ? (inp.edits ?? []).map((e: any) => [e.old_string ?? '', e.new_string ?? ''])
    : null
  if (!pairs) return

  const c = make('div', 'chg pending') as Change, h = make('div', 'h'), who = make('span', 'who'), stat = make('span', 'stat'), body = make('div', 'diff')
  c.file = file
  c.tool = tool
  c.inp = inp
  who.append(make('b', tool === 'Write' ? 'write' : '', tool === 'Write' ? 'write' : 'edit'), S.title)
  who.title = `From session: ${S.title}`

  let add = 0, del = 0
  const rows: (Row | null)[] = [] // null: the gap between a MultiEdit's edits
  pairs.forEach(([a, b], n) => {
    if (n) rows.push(null)
    for (const part of diffLines(a, b)) {
      const lines = part.value.replace(/\n$/, '').split('\n'), k: Kind = part.added ? 'add' : part.removed ? 'del' : 'eq'
      if (k === 'add') add += lines.length
      if (k === 'del') del += lines.length
      for (const t of lines) rows.push({ k, t, n: tool === 'Write' ? rows.length + 1 : undefined }) // a Write is the whole file
    }
  })
  if (tool === 'Write') { body.classList.add('num'); body.style.setProperty('--ln', `${String(rows.length).length + 1}ch`) }
  for (const r of rows.slice(0, MAX_LINES)) if (r) addRow(body, r); else body.append(make('div', 'sep', '⋯'))
  if (rows.length > MAX_LINES) body.append(folded(rows.slice(MAX_LINES).filter((r): r is Row => !!r), `… ${rows.length - MAX_LINES} more lines`))
  c.add = add
  c.del = del
  stat.append(make('span', 'a', `+${add}`), ' ', make('span', 'r', `−${del}`))
  // Changes and the viewer, linked: the file at this change's first line, once inFile has numbered it
  const show = iconButton(ICON.file, 'Show in file', () => {
    const d = c.querySelector('.diff'), r = d?.querySelector<HTMLElement>(':scope>.add[data-n]') ?? d?.querySelector<HTMLElement>(':scope>[data-n]')
    openInspector(file, 'viewer', undefined, r ? Number(r.dataset.n) : undefined)
  })
  show.addEventListener('click', e => e.stopPropagation()) // not also the header's fold
  h.append(who, stat, defField(), make('span', 'state', 'pending'), show)
  // click the header to fold the diff down to this one line
  h.tabIndex = 0
  h.setAttribute('role', 'button')
  h.setAttribute('aria-expanded', 'true')
  const fold = () => { const f = c.classList.toggle('folded'); h.setAttribute('aria-expanded', String(!f)) }
  h.onclick = fold
  h.onkeydown = e => { if (e.target === h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fold() } }
  c.append(h, body)
  definable(c) // on the change, not its rows: inFile swaps the rows for the file's
  return c
}

/** The change shown inside its file: numbered lines, AROUND lines of context each side, the rest folded. Before the
 *  edit is made the file holds the old text (an approval, or a live edit read right away); after, the edit is undone
 *  on the file's text to get the old one back. Stays the snippet when the file is new, binary or no longer matches.
 *  ponytail: a Write read after it happened can't be undone (the old text is gone): it stays shown as all added. */
export async function inFile(c: Change) {
  if (c.full) return
  c.full = true // once, whatever the answer
  const text = (await api<{ text: string | null }>('file?path=' + q(c.file)).catch(() => null))?.text
  if (text == null) return
  let before: string | null = text, after = applied(c.tool, text, c.inp)
  if (after == null || after === text) { after = text; before = unapplied(c.tool, text, c.inp) }
  if (before == null || before === after) return
  const box = make('div', 'diff num')
  let n = 1, add = 0, del = 0
  const rows = (k: Kind, lines: string[]): Row[] => lines.map(t => ({ k, t, n: k === 'del' ? undefined : n++ }))
  const parts = diffLines(before, after).map(p => ({ k: (p.added ? 'add' : p.removed ? 'del' : 'eq') as Kind, lines: p.value.replace(/\n$/, '').split('\n') }))
  parts.forEach((p, i) => {
    const len = p.lines.length, head = i > 0 ? AROUND : 0, tail = i < parts.length - 1 ? AROUND : 0
    if (p.k === 'add') add += len
    if (p.k === 'del') del += len
    if (p.k !== 'eq' || head + tail >= len) return rows(p.k, p.lines).forEach(r => addRow(box, r))
    rows('eq', p.lines.slice(0, head)).forEach(r => addRow(box, r))
    const hid = rows('eq', p.lines.slice(head, len - tail))
    box.append(folded(hid, `⋯ ${hid.length} lines ${!head ? 'above' : !tail ? 'below' : 'unchanged'}`))
    rows('eq', p.lines.slice(len - tail)).forEach(r => addRow(box, r))
  })
  box.style.setProperty('--ln', `${String(n).length + 1}ch`)
  openable(box, c.file) // a line number opens the whole file at that line
  c.querySelector('.diff')!.replaceWith(box)
  // a Write over a file that was there: its real counts, not the whole file as added
  const f = files.get(c.file)
  if (f?.changes.includes(c)) { f.add += add - c.add; f.del += del - c.del; paint(f) }
  c.add = add
  c.del = del
  c.querySelector('.stat')!.replaceChildren(make('span', 'a', `+${add}`), ' ', make('span', 'r', `−${del}`))
}

/** The file's text before an edit that's already made, or null when that can't be told (a Write, a replace_all, a
 *  deletion, or a new_string that isn't there). ponytail: first occurrence; text that repeats may pick the wrong one. */
function unapplied(tool: string, text: string, inp: Record<string, any>): string | null {
  if (tool === 'Write') return null
  for (const e of [...(tool === 'Edit' ? [inp] : inp.edits ?? [])].reverse()) {
    const a: string = e.old_string ?? '', b: string = e.new_string ?? ''
    if (!b || e.replace_all || !text.includes(b)) return null
    text = text.replace(b, () => a)
  }
  return text
}

/** The file's text once the edit is made, or null when an old_string isn't in it (the file changed since). */
function applied(tool: string, text: string, inp: Record<string, any>): string | null {
  if (tool === 'Write') return inp.content ?? ''
  for (const e of tool === 'Edit' ? [inp] : inp.edits ?? []) {
    const a: string = e.old_string ?? '', b: string = e.new_string ?? ''
    if (!a || !text.includes(a)) return null
    text = e.replace_all ? text.replaceAll(a, () => b) : text.replace(a, () => b)
  }
  return text
}

export function settleChange(c: Change, ok: boolean) {
  c.classList.remove('pending')
  c.classList.toggle('failed', !ok)
  c.querySelector('.state')!.textContent = ok ? '' : 'failed'
}

/** A unified diff as rows in the same style as the inspector's diffs, each numbered with its line in the new file
 *  (`data-n`, shown in the gutter; a removed line has its old one instead, `data-a`, not shown). */
export function unified(text: string) {
  const box = make('div', 'diff num')
  const lines = text.replace(/\n$/, '').split('\n')
  const start = lines.findIndex(l => l.startsWith('@@'))
  let a = 0, b = 0, last = 0
  // no hunk: git's header says why (an empty new file, a binary one, only its mode changed)
  const none = /^Binary files /m.test(text) ? '(binary file)' : /^(new|deleted) file mode/m.test(text) ? '(empty file)' : '(no textual changes)'
  for (const l of start < 0 ? [' ' + none] : lines.slice(start)) { // ' ': a context line, its marker sliced off
    if (l.startsWith('\\')) continue // "\ No newline at end of file"
    // a hunk header says where it is: git's function context, or the line number when there's none
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/.exec(l)
    if (h) {
      a = +h[1]; b = +h[2]
      // the unchanged stretch above it, for expandable(): new lines from..top-1, each old one off from it
      const s = box.appendChild(make('div', 'sep hunk', h[3] || `line ${b}`))
      Object.assign(s.dataset, { from: String(last + 1), top: String(b), off: String(a - b) })
      continue
    }
    const kind = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'eq', row = box.appendChild(make('div', kind, l.slice(1)))
    row.dataset.s = kind === 'add' ? '+' : kind === 'del' ? '−' : ''
    if (start < 0) continue
    if (kind !== 'add') row.dataset.a = String(a++)
    if (kind !== 'del') row.dataset.n = String(last = b++)
  }
  box.style.setProperty('--ln', `${String(last).length + 1}ch`) // the gutter fits the biggest number
  if (start >= 0) Object.assign(box.dataset, { from: String(last + 1), off: String(a - b) }) // and what's after the end
  return box
}

/** Let a unified() diff of `path` open the file: clicking a line number opens it in its window at that line. Only
 *  for a diff whose new side is the file on disk. */
export function openable(diff: HTMLElement, path: string) {
  diff.classList.add('opens')
  diff.addEventListener('click', e => {
    const r = e.target as HTMLElement
    if (r.parentElement !== diff || !r.dataset.n) return
    // the gutter is the row's first column; offsetX is in the row's own pixels, so it's right at any canvas zoom
    if (e.offsetX > parseFloat(getComputedStyle(r).gridTemplateColumns)) return
    e.stopPropagation() // not also a click on the line (a pull request's line comment)
    openFileAt(path, Number(r.dataset.n))
  }, true) // capturing: first, whenever this was added
}

/** A button that opens `path` in its window: at the first line `diff` adds, or the first it shows, when it's open. */
export function openFileButton(path: string, diff: () => HTMLElement | null) {
  const b = iconButton(ICON.file, `Open ${path}`, () => {
    const d = diff(), r = d?.querySelector<HTMLElement>(':scope>.add[data-n]') ?? d?.querySelector<HTMLElement>(':scope>[data-n]')
    openFileAt(path, r ? Number(r.dataset.n) : undefined)
  })
  b.addEventListener('click', e => e.preventDefault()) // in a <summary>: open the file, don't fold the diff
  return b
}
