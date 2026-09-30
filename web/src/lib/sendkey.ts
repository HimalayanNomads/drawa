// Which key sends a message from a message box (a session card's, a sub-agent's): Enter (Shift+Enter for a new
// line), or Ctrl/Cmd+Enter (Enter for a new line), chosen in the toolbar's Settings panel. Remembered per browser.
import { $ } from './dom'
import { enhance } from './select'
import { MOD } from './keys'

type Send = 'enter' | 'mod'
const KEY = 'drawa:send'
const load = (): Send => { try { return localStorage.getItem(KEY) === 'mod' ? 'mod' : 'enter' } catch { return 'enter' } }
let key = load()

const listeners: (() => void)[] = []
/** Called after the setting changes, to re-label hints and buttons. */
export const onSendKey = (f: () => void) => void listeners.push(f)
export const sendKey = () => key
/** The combo that sends, for labels: "Enter" or "Ctrl+Enter" (⌘ on a Mac). */
export const sendCombo = () => (key === 'enter' ? 'Enter' : `${MOD}+Enter`)
/** Does this keydown send? Ctrl/Cmd+Enter sends either way, so the old habit keeps working; never mid-IME. */
export const isSend = (e: KeyboardEvent) =>
  e.key === 'Enter' && !e.isComposing && (e.ctrlKey || e.metaKey || (key === 'enter' && !e.shiftKey && !e.altKey))

const sel = $<HTMLSelectElement>('#send-key')
sel.replaceChildren(...([['enter', 'Enter'], ['mod', `${MOD}+Enter`]] as const).map(([value, textContent]) => Object.assign(document.createElement('option'), { value, textContent })))
sel.value = key
sel.onchange = () => {
  key = sel.value === 'mod' ? 'mod' : 'enter'
  try { localStorage.setItem(KEY, key) } catch {}
  listeners.forEach(f => f())
}
enhance(sel)
