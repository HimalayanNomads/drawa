// Checks GitHub for a newer drawa release and offers to install it. Same self-rescheduling shape as
// connection.ts's ping loop, just at a much longer interval: the server caches its own answer (see
// internal/update), so most of these checks are instant.
import { api, post } from './api'
import { $, toast } from './dom'

interface UpdateInfo { current: string; latest: string; url: string; available: boolean }

const SKIP_KEY = 'drawa:update:skip'
const EVERY = 6 * 60 * 60 * 1000
let timer = 0

function updateBox(d: HTMLDialogElement, info: UpdateInfo): Promise<'ok' | 'skip' | ''> {
  d.querySelector('p')!.textContent = `Drawa ${info.latest} is available (you're on ${info.current}).`
  d.returnValue = ''
  d.onclick = e => { if (e.target === d) d.close('') } // click outside the box = "not now"
  d.showModal()
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue as 'ok' | 'skip' | ''), { once: true }))
}

async function install() {
  try {
    const r = await post('update/install', {}) as { ok: boolean; error?: string }
    if (!r.ok) toast(r.error || 'Update failed.')
    // on success the process is about to exec into the new binary; connection.ts's own banner covers the restart
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Update failed.')
  }
}

async function check() {
  clearTimeout(timer)
  timer = window.setTimeout(check, EVERY)
  const d = $<HTMLDialogElement>('#update')
  if (d.open) return // already asking; don't stack a second prompt
  let info: UpdateInfo
  try { info = await api<UpdateInfo>('update') } catch { return }
  if (!info.available || localStorage.getItem(SKIP_KEY) === info.latest) return
  const choice = await updateBox(d, info)
  if (choice === 'ok') install()
  else if (choice === 'skip') { try { localStorage.setItem(SKIP_KEY, info.latest) } catch {} }
}

// check right away when you come back to the tab, same as connection.ts
document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
timer = window.setTimeout(check, 3000) // let boot settle first
