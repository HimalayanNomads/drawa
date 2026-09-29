// The GitHub window: pull requests and issues of this repo (through the `gh` CLI), and one of them in detail: the
// conversation, the files changed, the checks. Anything here can go to Claude (see gh.ts). One per canvas, like Git.
import { make, ICON, iconButton, button, confirmBox, ping, extLink, ago } from '../lib/dom'
import { api, q } from '../lib/api'
import { md, enhance, enhanceMarked } from '../lib/markdown'
import { enhance as enhanceSelect } from '../lib/select'
import { persist } from '../lib/store'
import { items, savedRect, centerOn, spotBeside, changed, type Rect } from '../canvas/canvas'
import { makeWindow } from '../canvas/window'
import { forget } from '../canvas/graph'
import { referable } from '../canvas/refs'
import { unified } from '../panels/diff'
import { ghPost, getPr, getIssue, tally, dot, reviewWord, stateOf, REVIEW, sendToClaude, sendLabel, type Pr, type Issue, type PrRow, type IssueRow, type Check, type Note, type What } from './gh'

export const GH_ICON = '<svg viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="12.5" r="1.6"/><path d="M4 5.1v5.8M12 10.9V7a2.5 2.5 0 0 0-2.5-2.5H7M8.5 3 7 4.5 8.5 6"/></svg>'

type Tab = 'pr' | 'issue'
interface View { tab: Tab; state: string; n?: number; sub?: 'conv' | 'files' | 'checks' }
let win: { el: HTMLElement; body: HTMLElement; view: View; seen?: Pr | Issue | (PrRow | IssueRow)[]; failed?: boolean } | undefined

/** Open (or bring into view) the GitHub window, optionally at a pull request or issue (and one of its tabs). */
export function openGitHub(at?: { tab: Tab; n?: number; sub?: View['sub'] }, r?: Rect, saved?: View) {
  if (!win) {
    const { el, body } = makeWindow({
      kind: 'github', cls: 'ghnode', title: 'GitHub', minW: 320, minH: 240,
      rect: r ?? spotBeside(items('git')[0], Math.min(520, innerWidth - 32), 600, 60), // phones: fits the screen
      actions: [iconButton(ICON.x, 'Close', () => { forget(el); el.remove(); win = undefined; changed() }, 'closebtn')],
    })
    el.dataset.id = 'github'
    body.classList.add('ghbody')
    win = { el, body, view: saved ?? { tab: 'pr', state: 'open' } }
    if (!r) centerOn(el)
  } else { centerOn(win.el); ping(win.el) }
  if (at) win.view = { ...win.view, tab: at.tab, n: at.n, sub: at.sub ?? 'conv' }
  show()
  changed()
}

function show() {
  const w = win!
  w.seen = undefined
  w.failed = false
  if (w.view.n) return w.view.tab === 'pr' ? prDetail(w.view.n) : issueDetail(w.view.n)
  list()
}
const go = (v: Partial<View>) => { win!.view = { ...win!.view, ...v }; show(); changed() }
const fail = (box: HTMLElement, e: unknown) => box.replaceChildren(make('p', 'ghnote bad', (e as Error).message))
/** Load one pull request or issue into the window: undefined when it failed (the error is shown) or you moved on. */
async function load<T extends Pr | Issue>(what: string, get: () => Promise<T>) {
  const w = win!, v = w.view
  w.body.replaceChildren(make('p', 'ghnote', `Loading ${what}…`))
  let x: T
  try { x = await get() } catch (e) {
    if (win !== w || w.view !== v) return
    // not a dead end: back to the list, or try again (a rate limit, a gh login); a reload opens the list, not this
    w.failed = true
    const top = make('div', 'ghhead')
    top.append(button(`← All ${v.tab === 'pr' ? 'pull requests' : 'issues'}`, 'ghback', () => go({ n: undefined })))
    const again = make('div', 'ghacts')
    again.append(button('Retry', '', show))
    w.body.replaceChildren(top, make('p', 'ghnote bad', `Couldn't load ${what}: ${(e as Error).message}`), again)
    changed()
    return
  }
  if (win !== w || w.view !== v) return
  w.seen = x
  return x
}
const SHOWN = 50 // the server sends one more when there are more

