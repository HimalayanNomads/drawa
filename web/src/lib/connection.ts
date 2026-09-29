// Is the Go server reachable? A light ping every few seconds; when it stops answering, a notice says so and pings
// faster until it's back, then whatever registered with onReconnect runs (re-attach streams, refresh lists).
import { $, notice, button } from './dom'

const box = $('#conn'), text = box.querySelector<HTMLElement>('span')!
const EVERY = 5000, RETRY = 2000
let misses = 0, down = false, timer = 0
const listeners: (() => void)[] = []
export const onReconnect = (f: () => void) => listeners.push(f)

let version = '', told = false
// A page left open across an upgrade runs the old UI against the new server: offer the new one.
function check(v?: string) {
  version ||= v ?? ''
  if (!v || v === version || told) return
  told = true
  notice(`Drawa was updated to ${v}. Reload to use the new version.`, button('Reload', '', () => location.reload()))
}

async function ping() {
  clearTimeout(timer)
  let r: Response | undefined
  try { r = await fetch('/api/info', { cache: 'no-store', signal: AbortSignal.timeout(3000) }) } catch {}
  const j = await r?.json().catch(() => null)
  if (r?.status === 403 && j?.signedOut) { // --net, and this browser's token is from an earlier run: retrying won't help
    down = true
    box.hidden = false
    box.dataset.state = 'down'
    text.textContent = j.error
    timer = setTimeout(ping, EVERY) // opening the new link in another tab signs this one in again
    return
  }
  if (r?.ok) {
    check(j?.version)
    misses = 0
    if (down) {
      down = false
      box.dataset.state = 'back'
      text.textContent = 'Reconnected'
      setTimeout(() => { if (!down) box.hidden = true }, 2500)
      listeners.forEach(f => f())
    }
  } else if (++misses >= 2 && !down) { // two misses: not a blip
    down = true
    box.hidden = false
    box.dataset.state = 'down'
    text.textContent = 'Server not reachable. Reconnecting…'
  }
  timer = setTimeout(ping, down ? RETRY : EVERY)
}

// check right away when you come back to the tab (the server may have stopped while you were away)
document.addEventListener('visibilitychange', () => { if (!document.hidden) ping() })
timer = setTimeout(ping, EVERY)
