// Model and effort, per session card: which model this card's Claude runs as, and how hard it thinks. Picked in the
// card's message bar, alongside its permission mode (mode.ts). Model switches silently (bundled into the next
// send, like mode); the CLI has no such control message for effort, so switching it on an already-running card
// sends a real "/effort <level>" message instead, visible in the chat exactly like typing it yourself.
import { make } from '../lib/dom'
import { saveSoon } from '../lib/store'
import { cards, meta, type Session } from './session'
import { meta as agentMeta, metaNow } from '../lib/agents'
import { send } from './live'

// Claude Code's models come with its other account-wide info (meta, main.ts); another agent's from lib/agents.ts
const modelsOf = (S: Session) => S.backend === 'claude' ? meta.models : metaNow(S.backend).models

function fillModel(S: Session, sel: HTMLSelectElement) {
  const models = modelsOf(S)
  if (!models.length) return // not in yet: keep the placeholder (and the card's choice, if restored)
  sel.replaceChildren(...models.map(o => {
    const opt = make('option', '', o.displayName)
    opt.value = o.value === 'default' ? '' : o.value
    opt.title = o.description
    return opt
  }))
  sel.value = S.model // the card's choice, restored or picked before the list arrived
}

/** The model picker for a card's message bar: options come from its agent itself (GET /api/meta). */
export function modelPicker(S: Session) {
  const sel = make('select', 'modelsel')
  sel.setAttribute('aria-label', 'Model for this session')
  sel.append(Object.assign(make('option', '', 'Default model'), { value: '' }))
  fillModel(S, sel)
  if (S.backend !== 'claude') agentMeta(S.backend).then(() => fillModel(S, sel))
  sel.value = S.model
  sel.onchange = () => { S.model = sel.value; saveSoon() }
  S.modelSel = sel
  return sel
}

/** Claude's own model list just arrived (or changed): refill every open card's picker without losing its choice. */
export function refreshModels() { for (const S of cards) if (S.modelSel) fillModel(S, S.modelSel) }

/** Sets a card's model without an onchange round-trip (restoring a saved card). */
export function setModel(S: Session, model: string) {
  S.model = model
  if (S.modelSel) S.modelSel.value = model
}

export const EFFORTS: [string, string, string][] = [
  ['', 'Default', "Claude's own default effort for the model"],
  ['low', 'Low', 'Fast, lighter-weight answers'],
  ['medium', 'Medium', 'Handles most tasks'],
  ['high', 'High', 'More thorough, slower'],
  ['xhigh', 'Extra high', 'Very thorough, slower still'],
  ['max', 'Max', 'Most thorough; burns through usage fastest'],
  ['auto', 'Auto', 'Claude adjusts effort per turn'],
]

/** The effort picker for a card's message bar. Unlike model and mode, there's no silent way to change effort on a
 *  process that's already running (`claude`'s control protocol has no set_effort), so a switch there is sent as a
 *  real "/effort <level>" message. A card with no process yet (or none running right now) just remembers the
 *  choice for its next spawn (see buildArgv in internal/live/live.go); "Default" can't be sent as a live command at
 *  all (the CLI has no way to ask for its own default back), so picking it back never messages a running card. */
export function effortPicker(S: Session) {
  const sel = make('select', 'effortsel')
  sel.setAttribute('aria-label', 'Effort for this session')
  sel.append(...EFFORTS.map(([value, label, desc]) => Object.assign(make('option', '', label), { value, title: desc })))
  sel.value = S.effort
  sel.onchange = () => {
    S.effort = sel.value
    saveSoon()
    if (S.effort && S.gen && !S.gone) send(S, `/effort ${S.effort}`)
  }
  S.effortSel = sel
  return sel
}

/** Sets a card's effort without an onchange round-trip (restoring a saved card). */
export function setEffort(S: Session, effort: string) {
  S.effort = effort
  if (S.effortSel) S.effortSel.value = effort
}

/** A status line below the message bar: tools available and context used as text, plus a ring badge each for the
 *  5-hour and 7-day usage windows (filled by how much of that window is used; hover either for the exact numbers
 *  and reset time). Filled from state the process reports as it runs (its init line, and rate_limit_event; see
 *  stream.ts); hidden until then. Re-rendered on a minute ticker (below) so the rings don't go stale between turns. */