/* ---------- lists ---------- */
const STATES: Record<Tab, string[]> = { pr: ['open', 'merged', 'closed', 'all'], issue: ['open', 'closed', 'all'] }

async function list() {
  const w = win!, v = w.view, bar = make('div', 'ghbar'), rows = make('div', 'ghlist')
  for (const [tab, label] of [['pr', 'Pull requests'], ['issue', 'Issues']] as const) {
    const b = button(label, v.tab === tab ? 'on' : '', () => go({ tab, state: 'open' }))
    b.setAttribute('aria-pressed', String(v.tab === tab))
    bar.append(b)
  }
  const sel = make('select')
  sel.setAttribute('aria-label', 'Show')
  for (const s of STATES[v.tab]) sel.append(new Option(s[0].toUpperCase() + s.slice(1), s, false, s === v.state))
  sel.onchange = () => go({ state: sel.value })
  bar.append(make('span', 'spacer'), sel, iconButton('<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/></svg>', 'Refresh', show))
  rows.append(make('p', 'ghnote', 'Loading…'))
  w.body.replaceChildren(bar, rows)
  enhanceSelect(sel)
  try {
    const data = await api<(PrRow | IssueRow)[]>(`gh/${v.tab === 'pr' ? 'prs' : 'issues'}?state=${v.state}`)
    if (win !== w || w.view !== v) return // moved on meanwhile
    w.seen = data.slice(0, SHOWN)
    rows.replaceChildren(...w.seen.map(row), ...(data.length ? [] : [make('p', 'ghnote', `No ${v.state === 'all' ? '' : v.state + ' '}${v.tab === 'pr' ? 'pull requests' : 'issues'}.`)]),
      ...(data.length > SHOWN ? [make('p', 'ghnote', `Showing the latest ${SHOWN}. Older ones are on GitHub.`)] : []))
  } catch (e) { fail(rows, e) }
}

function row(r: PrRow | IssueRow) {
  const b = make('button', 'ghrow'), top = make('span', 'ghrow-t'), sub = make('span', 'ghrow-m')
  b.dataset.state = stateOf(r as PrRow)
  const checks = 'checks' in r ? tally(r.checks) : null
  top.append(make('span', 'ghn', `#${r.number}`), make('span', 'ghti', r.title))
  if (checks?.state) top.append(Object.assign(dot(checks.state), { title: `Checks: ${checks.pass} passed, ${checks.fail} failed, ${checks.pending} running` }))
  sub.append(`${stateOf(r as PrRow)} · @${r.author} · ${ago(r.updated)}`)
  if ('review' in r && REVIEW[r.review]) sub.append(` · ${REVIEW[r.review]}`)
  for (const l of r.labels.slice(0, 4)) sub.append(make('span', 'ghlabel', l))
  b.append(top, sub)
  b.onclick = () => go({ n: r.number, sub: 'conv' })
  return b
}

// URLs in GitHub's data open only if they're https: (a commit status's targetUrl is whatever its sender set)
const https = (u: string) => /^https:\/\//i.test(u ?? '')
const ghLink = (url: string) => https(url) ? [extLink('btn', 'Open on GitHub', url)] : []

/* ---------- one pull request ---------- */
function header(title: string, n: number, back: string, state: string, facts: string[]) {
  const top = make('div', 'ghhead'), h = make('h3')
  top.append(button(`← ${back}`, 'ghback', () => go({ n: undefined })))
  h.append(title, ' ', make('span', 'ghn', `#${n}`))
  const meta = make('p', 'ghfacts'), badge = make('span', 'ghstate', state)
  badge.dataset.state = state
  meta.append(badge, ...facts.map(f => make('span', '', f)))
  top.append(h, meta)
  return top
}

