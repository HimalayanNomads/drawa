// Rendering Claude's stream-json output into a card: text, thinking, tool calls and their results, sub-agent
// activity, background-agent notifications. Saved transcripts replay through the same path, so the graph rebuilds too.
import type { ContentBlock, SavedMessage } from '../lib/api'
import { make, rel, clip } from '../lib/dom'
import { save } from '../lib/store'
import { md, enhance } from '../lib/markdown'
import { touch, run, settle, quiet, type Act } from '../canvas/graph'
import { change, settleChange, type Change } from '../panels/diff'
import { tree, openInspector, inspecting } from '../panels/files'
import { liveDiagrams } from '../items/diagram'
import { showPlan, planResult, focusPlan } from '../items/plan'
import { agentWindow, agentMsg, agentDone, showAgent, agentId, agentCall, agentMessaged, relayed } from '../items/agent'
import { put, follow, renderCard, type Session, type ToolRow, type Block } from './session'
import { approval } from './asks'
import { thumb } from './images'
import { notify } from './notify'
import { replayShell } from './shell'
import { setMode, modeRefused } from './mode'
import { TASK_TOOLS, taskCall, taskResult } from './tasks'
import { loadSessions } from './history'
import { meta, handoff, report } from './notices'
// what a refused tool call means in each mode, and what to do about it (shown under the turn)
const REFUSED = 'It was refused. Switch this card to Allow edits, Auto or Allow everything and ask again to let it run.'
const DENIED_HOW: Record<string, string> = {
  auto: "Auto mode's safety check refused it without asking. Switch this card to Allow everything if you trust the task, or ask Claude to do it another way.",
  plan: 'Plan only changes nothing. Approve the plan, or switch this card to another mode.',
  default: REFUSED,
  acceptEdits: REFUSED,
  bypassPermissions: 'Refused even with Allow everything: a hook or a managed setting blocks it.',
}

// Claude's stream-json lines; loosely typed on purpose, the CLI owns the schema.
export type Msg = Record<string, any>

export function fold(cls: string, title: string) {
  const d = make('details', cls) as ToolRow, s = make('summary')
  s.append(make('b', '', title), make('span', 'arg'), make('span', 'st'))
  d.append(s)
  return d
}
export const describe = (i: Record<string, unknown>) => String(i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? '')
export const plain = (c: ContentBlock['content']) => (typeof c === 'string' ? c : (c ?? []).map(x => x.text ?? '').join('\n'))
const ACTS: Record<string, Act> = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write', Bash: 'run' }
/** Is this user message already on the card? */
function shown(S: Session, text: string, uuid?: string) {
  if (uuid && S.log.querySelector(`:scope > .me[data-uuid="${CSS.escape(uuid)}"]`)) return true
  const last = [...S.log.querySelectorAll(':scope > .me')].pop()
  return !!last && (last.textContent ?? '').trim().startsWith(text.trim()) // the bubble may add chips after the text
}
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()
const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1].trim())

/** A tool call's effect on the graph (file nodes, terminal). Returns the diff block for edits. */
function wire(S: Session, id: string, name: string, inp: Record<string, any>): Change | undefined {
  const act = ACTS[name]
  if (act === 'run' && inp.command) run(S, id, inp.command)
  else if (act && inp.file_path) {
    const file = rel(inp.file_path)
    const c = act !== 'read' ? change(S, name, file, inp) : undefined
    touch(S, id, act, file, c)
    return c
  }
}

function start(S: Session, i: number, b: ContentBlock) {
  if (b.type === 'text') S.blocks[i] = { type: 'text', buf: '', el: put(S, make('div', 'md')) }
  else if (b.type === 'thinking') {
    const d = put(S, fold('think run', 'Thinking'))
    d.open = true
    S.blocks[i] = { type: 'thinking', buf: '', el: d.appendChild(make('div')), d }
  } else if (b.type === 'tool_use') {
    const act = ACTS[b.name ?? '']
    const label = (b.name ?? 'Tool').replace(/^mcp__canvas__canvas_/, 'Canvas · ') // our own canvas tools read as such
    const d = put(S, fold(`tool run${act ? ' act-' + act : ''}${b.name === 'Agent' || b.name === 'Task' ? ' agent' : ''}${b.name?.startsWith('mcp__canvas__') ? ' canvas' : ''}`, label))
    S.tools[b.id!] = d
    S.blocks[i] = { type: 'tool_use', buf: '', d, name: b.name, id: b.id }
  }
}

