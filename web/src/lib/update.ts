// A one-line notice when a newer Drawa release is out (release binaries only: a source build's server leaves
// `latest` out). × snoozes it for a day; Update installs it on the server, which restarts on the new binary, and
// the page reloads once the new version answers.
import { api, post } from './api'
import { make, iconButton, ICON } from './dom'

interface Version { current: string; latest?: string }

const SNOOZE = 'drawa:update-snooze', DAY = 864e5, EVERY = 6 * 36e5
const box = make('div', 'float update')
box.setAttribute('role', 'status')
box.hidden = true
document.body.append(box)
let busy = false

const bold = (t: string) => make('b', '', t)

function say(state: string, text: (Node | string)[], action?: [string, () => void], close?: [string, () => void]) {
  box.dataset.state = state
  const msg = make('span')
  msg.append(...text)
  box.replaceChildren(msg)
  if (action) box.append(Object.assign(make('button', 'upd-go', action[0]), { onclick: action[1] }))
  if (close) box.append(make('i', 'upd-sep'), iconButton(ICON.x, close[0], close[1]))
  box.hidden = false
}

const hide = () => { box.hidden = true }

function offer(tag: string) {
  say('', [bold(tag), ' is available'], ['Update', () => install(tag, false)], ['Remind me later', () => {
    localStorage.setItem(SNOOZE, JSON.stringify({ v: tag, t: Date.now() }))
    hide()
  }])
}

async function install(tag: string, force: boolean) {
  busy = true
  say('busy', ['Updating to ', bold(tag), '…'])
  try {
    const r = await post('update', { force })
    if (r.working) {
      busy = false
      const n = r.working
      return say('', [`Restarting stops ${n} working session${n > 1 ? 's' : ''}`], ['Update anyway', () => install(tag, true)], ['Cancel', () => offer(tag)])
    }
    await restarted(tag)
  } catch {
    busy = false
    say('failed', ["Couldn't update. Run ", make('code', '', 'drawa --update')], undefined, ['Dismiss', hide])
  }
}

/** Waits for the server to come back as `tag`, then reloads for its UI; gives up after a minute. */
async function restarted(tag: string) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const v = await api<Version>('version').catch(() => null)
    if (v?.current === tag) return location.reload()
  }
  throw new Error('no restart')
}

async function check() {
  if (busy) return
  const v = await api<Version>('version').catch(() => null)
  if (!v?.latest || v.latest === v.current) return
  const s = JSON.parse(localStorage.getItem(SNOOZE) || 'null')
  if (s?.v === v.latest && Date.now() - s.t < DAY) return // a newer release than the snoozed one shows right away
  offer(v.latest)
}

check()
setInterval(check, EVERY)