async function prDetail(n: number) {
  const p = await load(`pull request #${n}`, () => getPr(n))
  if (!p) return
  const w = win!, v = w.view, t = tally(p.checks)
  const acts = make('div', 'ghacts')
  const send = (what: What) => () => sendToClaude(what, n, p.title)
  const sendChecks = button(`Failing checks${t.fail ? ` (${t.fail})` : ''}`, '', send('checks'))
  sendChecks.disabled = !t.fail
  const reviews = p.reviews.length + p.inline.length
  const sendReviews = button(`Review comments${reviews ? ` (${reviews})` : ''}`, '', send('reviews'))
  sendReviews.disabled = !reviews && !p.comments.length
  acts.append(make('span', 'ghsend', sendLabel() + ':'), button('This PR', 'ai', send('pr')), sendChecks, sendReviews,
    make('span', 'spacer'), button('Check out', '', () => checkout(p)), ...ghLink(p.url))
  const tabs = make('div', 'ghtabs'), pane = make('div', 'ghpane')
  const subs = [['conv', `Conversation${p.comments.length + p.reviews.length ? ` (${p.comments.length + p.reviews.length})` : ''}`], ['files', `Files (${p.files})`], ['checks', `Checks${p.checks.length ? ` (${t.pass}/${p.checks.length})` : ''}`]] as const
  for (const [k, label] of subs) {
    const b = button(label, (v.sub ?? 'conv') === k ? 'on' : '', () => { v.sub = k; tabs.querySelectorAll('.on').forEach(x => x.classList.remove('on')); b.classList.add('on'); fill(); changed() })
    tabs.append(b)
  }
  // on the page first: diagrams and code tools need it (conversation() builds them off it, enhanceMarked finishes them)
  const fill = () => { pane.replaceChildren(...(v.sub === 'files' ? files(p.diff) : v.sub === 'checks' ? checkList(p.checks) : conversation(p.body, [...p.comments, ...p.reviews]))); enhanceMarked(pane) }
  w.body.replaceChildren(header(p.title, n, 'All pull requests', stateOf(p), [`@${p.author}`, `${p.head} → ${p.base}`, `+${p.additions} −${p.deletions}`, ...(REVIEW[p.review] ? [REVIEW[p.review]] : [])]), acts, tabs, pane)
  fill()
}

function conversation(body: string, notes: Note[]) {
  const first = make('div', 'ghc md')
  first.innerHTML = md(body.trim() || '*No description.*')
  enhance(first)
  return [first, ...notes.sort((a, b) => a.when.localeCompare(b.when)).map(c => {
    const box = make('div', 'ghc'), who = make('p', 'ghwho'), text = make('div', 'md')
    who.append(make('b', '', `@${c.author}`), ` ${c.state ? reviewWord(c.state) + ' · ' : ''}${ago(c.when)}`)
    if (c.state) box.dataset.state = c.state.toLowerCase()
    text.innerHTML = md(c.body || '')
    enhance(text)
    box.append(who, ...(c.body ? [text] : []))
    return box
  })]
}

/** A multi-file diff as one foldable block per file. */
function files(diff: string) {
  const parts = diff.split(/^(?=diff --git )/m).filter(s => s.startsWith('diff --git'))
  if (!parts.length) return [make('p', 'ghnote', diff.trim() || 'No changes.')]
  return parts.map(part => {
    const d = make('details', 'ghfile'), s = make('summary')
    const path = /^diff --git a\/.+? b\/(.+)$/m.exec(part)?.[1] ?? 'file'
    const body = part.slice(part.search(/^@@/m) >>> 0) // counts from the first hunk: the header's ---/+++ lines aren't changes
    const add = (body.match(/^\+/gm) ?? []).length, del = (body.match(/^-/gm) ?? []).length
    s.append(make('span', 'ghpath', path), make('span', 'a', `+${add}`), make('span', 'r', `−${del}`))
    d.open = parts.length <= 8
    d.append(s, unified(part))
    return d
  })
}

