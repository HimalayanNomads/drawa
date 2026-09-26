// A window per sub-agent (each Agent/Task call a session makes): its task, its tool calls and text as they happen,
// a box to message it, and its result. The card keeps a compact row that opens the window. Live, the CLI tags a
// sub-agent's messages with the Agent call's id (parent_tool_use_id); on reload the server replays them from the
// sub-agent's own transcript with the same tag, so both paths end up in agentMsg(). A finished agent's window leaves
// the canvas by itself; its row brings it back.
import { make, rel, ping, ICON, iconButton, clip } from '../lib/dom'
import { api, type SavedMessage } from '../lib/api'
import { persist } from '../lib/store'
import { md, enhance } from '../lib/markdown'
import { items, savedRect, spotBeside, centerOn, changed, world, front, type Rect } from '../canvas/canvas'
import { makeWindow, expand, winTitle } from '../canvas/window'
import { link, savedPos, forget } from '../canvas/graph'
import { referable } from '../canvas/refs'
import { renderCard, type Session } from '../session/session'
import { send } from '../session/live'
import { describe, plain, replay, rowStopped } from '../session/stream'

interface Agent {
  call: string; S: Session; el: HTMLElement; log: HTMLElement; state: HTMLElement; ta: HTMLTextAreaElement; res?: HTMLElement
  type: string; prompt: string; result: string; done: boolean; bg: boolean; rows: Map<string, HTMLDetailsElement>
}
const agents = new Map<string, Agent>() // Agent call id -> its agent (kept after its window leaves, so the row can reopen it)
const ids = new Map<string, string>() // Agent call id -> the agent's own id, which SendMessage addresses
const alias = new Map<string, string>() // a SendMessage call that resumed an agent -> the Agent call it belongs to
const running = new Map<Session, Set<string>>() // per card, its unfinished Agent calls (the tab's badge)
const lazy = new Set<string>() // finished agents whose log the server didn't send: fetched when the window is opened
let filling = false // that log arriving: old messages, not the agent working again
const CLIP = 20_000

function setState(a: Agent, s: 'running' | 'background' | 'done' | 'failed') {
  a.el.dataset.state = s
  const set = running.get(a.S) ?? running.set(a.S, new Set()).get(a.S)!
  if (s === 'running' || s === 'background') set.add(a.call); else set.delete(a.call)
  renderCard(a.S) // its card's agent badge counts the running ones
  a.state.textContent = s === 'running' ? 'running' : s === 'background' ? 'bg' : s === 'failed' ? 'failed' : 'done'
  a.state.title = s === 'background' ? 'Running in the background' : s[0].toUpperCase() + s.slice(1)
}
/** The message box: usable once the CLI has told us the agent's id (it arrives a moment after it starts). */
function syncBox(a: Agent, call: string) {
  const ready = ids.has(call)
  a.ta.disabled = !ready
  // a foreground agent is part of its session's turn: the session only gets to relay once that turn (and so the agent) ends
  a.ta.placeholder = !ready ? 'Waiting for the agent to start…'
    : a.done ? 'Message the agent (resumes it), via its session'
    : a.bg ? 'Message the agent, via its session' : 'Message the agent (delivered once it finishes), via its session'
}
/** New entries go before the result, so a replayed log (which comes after its result) keeps its order. */
function add(a: Agent, el: HTMLElement) {
  if (a.res && el.classList.contains('md')) { a.res.remove(); a.res = undefined } // its own words arrived (replay): they end with the result
  a.log.insertBefore(el, a.res ?? null)
  if (!a.S.replaying && a.el.isConnected) a.log.scrollTop = a.log.scrollHeight // one layout read per entry, not a loop
  return el
}

/** The window for an Agent call (made on first use). Live calls open; replayed ones start collapsed (a long
 *  session can have dozens) unless the saved layout says otherwise. */
