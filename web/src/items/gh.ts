// GitHub through the `gh` CLI (the Go server runs it with your own login): the data shapes, and sending a pull request,
// its failing checks, its review comments or an issue to Claude. Those are references like canvas items, but they
// aren't on the canvas: each is a detached element whose dataset says what to fetch at send time.
import { make } from '../lib/dom'
import { api, post, q } from '../lib/api'
import { referable } from '../canvas/refs'
import { centerOn } from '../canvas/canvas'
import { cur, cards, newSession, focus } from '../session/session'
import { addRef } from '../session/composer'
import { openGitHub } from './github'
import { who, lastAgent } from '../lib/agents'

export interface Check { name: string; state: 'pass' | 'fail' | 'pending' | 'skip'; url: string }
export interface Note { author: string; body: string; when: string; state?: string }
export interface PrRow { number: number; title: string; author: string; head: string; base: string; draft: boolean; review: string; updated: string; state: string; labels: string[]; checks: Check[] }
export interface Pr extends PrRow { url: string; body: string; additions: number; deletions: number; files: number; mergeable: string; created: string; comments: Note[]; reviews: Note[]; inline: (Note & { path: string; line: number; hunk: string })[]; inline_error?: string; diff: string; diff_truncated?: boolean }
export interface IssueRow { number: number; title: string; author: string; updated: string; state: string; labels: string[] }
export interface Issue extends IssueRow { body: string; url: string; created: string; comments: Note[] }
export interface GhState { ok: boolean; error?: string; repo?: string; url?: string; default?: string; branch?: string; pr?: (PrRow & { url: string }) | null }

type GhReply = { ok?: boolean; out?: string; title?: string; body?: string; error?: string }
/** A gh action (checkout, create, comment, draft). Never throws: a dead server comes back as a failed reply. */
export const ghPost = (body: object): Promise<GhReply> =>
  post('gh', body).catch(e => ({ ok: false, out: (e as Error).message, error: (e as Error).message }))
export const getPr = (n: number) => api<Pr>(`gh/pr?n=${n}`)
export const getIssue = (n: number) => api<Issue>(`gh/issue?n=${n}`)

/** "3 passed, 1 failed, 2 running" counts, and the dot color for a list row. */
export function tally(checks: Check[]) {
  const n = (s: string) => checks.filter(c => c.state === s).length
  return { pass: n('pass'), fail: n('fail'), pending: n('pending'), state: n('fail') ? 'fail' : n('pending') ? 'pending' : checks.length ? 'pass' : '' }
}
/** A checks-state dot (pass / fail / pending), for lists and summaries. */
export function dot(state: string) {
  const d = make('span', 'ghdot')
  d.dataset.state = state
  return d
}
/** "changes requested", "approved": a review's state as words. */
export const reviewWord = (state: string) => state.toLowerCase().replace('_', ' ')
export const REVIEW: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }
/** open / draft / merged / closed: one word for a PR's or issue's state. */
export const stateOf = (r: { state: string; draft?: boolean }) => (r.draft && r.state === 'OPEN' ? 'draft' : r.state.toLowerCase())

/* ---------- what Claude receives ---------- */
const MAX_DIFF = 60_000
const notes = (list: Note[]) => list.map(c => `@${c.author}${c.state ? ` (${reviewWord(c.state)})` : ''}, ${c.when.slice(0, 10)}:\n${c.body.trim()}`).join('\n\n')

