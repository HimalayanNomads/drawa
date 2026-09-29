// The GitHub window: pull requests, issues and workflow runs of this repo (through the `gh` CLI), searchable, and one
// pull request or issue in detail (ghpr.ts, ghissue.ts; runs and checks in ghruns.ts). Anything here can go to Claude
// (see gh.ts), and every write asks first (publish() in gh.ts). One per canvas, like Git.
import { make, ICON, iconButton, button, ping, extLink, ago, pressed } from '../lib/dom'
import { api, q } from '../lib/api'
import { md, enhance } from '../lib/markdown'
import { enhance as enhanceSelect } from '../lib/select'
import { persist } from '../lib/store'
import { items, savedRect, centerOn, spotBeside, changed, type Rect } from '../canvas/canvas'
import { makeWindow } from '../canvas/window'
import { forget } from '../canvas/graph'
import { referable } from '../canvas/refs'
import { tally, dot, reviewWord, stateOf, REVIEW, publish, type Pr, type Issue, type PrRow, type IssueRow, type Note, type Run } from './gh'
import { prDetail } from './ghpr'
import { issueDetail, newIssue } from './ghissue'
import { runList } from './ghruns'

export const GH_ICON = '<svg viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="12.5" r="1.6"/><path d="M4 5.1v5.8M12 10.9V7a2.5 2.5 0 0 0-2.5-2.5H7M8.5 3 7 4.5 8.5 6"/></svg>'
const REFRESH = '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/></svg>'

type Tab = 'pr' | 'issue' | 'runs'
/** What the window shows. q and filter narrow the lists (GitHub search syntax; mine / review / assigned). */
export interface View { tab: Tab; state: string; n?: number; sub?: 'conv' | 'files' | 'checks'; q?: string; filter?: string }
export let win: { el: HTMLElement; body: HTMLElement; view: View; seen?: Pr | Issue | (PrRow | IssueRow | Run)[]; failed?: boolean; more: number } | undefined

/** Open (or bring into view) the GitHub window, optionally at a pull request or issue (and one of its tabs). */
export function openGitHub(at?: { tab: 'pr' | 'issue'; n?: number; sub?: View['sub'] }, r?: Rect, saved?: View) {
  if (!win) {
    const { el, body } = makeWindow({
      kind: 'github', cls: 'ghnode', title: 'GitHub', minW: 320, minH: 240,
      rect: r ?? spotBeside(items('git')[0], Math.min(520, innerWidth - 32), 600, 60), // phones: fits the screen
      actions: [iconButton(ICON.x, 'Close', () => { forget(el); el.remove(); win = undefined; changed() }, 'closebtn')],
    })
    el.dataset.id = 'github'
    body.classList.add('ghbody')
    win = { el, body, view: saved ?? { tab: 'pr', state: 'open' }, more: 0 }
    if (!r) centerOn(el)
  } else { centerOn(win.el); ping(win.el) }
  if (at) win.view = { ...win.view, tab: at.tab, n: at.n, sub: at.sub ?? 'conv' }
  show()
  changed()
}

export function show() {
  const w = win!
  w.seen = undefined
  w.failed = false
  if (w.view.n) return w.view.tab === 'pr' ? prDetail(w.view.n) : issueDetail(w.view.n)
  if (w.view.tab === 'runs') return runList()
  list()
}
/** Move the window to another view. A new view object: loads still running for the old one see it and stop. */
export const go = (v: Partial<View>) => { win!.view = { ...win!.view, ...v }; win!.more = 0; show(); changed() }
export const fail = (box: HTMLElement, e: unknown) => box.replaceChildren(make('p', 'ghnote bad', (e as Error).message))
/** Is this still what the window shows? (A slow load mustn't draw over where you went meanwhile.) */
export const still = (w: typeof win, v: View) => win === w && w!.view === v

