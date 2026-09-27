// Session cards: each is a live Claude process on the server. You can type any time (messages queue while Claude
// or its agents work, like the terminal); output streams in continuously (stream.ts). Every tool call also lands on
// the graph. This module owns the card itself: creating, focusing, closing, and its header / status.
import { make, ICON, iconButton, project, ping, uuid, perFrame } from '../lib/dom'
import { api, post } from '../lib/api'
import { persist, save, saveSoon, each } from '../lib/store'
import { front, savedRect, nextColumn, centerOn, fit, byIds, type Rect, onCanvas } from '../canvas/canvas'
import { makeWindow, expand } from '../canvas/window'
import { dropSession, redraw, link, itemLinks } from '../canvas/graph'
import { clearInk } from '../canvas/ink'
import { referable, type Ref } from '../canvas/refs'
import { removable } from '../canvas/select'
import type { Pasted } from './images'
import type { Change } from '../panels/diff'
import { dropPlans } from '../items/plan'
import { runningAgents, showAgent, dropAgents } from '../items/agent'
import { composer } from './composer'
import { reportOf } from './notices'
import { attach } from './live'
import { setMode, lastMode } from './mode'
import { setModel, setEffort, renderInfo, seedInfo } from './gen'
import { loadSessions, resume, sessionPath } from './history'
import { lastAgent, modesOf, installed, title, who } from '../lib/agents'

export type ToolRow = HTMLDetailsElement & { chg?: Change }
export interface Block {
  type: string; buf: string; el?: HTMLElement; d?: ToolRow; raf?: number; name?: string; id?: string
  done?: number; tail?: HTMLElement // streaming text: chars already rendered for good, and the element redrawn each frame
}
export interface Session {
  cid: string // this card's live process on the server
  sid: string | null // the agent's session id (transcript), known after the first reply
  backend: string // which agent runs this card (lib/agents.ts); fixed for its life, the transcript can't move
  title: string
  reportedModel: string // the model Claude's process actually reports running (for the tab; set from its own output)
  model: string // the model picked in this card's message bar for its next message ('' = Claude's own default)
  modelSel?: HTMLSelectElement
  effort: string // the effort level picked in this card's message bar ('' = default; see gen.ts)
  effortSel?: HTMLSelectElement
  infoEl?: HTMLElement // tools/context/usage-window status line below the message bar (see gen.ts)
  infoText?: HTMLElement // its "N tools · X% context" part
  ring5h?: HTMLElement // its 5-hour usage-window ring badge
  ring5hPct?: HTMLElement // the "49%" label beside it
  ring7d?: HTMLElement // its 7-day usage-window ring badge
  ring7dPct?: HTMLElement // the "4%" label beside it
  toolCount: number // tools this card's Claude can call, from its own init line (0 until its process has started)
  mcpTotal: number
  mcpConnected: number
  usageResetAt?: number // unix seconds: when the current 5-hour usage window ends (from rate_limit_event)
  usageUtil?: number // 0..1 of that window used so far
  weeklyResetAt?: number
  weeklyUtil?: number
  cost: number
  done: boolean
  card: HTMLElement
  log: HTMLDivElement
  ta: HTMLTextAreaElement
  stopBtn: HTMLButtonElement
  blocks: Record<number, Block>
  tools: Record<string, ToolRow>
  pending: number // messages sent and not yet answered
  bg: number // background agents still running
  queued: HTMLElement[] // bubbles waiting for Claude to pick them up
  picked: boolean // Claude echoed a message back during the current turn
  mode: string // permission mode for this card's Claude (see mode.ts)
  modeSel?: HTMLSelectElement // its picker in the message bar
  confirmedMode?: string // the mode Claude last reported (or the card was restored with)
  reader?: string // this page's reader id on the server stream (canvas tool calls name the page to run them)
  replaying?: boolean // rebuilding a saved transcript: no per-message scroll pinning or header updates (see history.ts)
  asks: Set<string> // approval requests waiting on you
  refs: Ref[] // canvas items attached to the next message
  images: Pasted[] // images pasted or dropped into the message box, sent with the next message
  sentRefs: Set<HTMLElement> // items referenced in messages already sent (their arrows stay)
  chips: HTMLElement
  n: number // next output line to read (for re-attaching)
  gen?: string // which of the card's processes `n` counts lines of
  gone?: boolean // the server has no process for it (so nothing of it runs, agents included)
  stale?: string // /clear: the old process's gen, whose lines still in flight are dropped (see live.ts)
  ctx: { used: number; max: number; real?: boolean } // context window use, from the latest reply's token counts (real: size reported by the CLI)
}

