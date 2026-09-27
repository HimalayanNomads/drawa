// What changed between two versions of a plan, marked in the new version's rendered Markdown: blocks and list
// items are matched by their text; an edited one gets its words marked (<ins>, and <del class="pdel"> for what
// went), and added or removed ones are marked whole (.pnew, and .pgone put back struck through where it was).
// ponytail: code blocks and tables are marked whole; a line diff for those if they turn out to change a lot.
import { diffArrays, diffWordsWithSpace } from 'diff'
import { make } from '../lib/dom'
import { md } from '../lib/markdown'

export interface Changes { added: number; removed: number; edited: number }

const text = (e: Element) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()

/** Marks `body` (the new version, rendered) against `was` (the previous version's Markdown). */
export function markChanges(body: HTMLElement, was: string): Changes {
  const old = make('div')
  old.innerHTML = md(was)
  const n = { added: 0, removed: 0, edited: 0 }
  kids(old, body, n)
  return n
}

function kids(from: Element, to: Element, n: Changes) {
  const a = [...from.children], b = [...to.children]
  let i = 0, j = 0
  const parts = diffArrays(a.map(text), b.map(text))
  for (let k = 0; k < parts.length;) {
    if (!parts[k].added && !parts[k].removed) { i += parts[k].value.length; j += parts[k++].value.length; continue }
    let gone = 0, fresh = 0 // one run of changes: what went and what replaced it
    for (; k < parts.length && (parts[k].added || parts[k].removed); k++) parts[k].added ? fresh += parts[k].value.length : gone += parts[k].value.length
    pair(a.slice(i, i += gone), b.slice(j, j += fresh), to, b[j] ?? null, n)
  }
}

/** Blocks that went and blocks that came at the same spot: a new one with the same tag as an old one ahead of
 *  it is that one edited; old ones skipped on the way come back struck through, before it. */
function pair(gone: Element[], fresh: Element[], parent: Element, next: Element | null, n: Changes) {
  let g = 0
  const drop = (to: number, at: Element | null) => { for (; g < to; g++) { gone[g].classList.add('pgone'); parent.insertBefore(gone[g], at); n.removed++ } }
  for (const e of fresh) {
    const k = gone.findIndex((o, i) => i >= g && o.tagName === e.tagName)
    if (k < 0) { e.classList.add('pnew'); n.added++; continue }
    drop(k, e)
    edit(gone[g++], e, n)
  }
  drop(gone.length, next)
}

function edit(o: Element, e: Element, n: Changes) {
  if (/^[UO]L$/.test(e.tagName)) return kids(o, e, n) // only the items that changed
  n.edited++
  if (!/^(PRE|TABLE)$/.test(e.tagName) && words(e, o.textContent ?? '')) return
  o.classList.add('pgone')
  e.before(o)
  e.classList.add('pnew')
}

/** Marks the changed words in `el`, unless most of it changed (then the old and new blocks read better). */
function words(el: Element, was: string): boolean {
  const parts = diffWordsWithSpace(was, el.textContent ?? '') // spaces as tokens, so offsets add up
  const size = (add: boolean) => parts.filter(p => add ? p.added || p.removed : !p.added && !p.removed).reduce((s, p) => s + p.value.trim().length, 0)
  if (size(true) > size(false)) return false
  const ops: { at: number; end?: number; gone?: string }[] = []
  let pos = 0
  for (const p of parts) {
    if (p.removed) { if (p.value.trim()) ops.push({ at: pos, gone: p.value.trim() }); continue }
    const lead = p.value.length - p.value.trimStart().length, core = p.value.trim().length
    if (p.added && core) ops.push({ at: pos + lead, end: pos + lead + core })
    pos += p.value.length
  }
  const nodes: { t: Text; start: number }[] = []
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let at = 0, t: Node | null; (t = walk.nextNode());) { nodes.push({ t: t as Text, start: at }); at += (t as Text).length }
  // back to front, so the offsets still ahead stay valid (a split keeps the text before it in the same node);
  // at the same spot the insertion is wrapped first, so the removed words land before it
  ops.sort((x, y) => y.at - x.at || (x.end ? -1 : 1))
  for (const op of ops) {
    const r = document.createRange()
    if (op.gone !== undefined) {
      const at = nodes.find(x => op.at <= x.start + x.t.length)
      if (!at) { el.append(make('del', 'pdel', op.gone)); continue }
      r.setStart(at.t, op.at - at.start)
      r.insertNode(make('del', 'pdel', op.gone))
      continue
    }
    for (const x of [...nodes].reverse()) { // an insertion can cross inline markup: wrap its piece in each text node
      const s = Math.max(op.at, x.start) - x.start, e = Math.min(op.end!, x.start + x.t.length) - x.start
      if (e <= s || !x.t.data.slice(s, e).trim()) continue
      r.setStart(x.t, s)
      r.setEnd(x.t, e)
      r.surroundContents(make('ins'))
    }
  }
  return true
}
