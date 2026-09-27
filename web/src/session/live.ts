// The live connection to a card's Claude process: send messages, and read its output stream (re-attaching
// after network drops or a reload) until the process exits.
import { make, uuid, button } from '../lib/dom'
import { post } from '../lib/api'
import { quiet } from '../canvas/graph'
import { toContent, type Ref } from '../canvas/refs'
import { cards, put, renderCard, type Session } from './session'
import { chip } from './composer'
import { on, type Msg } from './stream'
import { thumb, imageBlock, type Pasted } from './images'
import { askPermission } from './notify'
import { canvasCall } from '../canvas/tools'
import { takeShell } from './shell'
import { agentsStopped } from '../items/agent'
import { expireAsks } from './asks'
import { reload } from './history'

/** Send a message (text, or content blocks like images with a short label for the bubble). Resolves to whether
 *  the server took it. */
export async function send(S: Session, prompt: string, content?: object[], refs: Ref[] = [], images: Pasted[] = []): Promise<boolean> {
  askPermission() // first message: a good moment to ask (it's a user action) whether you want notifications
  S.log.querySelector('.empty')?.remove()
  const bubble = put(S, make('div', 'me queued', prompt))
  if (refs.length || images.length) {
    const row = make('div', 'refs sent')
    row.append(...images.map(img => thumb(img)), ...refs.map(r => chip(r)))
    bubble.append(row)
    refs.forEach(r => S.sentRefs.add(r.el))
  }
  S.log.scrollTop = S.log.scrollHeight
  S.queued.push(bubble)
  if (S.title === 'New session') S.title = prompt.slice(0, 48)
  S.done = false
  S.pending++
  renderCard(S)
  try {
    let p: string | object[] = content ?? await toContent(prompt, refs)
    const shell = takeShell(S) // shell runs since the last message go first, like the terminal's bash mode
    if (shell) p = typeof p === 'string' ? shell + p : [{ type: 'text', text: shell }, ...p]
    if (images.length) p = [...(typeof p === 'string' ? [{ type: 'text', text: p }] : p), ...images.map(imageBlock)]
    if (!bubble.isConnected) return false // the card was cleared (/clear) while this was being prepared
    await post('send', { cid: S.cid, sid: S.sid, p, mode: S.mode, model: S.model, effort: S.effort, backend: S.backend })
    attach(S)
    return true
  } catch (e) {
    S.queued.splice(S.queued.indexOf(bubble), 1)
    bubble.classList.replace('queued', 'failed')
    put(S, make('div', 'err', `Could not send: ${(e as Error).message}`))
    S.pending = Math.max(0, S.pending - 1)
    renderCard(S)
    return false
  }
}

/* ---------- reading: one stream per page for all its cards ---------- */
// Browsers allow ~6 connections per host over HTTP/1.1: a stream per card would stall every other request once a few
// cards are open. So the page reads every card's output over one /api/events stream (lines tagged with the card).
// It's re-opened (from each card's next line) when cards come or go, and after a drop.
const page = uuid().replace(/-/g, '').slice(0, 16) // names this page for canvas tool calls
let conn: AbortController | null = null, subscribed = '', soon = 0

// One stream per server across tabs, too: every open tab's stream holds one of the browser's ~6 connections to this
// host for good, so a few forgotten tabs (drawa opens one per start) starve every other request, pings included.
// The tab holding this lock streams; the others say so, and take over when it closes or on "Use here".
let active = !navigator.locks, waiting = false // no Web Locks (very old browser): stream as before
const elsewhere = make('p', 'float toast elsewhere')
elsewhere.hidden = true
elsewhere.setAttribute('role', 'status')
elsewhere.append(make('span', '', 'Drawa is open in another tab.'), button('Use here', '', () => claim(true)))
document.body.append(elsewhere)

function claim(steal = false) {
  if (active || (waiting && !steal)) return
  if (!steal) { waiting = true; setTimeout(() => { if (!active) elsewhere.hidden = false }, 500) }
  navigator.locks.request('drawa:events', { steal }, () => {
    if (!steal) waiting = false
    active = true
    elsewhere.hidden = true
    listen()
    return new Promise<never>(() => {}) // held until the tab closes, or another tab takes it
  }).catch(() => { // another tab took over: stop reading, and queue to get it back when that tab closes
    active = false
    conn?.abort()
    conn = null
    subscribed = ''
    elsewhere.hidden = false
    claim()
  })
}
if (!active) claim()

