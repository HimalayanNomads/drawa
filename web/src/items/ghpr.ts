// One pull request in the GitHub window: its conversation (comment, review), its files (with the review comments
// under their lines, and a comment on any line), its checks; merge, close, reopen, mark ready, check out.
import { make, button, confirmBox, toast } from '../lib/dom'
import { api } from '../lib/api'
import { enhanceMarked } from '../lib/markdown'
import { enhance as enhanceSelect } from '../lib/select'
import { changed } from '../canvas/canvas'
import { unified, openable, openFileButton } from '../panels/diff'
import { ghPost, getPr, getChecks, tally, stateOf, REVIEW, sendToClaude, sendLabel, publish, whoami, here as ghRepo, type Pr, type Inline, type What } from './gh'
import { win, load, header, conversation, note, writeBox, commentOn, ghLink, show, still } from './github'
import { checkList, whilePending } from './ghruns'

export async function prDetail(n: number) {
  const p = await load(`pull request #${n}`, () => getPr(n))
  if (!p) return
  const w = win!, v = w.view
  const tabs = make('div', 'ghtabs'), pane = make('div', 'ghpane')
  const label = (k: string) => k === 'conv' ? `Conversation${p.comments.length + p.reviews.length ? ` (${p.comments.length + p.reviews.length})` : ''}`
    : k === 'files' ? `Files (${p.files})` : `Checks${p.checks.length ? ` (${tally(p.checks).pass}/${p.checks.length})` : ''}`
  for (const k of ['conv', 'files', 'checks'] as const) {
    const b = button(label(k), (v.sub ?? 'conv') === k ? 'on' : '', () => { v.sub = k; tabs.querySelectorAll('.on').forEach(x => x.classList.remove('on')); b.classList.add('on'); fill(); changed() })
    b.dataset.sub = k
    tabs.append(b)
  }
  // on the page first: diagrams and code tools need it (conversation() builds them off it, enhanceMarked finishes them)
  const fill = () => {
    pane.replaceChildren(...(v.sub === 'files' ? files(p) : v.sub === 'checks' ? checkList(p.checks) : [...conversation(p.body, [...p.comments, ...p.reviews]), ...(p.state === 'OPEN' ? [reviewBar(p)] : [])]))
    enhanceMarked(pane)
  }
  w.body.replaceChildren(header(p.title, n, 'All pull requests', stateOf(p), [`@${p.author}`, `${p.head} → ${p.base}`, `+${p.additions} −${p.deletions}`, ...(REVIEW[p.review] ? [REVIEW[p.review]] : [])]), sendBar(p, fill), manage(p), tabs, pane)
  fill()
  // running checks settle on their own: only the checks are asked again, and redrawn when they change
  whilePending(v, () => p.checks.some(c => c.state === 'pending'), async () => {
    const checks = await getChecks(n)
    if (!still(w, v) || JSON.stringify(checks) === JSON.stringify(p.checks)) return
    p.checks = checks
    tabs.querySelector<HTMLElement>('[data-sub=checks]')!.textContent = label('checks')
    if (v.sub === 'checks') fill()
  })
}

function sendBar(p: Pr, redraw: () => void) {
  const acts = make('div', 'ghacts'), t = tally(p.checks)
  const send = (what: What) => () => sendToClaude(what, p.number, p.title)
  const sendChecks = button(`Failing checks${t.fail ? ` (${t.fail})` : ''}`, '', send('checks'))
  sendChecks.disabled = !t.fail
  const reviews = p.reviews.length + p.inline.length
  const sendReviews = button(`Review comments${reviews ? ` (${reviews})` : ''}`, '', send('reviews'))
  sendReviews.disabled = !reviews && !p.comments.length
  acts.append(make('span', 'ghsend', sendLabel() + ':'), button('This PR', 'ai', send('pr')), sendChecks, sendReviews,
    make('span', 'spacer'), button('Check out', '', () => checkout(p, redraw)), ...ghLink(p.url))
  return acts
}

const METHODS: [string, string][] = [['squash', 'Squash and merge'], ['merge', 'Create a merge commit'], ['rebase', 'Rebase and merge']]

