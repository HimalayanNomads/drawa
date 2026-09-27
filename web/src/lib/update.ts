// Asks when a newer Drawa release is out (release binaries only: a source build's server never reports one).
// Install and restart has the server download, verify and swap in the new binary, then exec it; the page reloads
// once the new version answers. Not now asks again in a day, Skip this version waits for the next release.
import { api, post } from './api'
import { $, make } from './dom'

interface Info { current: string; latest: string; url: string; available: boolean }

const SKIP = 'drawa:update:skip', SNOOZE = 'drawa:update-snooze', DAY = 864e5, EVERY = 6 * 36e5
const d = $<HTMLDialogElement>('#update')
const text = d.querySelector('p')!
const [skip, later, go] = d.querySelectorAll<HTMLButtonElement>('.row button')
let info: Info, force = false, busy = false

function say(...parts: (Node | string)[]) { text.replaceChildren(...parts) }

function lock(on: boolean) {
  busy = on
  for (const b of [skip, later, go]) b.disabled = on
}

async function install() {
  lock(true)
  say(`Installing ${info.latest}…`)
  try {
    const r = await post('update', { force })
    if (r.working) {
      lock(false)
      force = true
      go.textContent = 'Stop them and update'
      const n = r.working
      return say(`${n} session${n > 1 ? 's are' : ' is'} still working. Restarting stops ${n > 1 ? 'them' : 'it'}; ` +
        `${n > 1 ? 'they pick' : 'it picks'} up again when you next message ${n > 1 ? 'them' : 'it'}.`)
    }
    say(`Restarting on ${info.latest}…`)
    await restarted(info.latest)
  } catch (e) {
    lock(false)
    go.textContent = 'Try again'
    say(`Couldn't update: ${e instanceof Error ? e.message : e}. You can also run `, make('code', '', 'drawa --update'), ' in a terminal.')
  }
}

/** Waits for the server to come back as `tag`, then reloads for its UI. */
async function restarted(tag: string) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const v = await api<Info>('version').catch(() => null)
    if (v?.current === tag) return location.reload()
  }
  throw new Error("the server didn't come back on the new version")
}

d.querySelector('form')!.addEventListener('submit', e => {
  if (e.submitter !== go) return
  e.preventDefault() // stay open to show progress
  install()
})
d.addEventListener('cancel', e => { if (busy) e.preventDefault() }) // Esc mid-install would hide a restart in progress
d.addEventListener('close', () => {
  if (d.returnValue === 'skip') localStorage.setItem(SKIP, info.latest)
  else localStorage.setItem(SNOOZE, JSON.stringify({ v: info.latest, t: Date.now() })) // Not now, Esc, click outside
})
d.onclick = e => { if (e.target === d && !busy) d.close('') } // click outside the box = Not now

function show(i: Info) {
  info = i
  force = false
  lock(false)
  go.textContent = 'Install and restart'
  const notes = Object.assign(make('a', '', "What's new"), { href: i.url, target: '_blank', rel: 'noopener' })
  say(`Drawa ${i.latest} is available. You have ${i.current}. `, notes)
  d.returnValue = ''
  d.showModal()
}

async function check() {
  if (d.open) return
  const i = await api<Info>('version').catch(() => null)
  if (!i?.available || localStorage.getItem(SKIP) === i.latest) return
  const s = JSON.parse(localStorage.getItem(SNOOZE) || 'null')
  if (s?.v === i.latest && Date.now() - s.t < DAY) return // a newer release than the snoozed one asks right away
  show(i)
}

// check again when you come back to the tab (a long-open page would otherwise wait out the interval)
document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
setInterval(check, EVERY)
setTimeout(check, 3000) // let boot settle first
