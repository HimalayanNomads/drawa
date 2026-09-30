// A diff block for every Edit / MultiEdit / Write. Blocks live on their file's node; the inspector shows them.
import { diffLines } from 'diff'
import { make } from '../lib/dom'
import { api, q } from '../lib/api'
import type { Session } from '../session/session'

export type Change = HTMLDivElement & { file: string; add: number; del: number }
const MAX_LINES = 600 // ponytail: per-change cap; huge writes are unreadable as a diff anyway
const AROUND = 1000 // file lines shown above and below an edit waiting for approval

export function change(S: Session, tool: string, file: string, inp: Record<string, any>): Change | undefined {
  const pairs: [string, string][] | null =
    tool === 'Write' ? [['', inp.content ?? '']]
    : tool === 'Edit' ? [[inp.old_string ?? '', inp.new_string ?? '']]
    : tool === 'MultiEdit' ? (inp.edits ?? []).map((e: any) => [e.old_string ?? '', e.new_string ?? ''])
    : null
  if (!pairs) return

  const c = make('div', 'chg pending') as Change, h = make('div', 'h'), who = make('span', 'who'), stat = make('span', 'stat'), body = make('div', 'diff')
  c.file = file
  who.append(make('b', tool === 'Write' ? 'write' : '', tool === 'Write' ? 'write' : 'edit'), S.title)
  who.title = `From session: ${S.title}`

  let add = 0, del = 0, shown = 0
  pairs.forEach(([a, b], n) => {
    if (n) body.append(make('div', 'sep', '⋯'))
    for (const part of diffLines(a, b)) {
      const lines = part.value.replace(/\n$/, '').split('\n')
      if (part.added) add += lines.length
      if (part.removed) del += lines.length
      for (const l of lines) {
        if (shown++ >= MAX_LINES) continue
        const row = body.appendChild(make('div', part.added ? 'add' : part.removed ? 'del' : 'eq', l))
        row.dataset.s = part.added ? '+' : part.removed ? '−' : ''
      }
    }
  })
  if (shown > MAX_LINES) body.append(make('div', 'sep', `… ${shown - MAX_LINES} more lines`))
  c.add = add
  c.del = del
  stat.append(make('span', 'a', `+${add}`), ' ', make('span', 'r', `−${del}`))
  h.append(who, stat, make('span', 'state', 'pending'))
  // click the header to fold the diff down to this one line
  h.tabIndex = 0
  h.setAttribute('role', 'button')
  h.setAttribute('aria-expanded', 'true')
  const fold = () => { const f = c.classList.toggle('folded'); h.setAttribute('aria-expanded', String(!f)) }
  h.onclick = fold
  h.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fold() } }
  c.append(h, body)
  return c
}

/** An edit waiting for approval, shown inside its file (up to AROUND lines each side) and scrolled to the change,
 *  so you can read around it. Falls back to the snippet when the file is new, binary or no longer holds the edit. */
export async function inFile(c: Change, tool: string, inp: Record<string, any>) {
  const before = (await api<{ text: string | null }>('file?path=' + q(c.file)).catch(() => null))?.text
  const after = before == null ? null : applied(tool, before, inp)
  if (before == null || after == null || !c.isConnected) return
  const parts = diffLines(before, after).map(p => ({ kind: p.added ? 'add' : p.removed ? 'del' : 'eq', lines: p.value.replace(/\n$/, '').split('\n') }))
  if (parts.every(p => p.kind === 'eq')) return
  const box = make('div', 'diff')
  let mark: Element | undefined
  const rows = (kind: string, lines: string[]) => lines.forEach(l => {
    const row = box.appendChild(make('div', kind, l))
    row.dataset.s = kind === 'add' ? '+' : kind === 'del' ? '−' : ''
    if (kind !== 'eq') mark ??= row
  })
  // unchanged stretches keep AROUND lines next to each change; the rest folds into one row
  parts.forEach((p, i) => {
    const len = p.lines.length, head = i > 0 ? AROUND : 0, tail = i < parts.length - 1 ? AROUND : 0
    if (p.kind !== 'eq' || head + tail >= len) return rows(p.kind, p.lines)
    rows('eq', p.lines.slice(0, head))
    box.append(make('div', 'sep', `⋯ ${len - head - tail} lines ${!head ? 'above' : !tail ? 'below' : 'unchanged'}`))
    rows('eq', p.lines.slice(len - tail))
  })
  c.querySelector('.diff')!.replaceWith(box)
  if (mark) box.scrollTop = mark.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3
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

/** A unified diff as rows in the same style as the inspector's diffs. */
export function unified(text: string) {
  const box = make('div', 'diff')
  const lines = text.replace(/\n$/, '').split('\n')
  const start = lines.findIndex(l => l.startsWith('@@'))
  for (const l of start < 0 ? ['(no textual changes)'] : lines.slice(start)) {
    if (l.startsWith('\\')) continue // "\ No newline at end of file"
    // a hunk header says where it is: git's function context, or the line number when there's none
    if (l.startsWith('@@')) { box.append(make('div', 'sep hunk', l.replace(/^@@ -\d+(?:,\d+)? \+(\d+).*?@@\s?(.*)$/, (_, n, ctx) => ctx || `line ${n}`))); continue }
    const kind = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'eq'
    box.appendChild(make('div', kind, l.slice(1))).dataset.s = kind === 'add' ? '+' : kind === 'del' ? '−' : ''
  }
  return box
}