function delta(S: Session, i: number, dl: { text?: string; thinking?: string; partial_json?: string }) {
  const k = S.blocks[i]
  if (!k) return
  k.buf += dl.text ?? dl.thinking ?? dl.partial_json ?? ''
  if (k.raf) return // one repaint per frame, however many deltas arrive
  if (k.type === 'thinking') k.raf = requestAnimationFrame(() => { k.raf = 0; k.el!.textContent = k.buf; follow(S) })
  else if (k.type === 'text') k.raf = requestAnimationFrame(() => { k.raf = 0; streamText(k); follow(S) })
}

/** Where the streamed text can be split for good: the last blank line after `from` that isn't inside a code
 *  fence. Everything before it is complete markdown blocks that won't change. (`from` is always outside a fence.) */
function safeCut(buf: string, from: number) {
  let cut = from, fence = false, i = from
  while (i < buf.length) {
    const nl = buf.indexOf('\n', i)
    if (nl < 0) break
    const line = buf.slice(i, nl)
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    else if (!fence && !line.trim() && nl > from) cut = nl + 1
    i = nl + 1
  }
  return cut
}

/** One frame of a streaming reply: complete blocks are rendered once and kept; only the unfinished tail is
 *  re-rendered. (Re-rendering the whole reply every frame made long replies slower the longer they got.)
 *  ponytail: blocks render separately while streaming (a loose list may show as two); stop() renders it whole. */
function streamText(k: Block) {
  k.done ??= 0
  if (!k.tail) k.tail = k.el!.appendChild(make('div', 'tail'))
  const cut = safeCut(k.buf, k.done)
  if (cut > k.done) {
    k.tail.insertAdjacentHTML('beforebegin', md(k.buf.slice(k.done, cut)))
    k.done = cut
  }
  k.tail.innerHTML = md(k.buf.slice(k.done))
  liveDiagrams(k.el!, k.buf)
}

function stop(S: Session, i: number) {
  const k = S.blocks[i]
  if (!k) return
  delete S.blocks[i]
  if (k.type === 'text') {
    cancelAnimationFrame(k.raf ?? 0)
    k.el!.innerHTML = md(k.buf)
    enhance(k.el!)
  } else if (k.type === 'thinking') {
    cancelAnimationFrame(k.raf ?? 0)
    if (!k.buf.trim()) return k.d!.remove()
    k.el!.textContent = k.buf
    k.d!.classList.remove('run')
    k.d!.open = false
    k.d!.querySelector('b')!.textContent = 'Thought'
  } else if (k.type === 'tool_use') {
    let inp: Record<string, any> = {}
    try { inp = JSON.parse(k.buf || '{}') } catch {}
    const d = k.d!
    d.querySelector('.arg')!.textContent = rel(describe(inp))
    const c = wire(S, k.id!, k.name ?? '', inp)
    if (TASK_TOOLS.has(k.name ?? '')) {
      d.classList.add('taskrow')
      d.querySelector('.arg')!.textContent = taskCall(S, k.id!, k.name!, inp) // the checklist above the message box shows the rest
    } else if (k.name === 'ExitPlanMode') {
      showPlan(S, k.id!, String(inp.plan ?? ''))
      d.querySelector('.arg')!.textContent = 'plan ready for review'
      const b = make('button', 'jump', 'Open plan')
      b.onclick = e => { e.preventDefault(); focusPlan(S) }
      d.querySelector('.st')!.before(b)
    } else if (c) {
      d.chg = c
      const j = make('button', 'jump', 'View diff')
      j.onclick = e => { e.preventDefault(); openInspector(c.file, 'changes', c) }
      d.querySelector('.st')!.before(j)
    } else if (d.classList.contains('agent')) {
      // its work shows in its own window; the row stays compact and opens it
      agentWindow(S, k.id!, inp, !S.replaying)
      const w = make('button', 'jump', 'Open window')
      w.onclick = e => { e.preventDefault(); showAgent(k.id!) }
      d.querySelector('.st')!.before(w) // (its window has a box for messaging the agent)
    } else {
      if (k.name === 'SendMessage' && inp.to) agentMessaged(k.id!, String(inp.to)) // the agent's reply goes to its window
      // edits skip this: their diff is the input
      const pre = d.appendChild(make('div', 'io')).appendChild(make('pre', '', JSON.stringify(inp, null, 2)))
      pre.dataset.l = 'Input'
    }
  }
}