export const cards: Session[] = []
export let cur: Session | undefined // the focused card
/** Models and slash commands / skills, from Claude itself (GET /api/meta). */
/** Also carries tools/MCP counts and usage-window stats from a $0 `/usage` ask (see internal/live/meta.go): the
 *  same for every card (it's account-wide, not per-conversation), so a card's status line can show it before its
 *  own process has ever run (see gen.ts's seedInfo). */
export const meta: {
  models: { value: string; displayName: string; description: string }[]
  commands: { name: string; description: string; argumentHint?: string }[]
  tools?: number; mcpTotal?: number; mcpConnected?: number
  usageUtil?: number; usageResetAt?: number; weeklyUtil?: number; weeklyResetAt?: number
} = { models: [], commands: [] }

/* ---------- saved with the canvas: open cards (by transcript id) and which one had focus ---------- */
// A card still waiting for its first reply has no transcript id yet: it's saved by its process (cid) alone and, after a
// reload, rebuilt from the process's output from the start (live.ts reads from line 0 when n is 0).
type SavedCard = Rect & { id?: string; title: string; cid?: string; mode?: string; model?: string; effort?: string; backend?: string } // no backend: claude
persist('cards',
  () => cards.filter(S => S.sid || S.pending).map((S): SavedCard => ({ id: S.sid ?? undefined, title: S.title, cid: S.cid, mode: S.mode, model: S.model, effort: S.effort, backend: S.backend === 'claude' ? undefined : S.backend, ...savedRect(S.card) })),
  async (list: SavedCard[], all) => {
    // every transcript is fetched at once; they're replayed in order as they arrive
    if (!Array.isArray(list)) throw new Error('not a list')
    const got = new Map(list.filter(c => c?.id).map(c => {
      const p = api(sessionPath(c.id!, c.backend))
      p.catch(() => {}) // handled when its card is replayed
      return [c.id!, p] as const
    }))
    let bad: unknown // one bad entry doesn't stop the rest; rethrown at the end so the slice is kept as saved
    for (const c of list) try {
      if (!c.id) {
        if (!c.cid) continue
        const S = newSession({ rect: c, cid: c.cid, backend: c.backend ?? 'claude' })
        S.title = c.title
        S.n = 0
        setMode(S, c.mode ?? 'default', false)
        // layouts saved before model/effort were per card carry one global model choice (all.model); effort is new, no legacy key
        setModel(S, c.model ?? all.model ?? '')
        setEffort(S, c.effort ?? '')
        renderCard(S)
        continue
      }
      const p = got.get(c.id)
      got.delete(c.id) // replayed cards let go of their transcript: a long restore doesn't hold every one till the end
      await resume({ ...c, id: c.id, backend: c.backend ?? 'claude' }, c, { got: p, quiet: true })
      // layouts saved before modes were per card carry one global mode (all.mode)
      const S = cards.find(s => s.sid === c.id)
      if (S) {
        setMode(S, c.mode ?? all.mode ?? 'default', false)
        setModel(S, c.model ?? all.model ?? '')
        setEffort(S, c.effort ?? '')
      }
    } catch (e) { bad ??= e }
    attach() // pick up sessions still running on the server (in-flight replies, background agents)
    loadSessions()
    const f = cards.find(S => S.sid === all.focus)
    if (f) focus(f)
    if (!all.view) fit(false)
    if (bad) throw bad
  })