async function prText(n: number) {
  const p = await getPr(n)
  const cut = p.diff.length > MAX_DIFF || p.diff_truncated
  const diff = cut ? p.diff.slice(0, MAX_DIFF) + `\n… (diff truncated, see ${p.url}/files for all of it)` : p.diff
  return [`GitHub pull request #${p.number}: ${p.title}`, p.url,
    `${p.head} → ${p.base} · ${stateOf(p)} · by @${p.author}${REVIEW[p.review] ? ' · ' + REVIEW[p.review] : ''} · +${p.additions} −${p.deletions} in ${p.files} files`,
    `\nDescription:\n${p.body.trim() || '(none)'}`,
    ...(p.comments.length ? [`\nComments:\n${notes(p.comments)}`] : []),
    `\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``].join('\n')
}

async function checksText(n: number) {
  const p = await getPr(n), failed = p.checks.filter(c => c.state === 'fail')
  if (!failed.length) return `Pull request #${n} (${p.title}) has no failing checks right now.`
  const parts = await Promise.all(failed.map(async c => {
    const log = await api<{ log: string }>(`gh/log?url=${q(c.url)}`).then(r => r.log.slice(-6000), e => `(log not available: ${(e as Error).message})`)
    return `### ${c.name}\n${c.url}\n\`\`\`\n${log}\n\`\`\``
  }))
  return `Failing checks on pull request #${n}: ${p.title} (${p.head} → ${p.base})\n${p.url}\n\n${parts.join('\n\n')}`
}

async function reviewsText(n: number) {
  const p = await getPr(n)
  const inline = p.inline.map(c => `${c.path}:${c.line ?? '?'}, @${c.author}:\n\`\`\`diff\n${c.hunk}\n\`\`\`\n${c.body.trim()}`).join('\n\n')
  if (!p.reviews.length && !p.inline.length && !p.comments.length && !p.inline_error) return `Pull request #${n} (${p.title}) has no reviews or comments yet.`
  return [`Review feedback on pull request #${n}: ${p.title} (${p.head} → ${p.base})`, p.url,
    ...(p.reviews.length ? [`\nReviews:\n${notes(p.reviews)}`] : []),
    ...(p.inline.length ? [`\nComments on the code:\n${inline}`] : []),
    ...(p.inline_error ? [`\n(inline comments unavailable: ${p.inline_error})`] : []),
    ...(p.comments.length ? [`\nConversation:\n${notes(p.comments)}`] : [])].join('\n')
}

async function issueText(n: number) {
  const i = await getIssue(n)
  return [`GitHub issue #${i.number}: ${i.title}`, i.url, `${i.state.toLowerCase()} · by @${i.author}${i.labels.length ? ' · labels: ' + i.labels.join(', ') : ''}`,
    `\n${i.body.trim() || '(no description)'}`, ...(i.comments.length ? [`\nComments:\n${notes(i.comments)}`] : [])].join('\n')
}

const TEXT = { pr: prText, checks: checksText, reviews: reviewsText, issue: issueText }
export type What = keyof typeof TEXT
// fetched at send time; a failure becomes text, so one bad reference never blocks the rest of the message
referable('gh', {
  icon: '⇄',
  label: el => el.dataset.label ?? '',
  content: el => TEXT[el.dataset.what as What](Number(el.dataset.n)).then(text => ({ text }),
    e => ({ text: `${el.dataset.label}: could not load it from GitHub (${(e as Error).message}).` })),
})

/** The card "Send to" goes to: the focused one, else the first, else a new one (made when sending). */
const target = () => cur ?? cards[0]
/** "Send to Codex", named after the agent that card runs. ponytail: read when the button is drawn; focusing a card
 *  of another agent afterwards leaves the old name until the window redraws. */
export const sendLabel = () => `Send to ${who(target()?.backend ?? lastAgent())}`

/** Attach a pull request (or its checks / reviews) or an issue to the focused card's next message. Its chip opens
 *  it in the GitHub window. */
export function sendToClaude(what: What, n: number, title: string) {
  const el = make('span')
  const label = { pr: `PR #${n}`, checks: `PR #${n} failing checks`, reviews: `PR #${n} reviews`, issue: `Issue #${n}` }[what]
  Object.assign(el.dataset, { kind: 'gh', what, n: String(n), label: `${label}: ${title}`.slice(0, 60) })
  el.onclick = () => openGitHub({ tab: what === 'issue' ? 'issue' : 'pr', n })
  const S = target() ?? newSession()
  addRef(S, { kind: 'gh', label: el.dataset.label!, el })
  focus(S)
  centerOn(S.card)
}