function result(S: Session, r: ContentBlock) {
  const d = S.tools[r.tool_use_id!]
  const t = plain(r.content)
  const aid = d?.classList.contains('agent') ? /agentId: ([\w-]+)/.exec(t)?.[1] : undefined
  if (aid) agentId(r.tool_use_id!, aid) // what SendMessage addresses (live, task_started already said)
  if (d?.classList.contains('agent') && /^Async agent launched/.test(t)) {
    // background agent: its row keeps running until a task-notification reports back
    d.classList.add('bg')
    d.querySelector('.st')!.textContent = 'background'
    agentDone(r.tool_use_id!, '', false, true)
    S.bg++
    renderCard(S)
    return
  }
  settle(r.tool_use_id!, !r.is_error, t)
  if (!r.is_error) taskResult(S, r.tool_use_id!, t)
  if (d?.querySelector('summary b')?.textContent === 'ExitPlanMode') planResult(S, !r.is_error)
  if (!d) return
  d.classList.remove('run')
  if (r.is_error) { d.classList.add('bad'); d.querySelector('.st')!.textContent = 'failed' }
  const out = d.classList.contains('agent') ? report(t) : t
  if (d.classList.contains('agent')) agentDone(r.tool_use_id!, out, !!r.is_error) // its window shows it too, then leaves
  const io = d.querySelector('.io') ?? d.appendChild(make('div', 'io'))
  const pre = io.appendChild(make('pre', '', clip(out, 20_000) || '(no output)'))
  pre.dataset.l = r.is_error ? 'Error' : d.classList.contains('agent') ? 'Result' : 'Output'
  if (d.chg) {
    settleChange(d.chg, !r.is_error)
    if (inspecting === d.chg.file) openInspector(d.chg.file) // refresh the open file
  }
}

/** An Agent row whose agent can't report back any more (its session's Claude process ended): no longer running. */
export function rowStopped(S: Session, call: string, why: string) {
  const d = S.tools[call]
  if (!d || d.classList.contains('bad')) return
  d.classList.remove('run', 'bg')
  d.classList.add('bad')
  d.querySelector('.st')!.textContent = 'stopped'
  const io = d.querySelector('.io') ?? d.appendChild(make('div', 'io'))
  io.appendChild(make('pre', '', why)).dataset.l = 'Result'
}

/** A background agent finished: a <task-notification> message (transcripts), or a task_notification line (live). */
function notification(S: Session, xml: string) {
  const summary = tag(xml, 'summary') ?? 'Background task finished'
  const status = tag(xml, 'status') ?? '', text = tag(xml, 'result') ?? summary
  // match by the agents' ids too: a resumed agent reports under the SendMessage call that woke it, and the one sent
  // when a session ended lists every agent it stopped with no call id at all
  const calls = new Set([tag(xml, 'tool-use-id'), ...tags(xml, 'task-id').map(agentCall)])
  let ours = false
  for (const call of calls) if (call && finished(S, call, status, text, summary)) ours = true
  if (!ours) { put(S, make('p', 'note', summary)); renderCard(S) }
}
/** Returns whether it was a background agent still waiting on this. */
function finished(S: Session, call: string, status: string, text: string, summary: string) {
  const d = S.tools[call]
  if (!d?.classList.contains('bg')) return false // not ours, or already reported (live lines and the transcript both say so)
  d.classList.remove('run', 'bg')
  d.querySelector('.st')!.textContent = status === 'completed' ? '' : status
  agentDone(call, text, status !== 'completed')
  const pre = (d.querySelector('.io') ?? d.appendChild(make('div', 'io'))).appendChild(make('pre', '', text))
  pre.dataset.l = 'Result'
  S.bg = Math.max(0, S.bg - 1)
  put(S, make('p', 'note', summary.split('\n')[0]))
  renderCard(S)
  return true
}

/** Sub-agent activity (lines tagged with the Agent call that started it) goes into that agent's window; its file
 *  reads and commands still show in the session's Files and commands windows. */
function subagent(S: Session, parent: string, m: Msg) {
  if (m.type !== 'assistant' && m.type !== 'user') return
  for (const c of agentMsg(parent, m)) wire(S, c.id, c.name, c.input)
  const content = m.message?.content
  if (m.type === 'user' && Array.isArray(content)) for (const b of content) if (b.type === 'tool_result') settle(b.tool_use_id, !b.is_error, plain(b.content))
}