export function agentWindow(S: Session, call: string, inp: Record<string, any>, live: boolean): Agent {
  const have = agents.get(call)
  if (have) return have
  const type = String(inp.subagent_type ?? 'agent'), prompt = String(inp.prompt ?? '')
  const saved = savedPos['a:' + call] as Rect | undefined
  const state = make('span', 'm')
  const { el, head, body } = makeWindow({
    kind: 'agent', cls: 'anode', title: String(inp.description ?? type), minW: 300, minH: 180,
    rect: { min: !live, ...(saved ?? spotBeside(S.card, 440, 440, 520, 0)) },
    actions: [iconButton(ICON.x, "Close window (the session's Agent row reopens it)", () => hide(call), 'closebtn')],
  })
  el.dataset.id = 'a:' + call
  head.querySelector('.t')!.after(state)
  const log = body.appendChild(make('div', 'log alog'))
  const task = log.appendChild(make('details', 'atask')) as HTMLDetailsElement
  task.appendChild(make('summary')).append(make('b', '', type), make('span', 'arg', prompt.split('\n')[0]))
  task.appendChild(make('div', 'io')).appendChild(make('pre', '', prompt)).dataset.l = 'Task'
  // talking to it: the CLI has no way to type into a sub-agent, so the session's Claude relays it (SendMessage)
  const ta = body.appendChild(make('div', 'abox')).appendChild(make('textarea'))
  ta.rows = 1
  ta.setAttribute('aria-label', 'Message this agent')
  const a: Agent = { call, S, el, log, state, ta, type, prompt, result: '', done: false, bg: false, rows: new Map() }
  ta.onkeydown = async e => {
    e.stopPropagation() // typing isn't a canvas shortcut
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    const text = ta.value.trim(), id = ids.get(call)
    if (!text || !id) return
    ta.value = ''
    // the card shows a short line (relayed() reads it back from the transcript too); Claude gets the instruction
    const ok = await send(S, relayLabel(winTitle(el), text), [{ type: 'text', text: relayPrompt(id, winTitle(el), text) }])
    if (ok) add(a, make('div', 'me', text)); else ta.value = text
  }
  agents.set(call, a)
  setState(a, 'running')
  syncBox(a, call)
  link(S, el, 'agent')
  changed()
  return a
}

function hide(call: string) {
  const a = agents.get(call)
  if (!a?.el.isConnected) return
  forget(a.el)
  a.el.remove()
  changed()
}

/** The window title of the agent with this id (what SendMessage and hand-backs address), if it's one of ours. */
export function agentTitle(id: string) {
  for (const [call, aid] of ids) if (aid === id) { const a = agents.get(call); return a ? winTitle(a.el) : undefined }
}
/** A card's sub-agents that haven't finished (foreground and background), oldest first. */
export const runningAgents = (S: Session) => [...running.get(S) ?? []]

/** A card closed or cleared: its agents go with it (windows, and everything kept to reopen them). */
export function dropAgents(S: Session) {
  for (const [call, a] of agents) {
    if (a.S !== S) continue
    forget(a.el)
    a.el.remove()
    agents.delete(call)
    ids.delete(call)
    lazy.delete(call)
    for (const [k, c] of alias) if (c === call) alias.delete(k)
  }
  running.delete(S)
}
/** The card's process ended: agents still running can't finish any more. */
export function agentsStopped(S: Session) {
  const why = "Stopped: its session's Claude process ended."
  for (const call of runningAgents(S)) { agentDone(call, why, true); rowStopped(S, call, why) } // its window and its row in the card
}

/** The relay: what the card shows, and what its Claude is asked to do (SendMessage to the agent). */
const relayLabel = (title: string, text: string) => `To the "${title}" agent: ${text}`
const relayPrompt = (id: string, title: string, text: string) =>
  `Use SendMessage (to: '${id}') to pass this message to the "${title}" agent, word for word, then reply only "Relayed.":\n\n${text}`
/** A relay instruction read back (transcripts, other tabs): the short line the card showed, or null. */
export function relayed(text: string) {
  const m = /^Use SendMessage \(to: '[^']+'\) to pass this message to the "(.+?)" agent, word for word, then reply only "Relayed\.":\n\n([\s\S]*)$/.exec(text)
  return m ? relayLabel(m[1], m[2]) : null
}

/** From the card's Agent row: bring its window into view (back onto the canvas if it left). A finished agent's log
 *  wasn't sent with the session (it can be long, and most are never opened): fetched the first time. */
export function showAgent(call: string) {
  const a = agents.get(call)
  if (!a) return
  if (lazy.delete(call) && a.S.sid) {
    api<SavedMessage[]>(`session?id=${a.S.sid}&agent=${encodeURIComponent(call)}`)
      .then(msgs => { filling = true; try { msgs.forEach(m => replay(a.S, m)) } finally { filling = false } })
      .catch(() => { lazy.add(call); add(a, make('p', 'note', "Couldn't load what this agent did. Open it again to retry.")) })
  }
  if (!a.el.isConnected) { world.append(a.el); link(a.S, a.el, 'agent') }
  expand(a.el)
  front(a.el)
  centerOn(a.el)
  ping(a.el)
  changed()
}