function ringWrap(label: string) {
  const wrap = make('span', 'ringwrap'), el = make('span', 'ring'), pct = make('span', 'pct')
  el.dataset.label = label
  wrap.append(el, pct)
  return { wrap, el, pct }
}

/** "N tools loaded · M/T MCP servers · P% context" plus the two usage rings, all in one row: a full-width flex
 *  item forces it below the model/effort dropdowns, right-aligned under the effort one. */
export function infoBadge(S: Session) {
  const el = make('div', 'status'), text = make('span', 'stext')
  const r5 = ringWrap('5h'), r7 = ringWrap('7d')
  el.append(text, r5.wrap, r7.wrap)
  el.hidden = true
  Object.assign(S, { infoEl: el, infoText: text, ring5h: r5.el, ring5hPct: r5.pct, ring7d: r7.el, ring7dPct: r7.pct })
  return el
}

function clock(unixSeconds: number) {
  const d = new Date(unixSeconds * 1000), time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** "3h 42m" (or "5d 2h" for the weekly window); "now" once it's passed but no fresher event arrived yet. */
function countdown(unixSeconds: number) {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000)
  if (mins <= 0) return 'now'
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

function ring(el: HTMLElement | undefined, pctEl: HTMLElement | undefined, util: number | undefined, resetAt: number | undefined, label: string) {
  if (!el || !pctEl) return
  const wrap = el.parentElement
  if (util == null || resetAt == null) { if (wrap) wrap.hidden = true; return }
  if (wrap) wrap.hidden = false
  const pct = Math.round(util * 100)
  el.style.setProperty('--p', String(pct))
  pctEl.textContent = `${pct}%`
  const title = `${label}: ${pct}% used, resets in ${countdown(resetAt)} (${clock(resetAt)}).`
  el.title = pctEl.title = title
}

/** Fills a card's status fields from the account-wide meta info (tools/MCP/usage), unless its own process has
 *  already reported fresher ones. Called for a brand-new card, and again for every open card once /api/meta
 *  answers (it can take a while the first time: it spins up its own throwaway `claude` process). */
export function seedInfo(S: Session) {
  if (S.toolCount || meta.tools == null || S.backend !== 'claude') return // Claude Code's account and usage windows
  S.toolCount = meta.tools
  S.mcpTotal = meta.mcpTotal ?? 0
  S.mcpConnected = meta.mcpConnected ?? 0
  S.usageUtil = meta.usageUtil
  S.usageResetAt = meta.usageResetAt
  S.weeklyUtil = meta.weeklyUtil
  S.weeklyResetAt = meta.weeklyResetAt
  renderInfo(S)
}

export function renderInfo(S: Session) {
  const el = S.infoEl
  if (!el) return
  el.hidden = !S.toolCount
  if (!S.toolCount) return
  const pct = S.ctx.max ? Math.min(100, Math.round((S.ctx.used / S.ctx.max) * 100)) : 0
  const parts = [`${S.toolCount} tools loaded`]
  if (S.mcpTotal) parts.push(`${S.mcpConnected}/${S.mcpTotal} MCP servers`)
  if (S.ctx.used) parts.push(`${pct}% context`)
  S.infoText!.textContent = parts.join(' · ')
  S.infoText!.title = `${S.toolCount} tools available${S.mcpTotal ? ` (${S.mcpConnected} of ${S.mcpTotal} MCP servers connected)` : ''}.` +
    (S.ctx.used ? ` Context: ${S.ctx.used.toLocaleString()} of ${S.ctx.max.toLocaleString()} tokens used (${pct}%).` : '')
  ring(S.ring5h, S.ring5hPct, S.usageUtil, S.usageResetAt, '5-hour usage limit')
  ring(S.ring7d, S.ring7dPct, S.weeklyUtil, S.weeklyResetAt, 'Weekly usage limit')
}

// the countdowns go stale between turns: nudge them back into shape once a minute, for any card showing one
setInterval(() => { for (const S of cards) if (S.usageResetAt || S.weeklyResetAt) renderInfo(S) }, 60_000)
