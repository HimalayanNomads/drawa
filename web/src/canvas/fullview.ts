// Full view: any window can be lifted out to fill the screen (its tab's ⤢ button), still live: a session keeps
// streaming and takes typing. Esc or the same button puts it back exactly where it was (canvas or sidebar).
import { $, make, shortcutOk, focusedIn } from '../lib/dom'
import { changed, stage, onChange, holder } from './canvas'
import { redraw } from './graph'
import { setToggle } from './dock'
import { expand, collapse, focusInput, titleOf } from './window'
import { drawing } from './ink'
import { command } from '../lib/keys'
import type { PanzoomObject } from '@panzoom/panzoom'

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
  const had = focusedIn(el) // typing in it (a file being edited, a note): keep typing in full view
  const spot = document.createComment('full view') // holds its place (canvas or sidebar) while it's lifted out
  const min = el.classList.contains('min')
  el.replaceWith(spot)
  expand(el) // a full view of a tab alone is pointless (collapsed again on the way back)
  el.classList.add('full')
  layer.append(el)
  layer.hidden = false
  layer.setAttribute('aria-label', titleOf(el))
  document.body.classList.add('has-full') // the minimap and hint step aside (panels.css)
  open = { el, spot, min }
  sync(el)
  if (had) had.focus({ preventScroll: true })
  else focusInput(el)
  redraw()
  zoomable(el)
}

// A picture in full view (image, diagram, sketch, a previewed picture: anything drawn in a fitted inkBox) zooms with
// the wheel or a pinch and pans by dragging. The transform is on the ink box itself, so its strokes zoom with it and
// Draw mode places new ones from its on-screen rect (ink.ts placeAt): they land on the same spot at any zoom.
// ponytail: a pen's width is screen px at the moment of drawing, so strokes drawn zoomed in look thinner zoomed out.
let pz: PanzoomObject | undefined, pzBox: HTMLElement | undefined
function zoomable(el: HTMLElement) {
  const box = el.querySelector<HTMLElement>('[data-ink-fit]')
  if (!box) return
  import('@panzoom/panzoom').then(({ default: Panzoom }) => { // loaded on first use, as the zoom dialog does
    if (open?.el !== el || pz) return
    pzBox = box
    pz = Panzoom(box, { maxScale: 12, minScale: 1, step: 0.35, cursor: 'grab', animate: false })
  }, console.error)
}
function unzoom() {
  pz?.destroy()
  // destroy() only unbinds: clear the styles Panzoom set, or the body keeps touch-action:none and overflow:hidden
  if (pzBox) pzBox.style.transform = pzBox.style.cursor = pzBox.style.touchAction = pzBox.style.userSelect = pzBox.style.transformOrigin = pzBox.style.transition = ''
  const p = pzBox?.parentElement
  if (p) p.style.overflow = p.style.userSelect = p.style.touchAction = ''
  pz = pzBox = undefined
}
// capture phase: Draw mode's layer sits on top, and the wheel should zoom the picture under it, not pan the canvas
stage.addEventListener('wheel', e => {
  const r = pz && pzBox!.parentElement!.getBoundingClientRect()
  if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
  e.stopPropagation()
  pz!.zoomWithWheel(e)
}, { capture: true, passive: false })

addEventListener('keydown', e => {
  if (!pz || !shortcutOk(e) || e.ctrlKey || e.metaKey || e.altKey) return
  const f = ({ '+': pz.zoomIn, '=': pz.zoomIn, '-': pz.zoomOut, '0': pz.reset } as Record<string, () => unknown>)[e.key]
  if (!f) return
  e.preventDefault()
  f()
})
command({ label: 'Zoom the picture in full view in, out, back', group: 'Windows', keys: ['+', '-', '0'] })

/** `keys`: left from the keyboard, so focus goes back to ⤢ (a mouse exit leaves focus alone, or the tab's buttons stay shown) */
export function exitFull(keys = false) {
  if (!open) return
  const { el, spot, min } = open
  open = undefined
  unzoom()
  layer.hidden = true
  document.body.classList.remove('has-full')
  if (!el.isConnected) { spot.remove(); return } // closed while in full view: it stays closed
  el.classList.remove('full')
  const had = focusedIn(el)
  spot.replaceWith(el)
  if (min) collapse(el)
  sync(el)
  redraw()
  changed()
  if (!keys) return had?.focus({ preventScroll: true }) // left with the mouse while typing: carry on typing
  // .refocus shows the tab and ⤢ just long enough to take focus (window.css), then :focus-within keeps them shown
  el.classList.add('refocus')
  el.querySelector<HTMLElement>(':scope > .win-h .fullbtn')?.focus()
  el.classList.remove('refocus')
}

export const syncFull = (el: HTMLElement) => setToggle(el, 'fullbtn', isFull(el), 'Back to its place (Esc)', 'Full view (Shift+F)')
const sync = syncFull

// Esc leaves full view, unless it's backing out of something inside first (a menu, a field, Draw mode: Esc goes one
// layer at a time, and whichever handler takes it calls preventDefault)
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !open || e.defaultPrevented || drawing || !shortcutOk(e)) return
  if (document.querySelector('.xsel-menu, .cmds:not([hidden])')) return
  e.preventDefault()
  exitFull(true)
})