/** The agent's own id, from the CLI's task_started line (live) or its Agent result's "agentId: …" (replay). */
/** The Agent call that started the agent with this id (task notifications may name only the id). */
export function agentCall(id: string) {
  for (const [call, aid] of ids) if (aid === id) return call
}
export function agentId(call: string, id: string, later = false) {
  ids.set(call, id)
  if (later) lazy.add(call)
  const a = agents.get(call)
  if (a) syncBox(a, call)
}
/** A SendMessage call: if it addresses one of our agents, what that agent says next belongs in its window. */
export function agentMessaged(call: string, to: string) {
  for (const [c, id] of ids) if (id === to) alias.set(call, c)
}

/** A message from inside a sub-agent: its text, tool calls and their results, in order. Returns the tool calls it
 *  made (for the session's Files and commands windows). */
export function agentMsg(parent: string, m: Record<string, any>) { // the CLI's message shape
  const call = agents.has(parent) ? parent : alias.get(parent) ?? ''
  const a = agents.get(call), content = m.message?.content
  if (!a || !Array.isArray(content)) return []
  if (a.done && !a.S.replaying && !filling) { // resumed by a message: working again, so back on the canvas
    a.done = false
    setState(a, 'running')
    syncBox(a, call)
    if (!a.el.isConnected) showAgent(call)
  }
  const calls: { id: string; name: string; input: Record<string, any> }[] = []
  for (const b of content) {
    if (m.type === 'assistant' && b.type === 'text' && b.text?.trim()) {
      const t = add(a, make('div', 'md'))
      t.innerHTML = md(b.text)
      enhance(t)
    } else if (m.type === 'assistant' && b.type === 'tool_use') {
      const d = add(a, make('details', 'tool run')) as HTMLDetailsElement
      d.appendChild(make('summary')).append(make('b', '', b.name), make('span', 'arg', rel(describe(b.input ?? {}))), make('span', 'st'))
      a.rows.set(b.id, d)
      calls.push({ id: b.id, name: b.name, input: b.input ?? {} })
    } else if (b.type === 'tool_result') {
      const d = a.rows.get(b.tool_use_id)
      if (!d) continue
      const t = plain(b.content)
      d.classList.remove('run')
      if (b.is_error) { d.classList.add('bad'); d.querySelector('.st')!.textContent = 'failed' }
      d.appendChild(make('div', 'io')).appendChild(make('pre', '', clip(t, CLIP) || '(no output)')).dataset.l = b.is_error ? 'Error' : 'Output'
    }
  }
  return calls
}

/** The Agent call went to the background, or finished: its result closes the log, and its window leaves the
 *  canvas (the card's row keeps the result and can bring the window back). */
export function agentDone(call: string, text: string, failed: boolean, background = false) {
  const a = agents.get(call)
  if (!a) return
  if (background) { a.bg = true; syncBox(a, call); return setState(a, 'background') }
  a.result = text
  a.done = true
  a.log.querySelectorAll('details.run').forEach(d => d.classList.remove('run')) // nothing is still running inside it
  // its last words are the result; show it on its own only when they aren't there (yet, on replay) or it failed
  if (failed || !a.log.querySelector(':scope > .md')) {
    a.res = a.log.appendChild(make('div', 'md ares' + (failed ? ' bad' : '')))
    a.res.innerHTML = md(clip(text, CLIP, '\n\n… (truncated)'))
    enhance(a.res)
  }
  setState(a, failed ? 'failed' : 'done')
  syncBox(a, call)
  hide(call)
}

// the saved layout keeps where each agent window on the canvas is; its content comes back from the transcript replay
// (the server sends each sub-agent's messages), and finished agents stay off the canvas
persist('agents', () => ({ pos: Object.fromEntries(items('agent').map(el => [el.dataset.id!, savedRect(el)])) }),
  (v: { pos?: Record<string, Rect> }) => { Object.assign(savedPos, v.pos ?? {}) }, 0)

referable('agent', {
  icon: '⧉',
  content: el => {
    const a = [...agents.values()].find(x => x.el === el)
    if (!a) return { text: `Sub-agent "${winTitle(el)}"` }
    const text = `Sub-agent (${a.type}) "${winTitle(el)}" from my canvas.\n\nTask:\n${a.prompt}\n\nResult:\n${a.result || '(still running)'}`
    return { text: clip(text, CLIP) }
  },
})