persist('focus', () => cur?.sid ?? undefined)
// a deleted selection clicks the card's own × (it doesn't ask), and says what closing means
removable('session', null, 'Sessions are closed; their conversations stay in History.')
// drop a card on another card's message box: that conversation goes along as context (its recent part, as text)
referable('session', {
  icon: '◆',
  label: el => cards.find(s => s.card === el)?.title ?? 'session',
  content: (el, label) => {
    const S = cards.find(s => s.card === el)
    const lines = [...(S?.log.children ?? [])].flatMap(r => {
      if (r.matches('.me')) return [`User: ${r.textContent?.trim()}`]
      if (r.matches('.md')) return [`${who(S!.backend)}: ${r.textContent?.trim()}`]
      if (r.matches('.handoff')) return [`(${r.querySelector('summary b')?.textContent}:)\n${reportOf(r) ?? ''}`]
      if (r.matches('details.tool')) return [`(${who(S!.backend)} used ${r.querySelector('summary b')?.textContent ?? 'a tool'} ${r.querySelector('summary .arg')?.textContent ?? ''})`.replace(/ \)$/, ')')]
      return []
    })
    let text = lines.join('\n\n')
    if (text.length > 30_000) text = '…(earlier part left out)\n\n' + text.slice(-30_000) // ponytail: the recent end is what matters most
    return { text: `Another ${S ? who(S.backend) : 'agent'} session on my canvas, "${label}"${S?.sid ? ` (session ${S.sid})` : ''}:\n\n${text || '(nothing yet)'}` }
  },
})
// arrows to canvas items a card's Claude made or edited: after the cards and the items are back
// ones whose card or item isn't there on this load are kept and written back (tried again next load), not erased
type ItemLink = { cid: string; id: string; acts: ('made' | 'edit')[] }
let unplaced: ItemLink[] = []
persist('itemLinks', () => [...itemLinks(), ...unplaced], (list: ItemLink[]) => {
  const ids = byIds()
  unplaced = []
  each(list, l => {
    const S = cards.find(s => s.cid === l.cid), el = ids.get(l.id)
    if (S && el) l.acts.forEach(a => link(S, el, a))
    else unplaced.push(l)
  })
}, 2)

/* ---------- the card ---------- */
function emptyState(S: Session) {
  const e = make('div', 'empty'), ul = make('ul'), chips = make('div', 'chips')
  const name = who(S.backend)
  e.append(make('h2', '', 'New session'), make('p', '', `${name} works in ${project.root}`))
  const tips: [string, string][] = [
    ['--edit', `Files ${name} reads or changes are listed in a Files window beside this card, changed files first.`],
    ['--run', 'Commands it runs collect in a commands window below the card (click its tab to see the output).'],
    ['--write', 'Type / for skills and commands, @ to reference scratchpads, diagrams, plans, notes or files (or drop them on the message box).'],
    ['--read', 'Read only by default. Change it per session in the message bar (Allow edits, Plan only, Allow everything).'],
  ]
  for (const [color, text] of tips) {
    const li = make('li'), i = make('i')
    i.style.background = `var(${color})`
    li.append(i, text)
    ul.append(li)
  }
  for (const q of ['Summarize this project', 'Map the main modules', 'Find TODOs and rough edges']) {
    const c = make('button', 'btn', q)
    c.type = 'button'
    c.onclick = () => { S.ta.value = q; S.ta.focus() }
    chips.append(c)
  }
  e.append(ul, chips)
  return e
}