/** Make sure this card's output is being read (it's a no-op when the stream already covers it). */
export function attach(_S?: Session) {
  clearTimeout(soon)
  soon = setTimeout(listen, 30) // cards restored or opened together share one re-open
}

function listen() {
  if (!active) return
  // re-open when cards come or go, or when a card not attached yet got a different start (a restore sets it after the
  // card exists: e.g. line 0 for one whose transcript isn't written yet)
  const want = cards.map(S => (S.gen ? S.cid : `${S.cid}:${S.n}`)).sort().join()
  if (conn && want === subscribed) return
  conn?.abort()
  subscribed = want
  if (!cards.length) { conn = null; return }
  const ctrl = (conn = new AbortController())
  read(ctrl).finally(() => {
    if (conn !== ctrl) return // replaced by a newer stream
    conn = null
    setTimeout(listen, 1000) // dropped (server restart, network): pick up where each card left off
  })
}

async function read(ctrl: AbortController) {
  const c = cards.map(S => `${S.cid}:${S.n}:${S.gen ?? ''}`).join()
  let res: Response
  try { res = await fetch(`/api/events?page=${page}&c=${c}`, { signal: ctrl.signal }) } catch { return }
  if (!res.ok || !res.body) return
  const rd = res.body.getReader(), dec = new TextDecoder()
  // the server sends a keep-alive every 15s: this long without a byte is a half-open connection (sleep, network
  // change) that would otherwise hang here for good. Aborting it reconnects (see listen).
  let buf = '', idle = 0
  const watch = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), 40_000) }
  watch()
  try {
    for (;;) {
      const { done, value } = await rd.read()
      if (done) return
      watch()
      const got = dec.decode(value, { stream: true }), nl = got.lastIndexOf('\n')
      if (nl < 0) { buf += got; continue } // a long line coming in pieces: only new text is searched for its end
      const lines = (buf + got.slice(0, nl)).split('\n')
      buf = got.slice(nl + 1)
      for (const l of lines) {
        if (!l.trim()) continue // keep-alive
        let m: Msg | undefined
        try { m = JSON.parse(l) } catch { /* still one of the card's lines: counted all the same (see line) */ }
        const cid = m ? m._c : /^\{"_c":"([^"]+)"/.exec(l)?.[1]
        const S = cards.find(s => s.cid === cid)
        if (S) line(S, m, l)
      }
    }
  } catch { /* aborted, or the connection dropped */ } finally { clearTimeout(idle) }
}

/** One line of a card's output. `m` is undefined for a line that isn't valid JSON: it still counts. */
function line(S: Session, m: Msg | undefined, raw: string) {
  if (m?.type === 'absent') { // no process: a restored agent can't be running, and a turn this page saw start never ends
    if (S.gen && !S.gone) ended(S)
    S.gone = true
    agentsStopped(S)
    return
  }
  if (m?.type === '_gap') { // lines were dropped before this page read them: the next is `to`; rebuild from the transcript
    if (typeof m.to === 'number') S.n = m.to
    if (!S.stale) reload(S)
    return
  }
  if (m?.type === 'attach') {
    S.gone = false
    S.n = m.from
    S.gen = m.gen // the process these line numbers belong to
    if (S.stale && m.gen !== S.stale) S.stale = undefined
    S.reader = m.reader
    // mid-turn when this page (re)attached, e.g. after a reload: show it working (and stoppable) until the result
    if (m.busy && !S.pending) { S.pending = 1; renderCard(S) }
    return
  }
  if (!m?._r) S.n++ // re-sent on attach (an ask still open), not one of the process's numbered lines
  if (!m || S.stale) return // stale: /clear, the old process's last lines (its new one attaches with another gen)
  if (m.type === 'exit') {
    // process ended (closed as idle, crashed, or server restarted): the next message starts a new one resuming this
    // session, and the same stream picks that one up from its first line
    ended(S)
    return
  }
  // a canvas tool call for this page (older ones replayed after a reconnect name an old reader: skip them)
  if (m.type === 'canvas_call') { if (m.to === S.reader) canvasCall(S, m as any); return }
  try { on(S, m) } catch (x) { console.error(x, raw) }
}

/** The card's process is gone: nothing it was doing will finish, and nothing it asked can be answered. */
function ended(S: Session) {
  S.queued.splice(0).forEach(b => b.classList.replace('queued', 'failed'))
  agentsStopped(S) // its agents were part of it
  expireAsks(S)
  if (S.pending || S.bg) { S.pending = S.bg = 0; quiet(S) }
  renderCard(S)
}