function checkList(checks: Check[]) {
  if (!checks.length) return [make('p', 'ghnote', 'No checks ran on this pull request.')]
  const order = { fail: 0, pending: 1, pass: 2, skip: 3 }
  return [...checks].sort((a, b) => order[a.state] - order[b.state]).map(c => {
    const r = make('div', 'ghcheck')
    r.dataset.state = c.state
    r.append(dot(c.state), https(c.url) ? extLink('ghcheck-n', c.name, c.url) : make('span', 'ghcheck-n', c.name), make('span', 'ghcheck-s', c.state))
    if (c.state === 'fail' && c.url.includes('/actions/runs/')) {
      const pre = make('pre', 'ghlog')
      r.append(button('Show log', '', async () => {
        pre.textContent = 'Loading…'
        r.after(pre)
        pre.textContent = await api<{ log: string }>(`gh/log?url=${q(c.url)}`).then(x => x.log || '(empty)', e => (e as Error).message)
      }))
    }
    return r
  })
}

async function checkout(p: Pr) {
  if (!await confirmBox(`Check out #${p.number}?`, `Switches this folder to the branch ${p.head} (gh pr checkout). Uncommitted changes that conflict will stop it.`, 'Check out')) return
  const r = await ghPost({ op: 'checkout', n: p.number })
  await confirmBox(r.ok ? 'Checked out' : 'Checkout failed', r.out || (r.ok ? `On ${p.head} now.` : 'gh gave no reason.'), 'OK')
}

/* ---------- one issue ---------- */
async function issueDetail(n: number) {
  const i = await load(`issue #${n}`, () => getIssue(n))
  if (!i) return
  const w = win!, acts = make('div', 'ghacts')
  acts.append(make('span', 'ghsend', sendLabel() + ':'), button('This issue', 'ai', () => sendToClaude('issue', n, i.title)), make('span', 'spacer'), ...ghLink(i.url))
  const pane = make('div', 'ghpane'), box = make('form', 'ghreply'), ta = make('textarea')
  ta.rows = 3
  ta.placeholder = 'Comment on this issue'
  ta.setAttribute('aria-label', 'Comment')
  ta.addEventListener('keydown', e => e.stopPropagation())
  const post = button('Comment', 'primary', () => box.requestSubmit())
  post.type = 'submit'
  box.append(ta, post)
  box.onsubmit = async e => {
    e.preventDefault()
    if (!ta.value.trim() || !await confirmBox('Post this comment?', 'It is published on GitHub under your account.', 'Comment')) return
    const r = await ghPost({ op: 'comment', kind: 'issue', n, body: ta.value })
    if (r.ok) show()
    else await confirmBox('Comment failed', r.out ?? '', 'OK')
  }
  pane.append(...conversation(i.body, i.comments), box)
  w.body.replaceChildren(header(i.title, n, 'All issues', i.state.toLowerCase(), [`@${i.author}`, ago(i.created), ...i.labels]), acts, pane)
  enhanceMarked(pane)
}

/* ---------- saved, and readable by Claude ---------- */
persist('github', () => (win ? { rect: savedRect(win.el), view: win.failed ? { ...win.view, n: undefined } : win.view } : null),
  (s: { rect: Rect; view: View } | null) => { if (s) openGitHub(undefined, s.rect, s.view) })
referable('github', {
  icon: '⇄',
  label: () => 'GitHub',
  content: () => {
    const s = win?.seen
    if (!s) return { text: 'The GitHub window (nothing loaded yet).' }
    if (Array.isArray(s)) return { text: `GitHub ${win!.view.tab === 'pr' ? 'pull requests' : 'issues'} (${win!.view.state}):\n` + s.map(r => `#${r.number} ${r.title} (@${r.author}, ${stateOf(r as PrRow)})`).join('\n') }
    return { text: `GitHub ${'diff' in s ? 'pull request' : 'issue'} #${s.number}: ${s.title}\n${s.url}\n\n${s.body}` }
  },
})
