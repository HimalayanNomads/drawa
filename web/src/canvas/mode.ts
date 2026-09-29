// The canvas's two pointer modes, like Excalidraw: Select (drag on empty canvas draws a selection box) and Hand
// (drag pans). Holding Space is a temporary hand. Middle button and wheel always pan, whichever mode.
import { $, shortcutOk, pressed } from '../lib/dom'
import { persist, saveSoon } from '../lib/store'
import { stage } from './canvas'

export type Mode = 'select' | 'hand'
// phones and tablets without a mouse: one finger has to pan
let mode: Mode = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches ? 'hand' : 'select'
let space = false
const buttons = { select: $('#mode-select'), hand: $('#mode-hand') }

/** Does a drag on empty canvas pan right now? */
export const handDrag = () => mode === 'hand' || space

function sync() {
  stage.classList.toggle('hand', handDrag())
  for (const [m, b] of Object.entries(buttons)) pressed(b, m === mode)
}
export function setMode(m: Mode) { mode = m; sync(); saveSoon() }
persist('mode', () => mode, (m: Mode) => { if (m === 'select' || m === 'hand') setMode(m) }, 0)

buttons.select.onclick = () => setMode('select')
buttons.hand.onclick = () => setMode('hand')

addEventListener('keydown', e => {
  if (e.key !== ' ' || !shortcutOk(e) || (e.target as Element).closest?.('button')) return // Space on a button presses it
  e.preventDefault() // no page scroll
  if (!space) { space = true; sync() }
})
addEventListener('keyup', e => { if (e.key === ' ' && space) { space = false; sync() } })
addEventListener('blur', () => { if (space) { space = false; sync() } }) // released in another window
sync()