/** Merge (by the method picked), mark ready, close or reopen: what the pull request's state allows. */
function manage(p: Pr) {
  const bar = make('div', 'ghacts ghmanage'), n = p.number, what = `pull request #${n} "${p.title}"`
  const act = (title: string, text: string, action: string, body: object, done: string) => async () => {
    if (await publish(title, text, action, { n, ...body }, done)) show()
  }
  if (p.state === 'OPEN' && !p.draft) {
    const sel = make('select')
    sel.setAttribute('aria-label', 'Merge method')
    for (const [m, l] of METHODS) sel.append(new Option(l, m))
    const go = button('Merge', 'primary', () => act('Merge this pull request?', `${METHODS.find(m => m[0] === sel.value)![1]}: ${what}, ${p.head} into ${p.base}.`, 'Merge', { op: 'merge', method: sel.value }, `Merged #${n}.`)())
    if (p.mergeable === 'CONFLICTING') { go.disabled = true; go.title = 'This branch has conflicts with the base branch' }
    bar.append(sel, go)
    queueMicrotask(() => enhanceSelect(sel)) // on the page first
  }
  if (p.state === 'OPEN' && p.draft) bar.append(button('Ready for review', 'primary', act('Mark ready for review?', `Takes ${what} out of draft and asks for reviews.`, 'Mark ready', { op: 'state', kind: 'pr', action: 'ready' }, `#${n} is ready for review.`)))
  bar.append(make('span', 'spacer'))
  if (p.state === 'OPEN') bar.append(button('Close', '', act('Close this pull request?', `Closes ${what} without merging.`, 'Close', { op: 'state', kind: 'pr', action: 'close' }, `Closed #${n}.`)))
  if (p.state === 'CLOSED') bar.append(button('Reopen', '', act('Reopen this pull request?', `Reopens ${what}.`, 'Reopen', { op: 'state', kind: 'pr', action: 'reopen' }, `Reopened #${n}.`)))
  return bar
}

/** The comment box under the conversation: a comment, or a review (approve, request changes, comment). */
function reviewBar(p: Pr) {
  const n = p.number
  const review = (event: string, word: string) => async (text: string) => {
    if (event !== 'approve' && !text) { toast('Write what the review says first.'); return false }
    const r = await publish(`${word}?`, `${word} on pull request #${n} "${p.title}"${text ? `, saying:\n\n${text}` : '.'}`, word, { op: 'review', n, event, body: text }, 'Review submitted.')
    if (r) show()
    return !!r
  }
  const box = writeBox('Comment, or write a review', [
    ['Approve', '', review('approve', 'Approve')],
    ['Request changes', '', review('request-changes', 'Request changes')],
    ['Review comment', '', review('comment', 'Comment as a review')],
    ['Comment', 'primary', commentOn('pr', n)],
  ])
  box.querySelector('.row')!.prepend(make('span', 'ghsend', 'Review:'))
  return box
}

/** Each file as a foldable diff, its review comments under their lines (outdated ones above it). Click a line to
 *  comment on it. ponytail: pointer only; from the keyboard, comment on github.com (a focus stop per diff line would
 *  make a big diff untabbable). When HEAD is the pull request's newest commit, the files on disk are its files (bar
 *  uncommitted edits): each opens in its window, from its button or a line number. A nested repo's paths get its
 *  folder in front. ponytail: the project's own repo's paths are from its top, so a project opened in a subfolder of
 *  its repo can't open them; and HEAD is checked when the tab is drawn (and after Check out here), so a branch switched
 *  elsewhere shows only once the tab is drawn again. */