/** Context in use = everything sent to the model for this reply (fresh input + cache reads + cache writes). */
function usage(S: Session, u: Msg | undefined) {
  if (!u) return
  S.ctx.used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  // until a result reports the real window: 1M if the model says so, or if we're already past 200k (can't exceed the window)
  if (!S.ctx.real) S.ctx.max = /\[1m\]/.test(S.reportedModel) || S.ctx.used > 200_000 ? 1_000_000 : 200_000
  renderCard(S)
}

export function on(S: Session, m: Msg) {
  if (m.session_id && m.session_id !== S.sid && !m.parent_tool_use_id) { S.sid = m.session_id; save() }
  if (m.parent_tool_use_id) return subagent(S, m.parent_tool_use_id, m)
  if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') return approval(S, m)
  if (m.type === 'system' && m.subtype === 'status' && m.permissionMode) setMode(S, m.permissionMode, false)
  // an agent started (its id is what SendMessage addresses) or a background one finished
  if (m.type === 'system' && m.subtype === 'task_started' && !m.owned_by_subagent && m.tool_use_id) agentId(m.tool_use_id, m.task_id)
  if (m.type === 'system' && m.subtype === 'task_notification') {
    const call = S.tools[m.tool_use_id]?.classList.contains('agent') ? m.tool_use_id : agentCall(m.task_id ?? '') // (resumed: see notification)
    if (call && S.tools[call]) finished(S, call, m.status ?? '', m.summary ?? '', `Agent "${S.tools[call].querySelector('.arg')?.textContent ?? ''}" ${m.status ?? 'finished'}`)
  }
  if (m.type === 'control_response' && m.response?.subtype === 'error') {
    put(S, make('div', 'err', `Claude refused: ${m.response.error}`))
    if (/permission mode/i.test(m.response.error ?? '')) modeRefused(S)
  }
  if (m.type === 'system' && m.subtype === 'init') {
    S.reportedModel = m.model
    S.toolCount = (m.tools ?? []).length
    const mcps = m.mcp_servers ?? []
    S.mcpTotal = mcps.length
    S.mcpConnected = mcps.filter((s: Msg) => s.status === 'connected').length
    renderCard(S)
  } else if (m.type === 'rate_limit_event') {
    const w = m.rate_limit_info?.unifiedWindows ?? {}
    S.usageResetAt = w.five_hour?.resetsAt
    S.usageUtil = w.five_hour?.utilization
    S.weeklyResetAt = w.seven_day?.resetsAt
    S.weeklyUtil = w.seven_day?.utilization
    renderCard(S)
  } else if (m.type === 'stream_event') {
    const e = m.event
    if (e.type === 'message_start') { S.blocks = {}; usage(S, e.message?.usage) }
    else if (e.type === 'content_block_start') start(S, e.index, e.content_block)
    else if (e.type === 'content_block_delta') delta(S, e.index, e.delta)
    else if (e.type === 'content_block_stop') stop(S, e.index)
  } else if (m.type === 'user') {
    const c = m.message?.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: ContentBlock) => b.type === 'text').map((b: ContentBlock) => b.text).join('\n') : ''
    // a background task's report starts a turn of its own: its result mustn't un-queue a message Claude hasn't read
    if (text.startsWith('<task-notification>')) { notification(S, text); S.picked = true }
    else if (m.isMeta && text) { if (!handoff(S, text, true)) meta(S, text) } // text the CLI adds itself (an agent's report, a skill's instructions): not something you typed
    else if (text) { // Claude picked up a message: ours (queued here), or one this page didn't send (restored card, another tab)
      const q = S.queued.shift()
      if (q) q.classList.remove('queued')
      // (skipped when already shown: by its uuid when this page rendered it from the stream, else by text, since the
      // transcript writes it when queued but the stream echoes it only once Claude starts)
      else if (!shown(S, relayed(text) ?? text, m.uuid)) { S.log.querySelector('.empty')?.remove(); put(S, make('div', 'me', relayed(text) ?? text)).dataset.uuid = m.uuid ?? '' }
      S.picked = true
    }
    if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') result(S, b)
  } else if (m.type === 'assistant' && m.message?.model === '<synthetic>') {
    // replies that don't come from the model (local slash commands like /model): whole, not streamed
    const text = (m.message.content ?? []).filter((b: ContentBlock) => b.type === 'text').map((b: ContentBlock) => b.text).join('\n')
    if (text) { const el = put(S, make('div', 'md')); el.innerHTML = md(text); enhance(el) }
  } else if (m.type === 'error') {
    put(S, make('div', 'err', m.text))
  } else if (m.type === 'result') {
    if (m.is_error && m.subtype !== 'error_during_execution') put(S, make('div', 'err', m.result || m.subtype))
    if (m.subtype === 'error_during_execution') put(S, make('p', 'note', 'Stopped.'))
    const denied = [...new Set<string>((m.permission_denials ?? []).map((p: Msg) => {
      const i = p.tool_input ?? {}, what = i.description ?? i.command ?? i.file_path ?? ''
      return what ? `${p.tool_name} (${String(what).slice(0, 60)})` : p.tool_name
    }))]
    if (denied.length) put(S, make('div', 'err', `Not allowed: ${denied.join(', ')}. ${DENIED_HOW[S.mode] ?? DENIED_HOW.default}`))
    // the model's real context window, when the CLI reports it
    const windows = Object.values(m.modelUsage ?? {}).map((u: any) => u?.contextWindow).filter(Boolean) as number[]
    if (windows.length) { S.ctx.max = Math.max(...windows); S.ctx.real = true }
    const turns = m.num_turns ?? 0
    S.cost += m.total_cost_usd ?? 0
    S.done = !m.is_error
    const foot = put(S, make('p', 'foot', `${((m.duration_ms ?? 0) / 1000).toFixed(1)}s · ${turns} turn${turns === 1 ? '' : 's'}`))
    foot.title = `Estimated API-equivalent cost: $${(m.total_cost_usd ?? 0).toFixed(4)} (not billed on a Claude subscription)`
    // a turn answers every message Claude picked up so far (queued ones can join a turn mid-way): only unread ones remain
    // local commands (/model, /cost...) finish without echoing the message back: the oldest queued one was it
    if (!S.picked) S.queued.shift()?.classList.remove('queued')
    S.picked = false
    S.pending = S.queued.length
    if (!S.pending) notify(S, 'done')
    if (!S.pending) {
      S.log.querySelectorAll('details.run:not(.bg)').forEach(d => d.classList.remove('run'))
      if (!S.bg) quiet(S)
    }
    renderCard(S)
    save()
    loadSessions()
    tree()
  }
}

