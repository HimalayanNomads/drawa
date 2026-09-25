// Is the Go server reachable? A light ping every few seconds; when it stops answering, a notice says so and pings
// faster until it's back, then whatever registered with onReconnect runs (re-attach streams, refresh lists).
import { $ } from './dom'

const box = $('#conn'), text = box.querySelector<HTMLElement>('span')!
const EVERY = 5000, RETRY = 2000
let misses = 0, down = false, timer = 0
const listeners: (() => void)[] = []
export const onReconnect = (f: () => void) => listeners.push(f)
export const online = () => !down

async function ping() {
  clearTimeout(timer)
  let ok = false
  try { ok = (await fetch('/api/info', { cache: 'no-store', signal: AbortSignal.timeout(3000) })).ok } catch {}
  if (ok) {
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
