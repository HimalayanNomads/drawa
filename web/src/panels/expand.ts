// More of the file around a unified() diff's hunks, ten lines at a time, as GitHub's review shows them: a hunk's
// header reveals the lines just above it (↑) or just below the hunk before (↓), and a last row the lines after the end.
// `load` gives the diff's new side once, on the first click (the file on disk, in the index, or at a commit). Added
// rows are plain context rows with both line numbers, so names and line numbers in them work as in the rest.
import { make, iconButton } from '../lib/dom'
import { api } from '../lib/api'

const STEP = 10
const UP = '<svg viewBox="0 0 16 16"><path d="M4 9.5 8 5.5l4 4"/></svg>', DOWN = '<svg viewBox="0 0 16 16"><path d="m4 6.5 4 4 4-4"/></svg>'

/** The new side's text from an API answer: null when there's none to show (deleted, binary, unreadable, over 1 MB). */
export const textOf = (path: string) => () => api<{ text: string | null; cut?: boolean }>(path).then(r => r.cut ? null : r.text, () => null) // cut: only its first 1 MB

export function expandable(diff: HTMLElement, load: () => Promise<string | null>) {
  if (!diff.dataset.from) return // no hunks, or a new or deleted file: nothing around them
  let lines: Promise<string[] | null> | undefined
  const text = () => lines ??= load().then(t => t == null ? null : t.replace(/\n$/, '').split('\n'))
  for (const s of diff.querySelectorAll<HTMLElement>(':scope > .sep.hunk')) controls(s, text, s === diff.firstElementChild)
  const tail = diff.appendChild(make('div', 'sep hunk tail'))
  Object.assign(tail.dataset, { from: diff.dataset.from, off: diff.dataset.off, top: String(Number.MAX_SAFE_INTEGER) })
  controls(tail, text, false)
}

function controls(s: HTMLElement, text: () => Promise<string[] | null>, first: boolean) {
  const n = (k: string) => Number(s.dataset[k])
  if (n('top') <= n('from')) return // nothing unchanged above this hunk
  const bar = make('span', 'xp'), tail = s.classList.contains('tail')
  const show = async (up: boolean) => {
    const all = await text()
    if (!s.isConnected) return // a quicker click already showed the rest of this stretch
    if (!all) { bar.remove(); if (tail) s.remove(); return } // the new side can't be read: no more to show
    if (tail) s.dataset.top = String(all.length + 1)
    const from = n('from'), top = n('top')
    const a = up ? Math.max(from, top - STEP) : from, b = up ? top : Math.min(top, from + STEP) // new lines a..b-1
    const rows = all.slice(a - 1, b - 1).map((t, i) => row(t, a + i, n('off')))
    if (up) { s.after(...rows); s.dataset.top = String(a) } else { s.before(...rows); s.dataset.from = String(b) }
    // the gutter fits the biggest number shown so far: a later stretch above can't narrow what the tail widened
    const box = s.parentElement!, most = Math.max(b - 1, Number(box.dataset.most ?? box.dataset.from))
    box.dataset.most = String(most)
    box.style.setProperty('--ln', `${String(most).length + 1}ch`)
    if (n('top') <= n('from')) s.remove() // the stretch is all shown: the header between its lines goes
    else label()
  }
  const label = () => {
    const left = n('top') - n('from')
    up.hidden = tail; down.hidden = first
    for (const [b, dir] of [[up, 'above'], [down, 'below']] as const) {
      const t = `Show ${Math.min(STEP, left)} more line${left > 1 ? 's' : ''} ${tail ? 'after the change' : dir}`
      b.title = t; b.setAttribute('aria-label', t)
    }
  }
  const up = iconButton(UP, '', () => show(true)), down = iconButton(DOWN, '', () => show(false))
  bar.append(up, down)
  s.prepend(bar)
  label()
}

function row(t: string, n: number, off: number) {
  const r = make('div', 'eq', t)
  Object.assign(r.dataset, { s: '', a: String(n + off), n: String(n) })
  return r
}