export function newSession(opts: { rect?: Rect; cid?: string; backend?: string } = {}) {
  const r = opts.rect ?? nextColumn(Math.max(340, Math.min(460, innerWidth - 32)), 600) // phones: fits the screen
  const close = iconButton(ICON.x, 'Close session', () => closeSession(S), 'closebtn')
  const { el: card, head, title, body } = makeWindow({ kind: 'session', cls: 'card', title: 'New session', rect: r, minW: 340, minH: 300, actions: [close] })
  head.prepend(make('span', 'dot'))
  const ctx = make('span', 'ctx') // a span, not a button: the tab's buttons are the window controls at its end
  ctx.tabIndex = 0
  ctx.setAttribute('role', 'button')
  ctx.onclick = e => { e.stopPropagation(); S.ta.value = '/compact '; S.ta.focus() } // a nudge, not an action: you still send it
  ctx.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.click() } }
  // running sub-agents: a badge that never shrinks away (the meta text does), visible when collapsed too; each click
  // shows the next running agent's window
  const agentsBtn = make('button', 'agents')
  agentsBtn.hidden = true
  let nextAgent = 0
  agentsBtn.onclick = e => { e.stopPropagation(); const run = runningAgents(S); if (run.length) showAgent(run[nextAgent++ % run.length]) }
  title.after(agentsBtn, make('span', 'm'), ctx)
  const log = make('div', 'log')
  // scrolled up to read: a way back to the latest message (appends while you're up there don't scroll, so it stays shown)
  const down = iconButton(ICON.open, 'Scroll to the latest message', () => { log.scrollTop = log.scrollHeight }, 'tobottom')
  down.hidden = true
  log.addEventListener('scroll', perFrame(() => { down.hidden = log.scrollHeight - log.scrollTop - log.clientHeight < 200 }), { passive: true })
  body.append(log, down)

  const S: Session = {
    cid: opts.cid ?? uuid(), sid: null, backend: opts.backend ?? lastAgent(), title: 'New session', reportedModel: '', model: '', effort: '', toolCount: 0, mcpTotal: 0, mcpConnected: 0, cost: 0, done: false,
    card, log, ta: null!, stopBtn: null!, blocks: {}, tools: {}, pending: 0, bg: 0, queued: [], picked: false, mode: lastMode(), asks: new Set(), refs: [], images: [], sentRefs: new Set(), chips: null!, n: -1, ctx: { used: 0, max: 0 },
  }
  if (!(modesOf(S.backend)?.includes(S.mode) ?? true)) S.mode = 'default' // e.g. Auto, which OpenCode doesn't have
  composer(S, body) // message box, reference chips, / and @ menu
  seedInfo(S) // tools/MCP/usage from the account-wide meta info, if it's already in by now
  card.dataset.id = S.cid // what canvas tools call this card
  log.dataset.ink = 'c:' + S.cid // drawing over the chat scrolls with it
  log.dataset.inkRows = '' // and stays on the message it was drawn over (see canvas/ink.ts)
  log.append(emptyState(S))
  cards.push(S)
  attach() // the page's one stream reads this card too, from its process's first line once it starts

  card.addEventListener('rename', e => { S.title = (e as CustomEvent<string>).detail; renderCard(S); saveSoon() })
  card.addEventListener('pointerdown', () => focus(S), true)
  card.addEventListener('focusin', () => focus(S))
  // a waiting permission prompt answers to Enter / Esc from the card (unless you're typing a message)
  card.addEventListener('keydown', e => {
    const open = S.log.querySelector<HTMLElement>('.ask.perm:not(.done)')
    if (!open || (e.target === S.ta && S.ta.value.trim()) || (e.target as Element).closest('.cmds, .pnode')) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); open.querySelector<HTMLButtonElement>('.btn.primary')!.click() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open.querySelector<HTMLButtonElement>('.row .btn:not(.primary)')!.click() }
  }, true)
  new ResizeObserver(redraw).observe(card)

  focus(S)
  renderCard(S)
  if (!opts.rect) {
    centerOn(card)
    S.ta.focus({ preventScroll: true })
  }
  return S
}

/** C / Shift+C: the next (or previous) session card: expanded, brought into view and focused. The message box
 *  isn't focused, so C keeps stepping; Enter starts typing in it. */
export function cycleCards(step: 1 | -1) {
  if (!cards.length) return
  const S = cards[(cards.indexOf(cur!) + step + cards.length) % cards.length] ?? cards[0]
  expand(S.card)
  focus(S)
  if (onCanvas(S.card)) centerOn(S.card); else S.card.scrollIntoView({ block: 'nearest' }) // pinned to the sidebar
  ping(S.card)
}

export function focus(S: Session) {
  if (cur === S) return
  cur?.card.classList.remove('focus')
  cur = S
  S.card.classList.add('focus')
  front(S.card)
  saveSoon()
}

function closeSession(S: Session) {
  post('close', { cid: S.cid }).catch(() => {})
  dropSession(S)
  dropPlans(S)
  dropAgents(S)
  clearInk(S.log) // its ink goes with it, and its rows stop being watched
  S.card.remove()
  cards.splice(cards.indexOf(S), 1)
  attach() // the page's stream stops reading it
  if (cur === S) cur = undefined
  if (!cards.length) newSession()
  save()
  loadSessions()
}

/** /clear: a fresh conversation in this card. The CLI's own /clear does nothing in the mode the cards run it in,
 *  so the card's process is closed and its next message starts a new one; the old conversation stays in History. */
export async function clearSession(S: Session) {
  S.stale = S.gen // lines the old process still sends (a busy turn's tail, its exit) mustn't land in the cleared card
  S.log.replaceChildren(make('p', 'none', 'Clearing…')) // a send that's mid-way sees its bubble gone and stops (live.ts)
  await post('close', { cid: S.cid }).catch(() => {})
  dropSession(S) // its Files and commands windows belonged to that conversation
  dropPlans(S)
  dropAgents(S)
  clearInk(S.log)
  Object.assign(S, { sid: null, title: 'New session', cost: 0, done: false, pending: 0, bg: 0, blocks: {}, tools: {}, queued: [], picked: false, ctx: { used: 0, max: 0 } })
  S.asks.clear()
  S.sentRefs.clear()
  S.log.replaceChildren(emptyState(S))
  renderCard(S)
  attach() // read its next process from the start
  save()
  loadSessions()
}

