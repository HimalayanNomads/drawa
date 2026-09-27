// Asks when a newer Drawa release is out (release binaries only: a source build's server never reports one).
// Two steps: Update has the server download, verify and swap in the new binary; then Restart now execs it (the page
// reloads once the new version answers) or Restart later leaves it for the next time drawa starts. Not now asks
// again in a day, Skip this version waits for the next release.
import { api, post } from './api'
import { $, make } from './dom'

interface Info { current: string; latest: string; url: string; available: boolean; installed?: string }

const SKIP = 'drawa:update:skip', SNOOZE = 'drawa:update-snooze', DAY = 864e5, EVERY = 6 * 36e5
const d = $<HTMLDialogElement>('#update')
const title = d.querySelector('h2')!, text = d.querySelector('p')!
const [from, to] = [d.querySelector('.ver i')!, d.querySelector('.ver b')!]
const notes = d.querySelector<HTMLAnchorElement>('.ver a')!
const [, later, go] = d.querySelectorAll<HTMLButtonElement>('.row button')
let info: Info, busy = false

function say(...parts: (Node | string)[]) {
  text.replaceChildren(...parts)
  text.hidden = !parts.length
}

function lock(on: boolean) {
  busy = on
  for (const b of d.querySelectorAll('button')) b.disabled = on
}

const plural = (n: number, one: string, many: string) => n > 1 ? many : one

function failed(e: unknown) {
  lock(false)
  go.textContent = 'Try again'
  say(`Couldn't update: ${e instanceof Error ? e.message : e}. You can also run `, make('code', '', 'drawa --update'), ' in a terminal.')
}

async function install() {
  lock(true)
  say(`Downloading ${info.latest}…`)
  try {
    const r = await post('update', {})
    lock(false)
    d.dataset.state = 'restart'
    title.textContent = `${info.latest} is installed`
    later.textContent = 'Restart later'
    go.textContent = 'Restart now'
    const n: number = r.working
    say(n ? `${n} ${plural(n, 'session is', 'sessions are')} still working. Restarting stops ${plural(n, 'it', 'them')}; ` +
      `${plural(n, 'it picks', 'they pick')} up again when you next message ${plural(n, 'it', 'them')}.`
      : 'Restart Drawa to start using it, or it starts the next time you open Drawa.')
  } catch (e) { failed(e) }
}

async function restart() {
  lock(true)
  say(`Restarting on ${info.latest}…`)
  try {
    await post('update/restart', {})
    for (let i = 0; i < 60; i++) { // wait for the server to come back as the new version, then load its UI
      await new Promise(r => setTimeout(r, 1000))
      const v = await api<Info>('version').catch(() => null)
      if (v?.current === info.latest) return location.reload()
    }
    throw new Error("the server didn't come back on the new version")
  } catch (e) { failed(e) }
}

d.querySelector('form')!.addEventListener('submit', e => {
  if (e.submitter !== go) return
  e.preventDefault() // stay open to show progress
  if (d.dataset.state === 'restart') restart()
  else install()
})
d.addEventListener('cancel', e => { if (busy) e.preventDefault() }) // Esc mid-install would hide a restart in progress
d.addEventListener('close', () => {
  if (d.dataset.state === 'restart') return // Restart later: the server remembers it's installed
  if (d.returnValue === 'skip') localStorage.setItem(SKIP, info.latest)
  else localStorage.setItem(SNOOZE, JSON.stringify({ v: info.latest, t: Date.now() })) // Not now, Esc, click outside
})
d.onclick = e => { if (e.target === d && !busy) d.close('') } // click outside the box = Not now / Restart later

function show(i: Info) {
  info = i
  lock(false)
  d.dataset.state = 'offer'
  title.textContent = 'Update available'
  later.textContent = 'Not now'
  go.textContent = 'Update'
  from.textContent = i.current
  to.textContent = i.latest
  notes.href = i.url
  say()
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