function files(p: Pr) {
  const parts = p.diff.split(/^(?=diff --git )/m).filter(s => s.startsWith('diff --git'))
  if (!parts.length) return [make('p', 'ghnote', p.diff.trim() || 'No changes.')]
  const open = p.state === 'OPEN', onHead: (() => void)[] = []
  const repo = ghRepo() // the pull request's: '' the project's own repo, else a nested repo's folder
  api<{ head?: string; nested?: { dir?: string; head?: string }[] }>('git').then(g => {
    const st = repo ? g.nested?.find(n => n.dir === repo) : g
    if (st?.head && st.head === p.headOid) onHead.forEach(f => f())
  }, () => {})
  return parts.map(part => {
    const d = make('details', 'ghfile'), s = make('summary')
    const path = /^diff --git a\/.+? b\/(.+)$/m.exec(part)?.[1] ?? 'file'
    const body = part.slice(part.search(/^@@/m) >>> 0) // counts from the first hunk: the header's ---/+++ lines aren't changes
    const add = (body.match(/^\+/gm) ?? []).length, del = (body.match(/^-/gm) ?? []).length
    const here = p.inline.filter(c => c.path === path)
    s.append(make('span', 'ghpath', path), ...(here.length ? [make('span', 'ghcount', `${here.length} comment${here.length > 1 ? 's' : ''}`)] : []), make('span', 'a', `+${add}`), make('span', 'r', `−${del}`))
    d.open = parts.length <= 8 || here.length > 0
    const diff = unified(part), rows = [...diff.children] as HTMLElement[]
    // where each row is as GitHub's review comments count it: a removed line by its old number, others by their new
    for (const r of rows) if (r.dataset.n || r.dataset.a) { r.dataset.line = r.dataset.n ?? r.dataset.a; r.dataset.side = r.dataset.n ? 'RIGHT' : 'LEFT' }
    const disk = repo ? `${repo}/${path}` : path // the project's path for it
    if (!/^deleted file mode/m.test(part)) onHead.push(() => { s.querySelector('.ghcount, .a')!.before(openFileButton(disk, () => diff)); openable(diff, disk) })
    for (const c of here.filter(c => !c.outdated)) {
      const r = rows.find(r => r.dataset.line === String(c.line) && r.dataset.side === c.side)
      if (r) under(r, inl(c))
      else diff.prepend(inl(c, true))
    }
    for (const c of here.filter(c => c.outdated)) diff.prepend(inl(c, true))
    if (open) {
      diff.classList.add('ghcommentable')
      diff.onclick = e => {
        const r = (e.target as HTMLElement).closest<HTMLElement>('.diff>[data-line]')
        if (r && getSelection()?.isCollapsed !== false) lineForm(p.number, path, r)
      }
    }
    d.append(s, diff)
    return d
  })
}

/** Put `el` after row `r` and after the comments already under it. */
function under(r: HTMLElement, el: HTMLElement) {
  let at = r
  while (at.nextElementSibling?.classList.contains('ghinl')) at = at.nextElementSibling as HTMLElement
  at.after(el)
}

function inl(c: Inline, apart = false) {
  const box = make('div', 'ghinl')
  if (apart) box.append(make('p', 'ghwhere', `${c.outdated ? 'Outdated · ' : ''}line ${c.line ?? '?'}`))
  box.append(note(c))
  return box
}

/** The box for a new comment on one line of the diff, right under it. */
function lineForm(n: number, path: string, r: HTMLElement) {
  if (r.nextElementSibling?.classList.contains('ghline-f')) return
  const line = Number(r.dataset.line), side = r.dataset.side as Inline['side']
  const f = make('div', 'ghinl ghline-f')
  const box = writeBox(`Comment on ${path} line ${line}`, [
    ['Cancel', '', async () => { f.remove(); return false }],
    ['Comment', 'primary', async text => {
      if (!text) return false
      const ok = await publish('Comment on this line?', `On pull request #${n}, ${path} line ${line}${side === 'LEFT' ? ' (removed)' : ''}:\n\n${text}`, 'Comment', { op: 'linecomment', n, path, line, side, body: text }, 'Line comment posted.')
      if (!ok) return false
      const me = await whoami()
      f.replaceWith(inl({ author: me?.login ?? 'you', body: text, when: new Date().toISOString(), path, line, side, outdated: false, hunk: '' }))
      return true
    }],
  ])
  f.append(box)
  under(r, f)
  f.querySelector('textarea')!.focus()
}

/** Check out, then `redraw` the pull request: HEAD is now its newest commit, so its files open from disk. */
async function checkout(p: Pr, redraw: () => void) {
  if (!await confirmBox(`Check out #${p.number}?`, `Switches this folder to the branch ${p.head} (gh pr checkout). Uncommitted changes that conflict will stop it.`, 'Check out')) return
  const r = await ghPost({ op: 'checkout', n: p.number })
  if (r.ok) redraw()
  await confirmBox(r.ok ? 'Checked out' : 'Checkout failed', r.out || (r.ok ? `On ${p.head} now.` : 'gh gave no reason.'), 'OK')
}