/** Header, status classes and composer placeholder from the session's current state. */
export function renderCard(S: Session) {
  if (S.replaying) return // once at the end instead
  const busy = S.pending > 0 || S.bg > 0
  S.card.dataset.state = S.asks.size ? 'asking' : busy ? 'busy' : S.done ? 'done' : 'idle'
  S.card.querySelector('.t')!.textContent = S.title
  const m = S.card.querySelector<HTMLElement>('.win-h .m')!
  const model = S.reportedModel.replace(/^claude-/, '').replace(/^[\w.-]+\//, '') // opencode reports provider/model
  m.textContent = installed().length > 1 ? [title(S.backend), model].filter(Boolean).join(' · ') : model // which agent, once there's a choice
  const run = runningAgents(S).length, badge = S.card.querySelector<HTMLElement>('.win-h .agents')!
  badge.hidden = !run
  badge.textContent = String(run)
  badge.title = `${run} sub-agent${run === 1 ? '' : 's'} running. Click to show ${run === 1 ? 'its window' : 'the next one'}.`
  badge.setAttribute('aria-label', badge.title)
  // The CLI reports an API-equivalent estimate even on a subscription, where it isn't billed: hover only.
  m.title = !S.cost ? '' : S.backend === 'claude' ? `Estimated API-equivalent cost: $${S.cost.toFixed(2)} (not billed on a Claude subscription)` : `Cost ${who(S.backend)} reports so far: $${S.cost.toFixed(2)}`
  const ctx = S.card.querySelector<HTMLElement>('.win-h .ctx')!, pct = S.ctx.max ? Math.min(100, Math.round((S.ctx.used / S.ctx.max) * 100)) : 0
  ctx.hidden = !S.ctx.used
  ctx.style.setProperty('--p', `${pct}%`)
  ctx.dataset.level = pct >= 80 ? 'high' : pct >= 60 ? 'mid' : ''
  ctx.textContent = `${pct}%`
  ctx.title = `Context: ${S.ctx.used.toLocaleString()} of ${S.ctx.max.toLocaleString()} tokens used. Click to write /compact (summarizes the conversation to free space).`
  renderInfo(S)
  S.log.classList.toggle('busy', S.pending > 0)
  S.stopBtn.hidden = S.pending === 0
  S.ta.placeholder = busy ? `${who(S.backend)} is working. Type to queue a message.` : `Message ${who(S.backend)}: / commands, @ files, ! shell`
}

/* ---------- appending to the log ---------- */
const nearBottom = (S: Session, px: number) => S.log.scrollHeight - S.log.scrollTop - S.log.clientHeight < px
/** Append to the log, staying pinned to the bottom if you were reading there. */
export function put<T extends HTMLElement>(S: Session, e: T): T {
  if (S.replaying) { S.log.append(e); return e } // measuring the log after every append re-lays it out each time
  const stick = nearBottom(S, 80)
  S.log.append(e)
  if (stick) S.log.scrollTop = S.log.scrollHeight
  return e
}
/** Open at the latest message and stay there while the log settles: rows render at their real height only once
 *  they're on screen (content-visibility), and diagrams and pictures finish later, so one scroll to the bottom
 *  lands short. Stops early the moment you scroll or click in the log yourself. */
const SETTLE_MS = 4000
export function pinToBottom(S: Session) {
  const log = S.log, end = performance.now() + SETTLE_MS, yours = new AbortController()
  for (const t of ['wheel', 'pointerdown', 'touchstart', 'keydown']) log.addEventListener(t, () => yours.abort(), { passive: true, signal: yours.signal })
  const tick = () => {
    if (yours.signal.aborted || S.log !== log || performance.now() > end) return yours.abort()
    log.scrollTop = log.scrollHeight
    requestAnimationFrame(tick)
  }
  tick()
}
export const follow = (S: Session) => { if (!S.replaying && nearBottom(S, 200)) S.log.scrollTop = S.log.scrollHeight }