/** Load one pull request or issue into the window: undefined when it failed (the error is shown) or you moved on. */
export async function load<T extends Pr | Issue>(what: string, get: () => Promise<T>) {
  const w = win!, v = w.view
  w.body.replaceChildren(make('p', 'ghnote', `Loading ${what}…`))
  let x: T
  try { x = await get() } catch (e) {
    if (!still(w, v)) return
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
  if (!still(w, v)) return
  w.seen = x
  return x
}
export const SHOWN = 50 // a page of a list; the server sends one more when there are more
const CAP = 500 // the server's most; past it, a narrower search

/* ---------- lists ---------- */
const STATES: Record<Tab, string[]> = { pr: ['open', 'merged', 'closed', 'all'], issue: ['open', 'closed', 'all'], runs: [] }
const FILTERS: Record<Tab, [string, string][]> = {
  pr: [['mine', 'Mine'], ['review', 'Review requested'], ['assigned', 'Assigned to me']],
  issue: [['mine', 'Mine'], ['assigned', 'Assigned to me']], runs: [],
}

/** The top bar every list shares: Pull requests / Issues / Actions, then `extra` (a state menu), then Refresh. */
export function topBar(...extra: HTMLElement[]) {
  const v = win!.view, bar = make('div', 'ghbar'), tabs = make('span', 'ghkinds')
  for (const [tab, label] of [['pr', 'Pull requests'], ['issue', 'Issues'], ['runs', 'Actions']] as const) {
    const b = button(label, '', () => go({ tab, state: 'open', n: undefined, filter: undefined, q: undefined }))
    pressed(b, v.tab === tab)
    tabs.append(b)
  }
  bar.append(tabs, make('span', 'spacer'), ...extra, iconButton(REFRESH, 'Refresh', show))
  return bar
}

/** Rows of a list, and Load more under them while there are more (up to CAP). */
export async function pages<T>(rows: HTMLElement, get: (limit: number) => Promise<T[]>, draw: (r: T) => HTMLElement, none: string) {
  const w = win!, v = w.view, limit = SHOWN + w.more
  if (!rows.childElementCount) rows.replaceChildren(make('p', 'ghnote', 'Loading…')) // a reload keeps its rows (and the scroll) until the new ones are in
  try {
    const data = await get(limit)
    if (!still(w, v)) return
    const shown = data.slice(0, limit)
    w.seen = shown as typeof w.seen
    const more = data.length > limit
    const next = button('Load more', 'ghmore', () => { next.disabled = true; next.textContent = 'Loading…'; w.more += SHOWN; pages(rows, get, draw, none) })
    rows.replaceChildren(...shown.map(draw), ...(data.length ? [] : [make('p', 'ghnote', none)]),
      ...(more && limit < CAP ? [next] : []),
      ...(more && limit >= CAP ? [make('p', 'ghnote', `Showing the latest ${limit}. Narrow the search for older ones.`)] : []))
  } catch (e) { if (still(w, v)) fail(rows, e) }
}

function list() {
  const w = win!, v = w.view, rows = make('div', 'ghlist')
  const sel = make('select')
  sel.setAttribute('aria-label', 'Show')
  for (const s of STATES[v.tab]) sel.append(new Option(s[0].toUpperCase() + s.slice(1), s, false, s === v.state))
  sel.onchange = () => go({ state: sel.value })
  w.body.replaceChildren(topBar(sel), finder(v), rows)
  enhanceSelect(sel)
  const kind = v.tab === 'pr' ? 'pull requests' : 'issues'
  pages(rows, limit => api<(PrRow | IssueRow)[]>(`gh/${v.tab === 'pr' ? 'prs' : 'issues'}?state=${v.state}&q=${q(v.q ?? '')}&filter=${v.filter ?? ''}&limit=${limit}`),
    row, `No ${v.state === 'all' ? '' : v.state + ' '}${kind}${v.q || v.filter ? ' match' : ''}.`)
}

/** The search box (GitHub search syntax: author:x label:bug text) and the quick filters, over a list. */
function finder(v: View) {
  const box = make('form', 'ghfind'), input = make('input'), chips = make('div', 'row')
  Object.assign(input, { type: 'search', value: v.q ?? '', placeholder: 'Search: author:x label:bug text' })
  input.setAttribute('aria-label', `Search ${v.tab === 'pr' ? 'pull requests' : 'issues'} (GitHub search syntax)`)
  input.addEventListener('keydown', e => e.stopPropagation())
  box.onsubmit = e => { e.preventDefault(); go({ q: input.value.trim() || undefined }) }
  for (const [f, label] of FILTERS[v.tab]) {
    const b = button(label, '', () => go({ filter: v.filter === f ? undefined : f }))
    b.type = 'button'
    pressed(b, v.filter === f)
    chips.append(b)
  }
  if (v.tab === 'issue') chips.append(make('span', 'spacer'), Object.assign(button('New issue', 'primary', newIssue), { type: 'button' }))
  box.append(input, chips)
  return box
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
export const https = (u: string) => /^https:\/\//i.test(u ?? '')
export const ghLink = (url: string) => https(url) ? [extLink('btn', 'Open on GitHub', url)] : []

/* ---------- shared by the pull request and issue views ---------- */
export function header(title: string, n: number, back: string, state: string, facts: string[]) {
  const top = make('div', 'ghhead'), h = make('h3')
  top.append(button(`← ${back}`, 'ghback', () => go({ n: undefined })))
  h.append(title, ' ', make('span', 'ghn', `#${n}`))
  const meta = make('p', 'ghfacts'), badge = make('span', 'ghstate', state)
  badge.dataset.state = state
  meta.append(badge, ...facts.map(f => make('span', '', f)))
  top.append(h, meta)
  return top
}

export function conversation(body: string, notes: Note[]) {
  const first = make('div', 'ghc md')
  first.innerHTML = md(body.trim() || '*No description.*')
  enhance(first)
  return [first, ...notes.sort((a, b) => a.when.localeCompare(b.when)).map(note)]
}

export function note(c: Note) {
  const box = make('div', 'ghc'), who = make('p', 'ghwho'), text = make('div', 'md')
  who.append(make('b', '', `@${c.author}`), ` ${c.state ? reviewWord(c.state) + ' · ' : ''}${ago(c.when)}`)
  if (c.state) box.dataset.state = c.state.toLowerCase()
  text.innerHTML = md(c.body || '')
  enhance(text)
  box.append(who, ...(c.body ? [text] : []))
  return box
}

/** A text box and its buttons ([label, cls, what it does with the text]), for comments and reviews. An action that
 *  resolves true went through: the box empties. */
export function writeBox(placeholder: string, buttons: [string, string, (text: string) => Promise<boolean>][]) {
  const box = make('form', 'ghreply'), ta = make('textarea'), row = make('div', 'row')
  ta.rows = 3
  ta.placeholder = placeholder
  ta.setAttribute('aria-label', placeholder)
  ta.addEventListener('keydown', e => e.stopPropagation())
  box.onsubmit = e => e.preventDefault()
  for (const [label, cls, act] of buttons) {
    const b = button(label, cls, async () => { if (await act(ta.value.trim())) ta.value = '' })
    b.type = 'button'
    row.append(b)
  }
  box.append(ta, row)
  return box
}

/** Comment on a pull request or issue: asks first, then reloads the view to show it. */
export const commentOn = (kind: 'pr' | 'issue', n: number) => async (text: string) => {
  if (!text) return false
  const r = await publish('Post this comment?', `On ${kind === 'pr' ? 'pull request' : 'issue'} #${n}:\n\n${text}`, 'Comment', { op: 'comment', kind, n, body: text }, 'Comment posted.')
  if (r) show()
  return !!r
}

/* ---------- saved, and readable by Claude ---------- */
persist('github', () => (win ? { rect: savedRect(win.el), view: win.failed ? { ...win.view, n: undefined } : win.view } : null),
  (s: { rect: Rect; view: View } | null) => { if (s) openGitHub(undefined, s.rect, s.view) })
referable('github', {
  icon: '⇄',
  label: () => 'GitHub',
  content: () => {
    const s = win?.seen, v = win?.view
    if (!s || !v) return { text: 'The GitHub window (nothing loaded yet).' }
    if (Array.isArray(s)) {
      if (v.tab === 'runs') return { text: 'GitHub Actions workflow runs:\n' + (s as Run[]).map(r => `${r.workflow}: ${r.title} (${r.branch}, ${r.state}${r.conclusion ? ' ' + r.conclusion : ''}, ${r.url})`).join('\n') }
      return { text: `GitHub ${v.tab === 'pr' ? 'pull requests' : 'issues'} (${v.state}${v.q ? ', search: ' + v.q : ''}${v.filter ? ', filter: ' + v.filter : ''}):\n` + (s as (PrRow | IssueRow)[]).map(r => `#${r.number} ${r.title} (@${r.author}, ${stateOf(r as PrRow)})`).join('\n') }
    }
    return { text: `GitHub ${'diff' in s ? 'pull request' : 'issue'} #${s.number}: ${s.title}\n${s.url}\n\n${s.body}` }
  },
})