/** Rebuild a saved transcript through the same start/delta/stop path the live stream uses (so the graph rebuilds too). */
export function replay(S: Session, m: SavedMessage & { usage?: Msg; parent?: string; aid?: string; lazy?: boolean; isMeta?: boolean }) {
  if (m.aid) return agentId(m.parent!, m.aid, m.lazy) // a sub-agent's id (the server sends these first): what SendMessage addresses; lazy: its log comes when its window opens
  if (m.parent) return subagent(S, m.parent, { type: m.role, message: { content: m.content } }) // a sub-agent's own transcript
  if (m.usage) usage(S, m.usage) // the latest reply's token counts: the context meter works for reopened sessions too
  const blocks: ContentBlock[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? []
  if (m.role === 'user') {
    let bubble: HTMLElement | undefined
    for (const b of blocks) {
      if (b.type === 'tool_result') result(S, b)
      else if (b.type === 'text' && b.text!.startsWith('<task-notification>')) notification(S, b.text!)
      else if (b.type === 'text' && m.isMeta) { if (!handoff(S, b.text!, false)) meta(S, b.text!) } // as live: an agent's report or a skill's instructions, not something you typed
      else if (b.type === 'text' && b.text!.startsWith('<bash-input>')) { const rest = replayShell(S, b.text!); if (rest) bubble = put(S, make('div', 'me', rest)) }
      else if (b.type === 'text' && !b.text!.startsWith('<')) bubble = put(S, make('div', 'me', relayed(b.text!) ?? b.text))
      else if (b.type === 'image' && ((b as any).source?.data || (b as any).source?.url)) { // images you sent: thumbnails
        bubble ??= put(S, make('div', 'me'))
        const row = bubble.querySelector('.refs.sent') ?? bubble.appendChild(make('div', 'refs sent'))
        const src = (b as any).source // the server sends a stored image's address instead of its base64
        row.append(thumb({ type: src.media_type, data: src.data ?? '', url: src.url ?? `data:${src.media_type};base64,${src.data}` }))
      }
    }
  } else {
    for (const b of blocks) {
      start(S, 0, b)
      delta(S, 0, b.type === 'tool_use' ? { partial_json: JSON.stringify(b.input) } : b)
      stop(S, 0)
    }
  }
}

