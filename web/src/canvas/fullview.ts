// Full view: any window can be lifted out to fill the screen (its tab's ⤢ button), still live: a session keeps
// streaming and takes typing. Esc or the same button puts it back exactly where it was (canvas or sidebar).
import { $, make, shortcutOk } from '../lib/dom'
import { changed, stage, onChange, holder } from './canvas'
import { redraw } from './graph'
import { setToggle } from './dock'
import { expand, collapse, focusInput } from './window'
import { drawing } from './ink'

// inside the stage, just under the pen's capture layer: Draw mode works on a window in full view too
const layer = holder(stage.insertBefore(make('div', 'fullview'), $('#ink-capture')))
layer.hidden = true
layer.setAttribute('role', 'dialog')
layer.setAttribute('aria-modal', 'false')
// clicking the dimmed margin around the window closes it
layer.addEventListener('pointerdown', e => { if (e.target === layer) exitFull() })

let open: { el: HTMLElement; spot: Comment; min: boolean } | undefined

export const isFull = (el: HTMLElement) => open?.el === el
/** Is any window in full view? */
export const anyFull = () => !!open
// the window in full view was closed (its ×): take the dimmed layer down with it
onChange(() => { if (open && !open.el.isConnected) exitFull() })

export function toggleFull(el: HTMLElement) {
  if (open?.el === el) return exitFull()
  exitFull() // one at a time
  const spot = document.createComment('full view') // holds its place (canvas or sidebar) while it's lifted out
  const min = el.classList.contains('min')
  el.replaceWith(spot)
  expand(el) // a full view of a tab alone is pointless (collapsed again on the way back)
  el.classList.add('full')
  layer.append(el)
  layer.hidden = false
  document.body.classList.add('has-full') // the minimap and hint step aside (panels.css)
  open = { el, spot, min }
  sync(el)
  focusInput(el)
  redraw()
}

export function exitFull() {
  if (!open) return
  const { el, spot, min } = open
  open = undefined
  layer.hidden = true
  document.body.classList.remove('has-full')
  if (!el.isConnected) { spot.remove(); return } // closed while in full view: it stays closed
  el.classList.remove('full')
  spot.replaceWith(el)
  if (min) collapse(el)
  sync(el)
  redraw()
  changed()
}

export const syncFull = (el: HTMLElement) => setToggle(el, 'fullbtn', isFull(el), 'Back to its place (Esc)', 'Full view (Shift+F)')
const sync = syncFull

// Esc leaves full view, unless it's backing out of something inside first (a menu, a field, Draw mode: Esc goes one
// layer at a time, and whichever handler takes it calls preventDefault)
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !open || e.defaultPrevented || drawing || !shortcutOk(e)) return
  if (document.querySelector('.xsel-menu, .cmds:not([hidden])')) return
  e.preventDefault()
  exitFull()
})
