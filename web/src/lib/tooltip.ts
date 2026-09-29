// Tooltips in the app's own style instead of the browser's: any element's `title` shows here on hover (after a short
// pause) and on keyboard focus. The title moves to data-tip while shown so the native one never appears; code can keep
// setting `title` as usual.
import { keepOnScreen } from './dom'
const tip = document.body.appendChild(document.createElement('div'))
tip.className = 'tip'
tip.setAttribute('role', 'tooltip')
tip.hidden = true
let target: HTMLElement | null = null, timer = 0
// a modal dialog sits in the top layer, over anything in the page: while one is open the tooltip goes inside it
const place = () => { const host = document.querySelector('dialog:modal') ?? document.body; if (tip.parentElement !== host) host.append(tip) }

function claim(el: HTMLElement) {
  if (el.title) {
    el.dataset.tip = el.title
    // an icon-only control would lose its name with its title
    if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', el.title)
    el.removeAttribute('title')
  }
  return el.dataset.tip ?? ''
}

function show(el: HTMLElement) {
  const text = claim(el)
  if (!text || !el.isConnected) return
  place()
  tip.textContent = text
  tip.hidden = false
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect()
  const below = r.bottom + 8 + t.height < innerHeight
  keepOnScreen(tip, r.left + r.width / 2 - t.width / 2, below ? r.bottom + 8 : r.top - 8 - t.height)
  requestAnimationFrame(stillThere)
}
// an element removed while its tooltip shows (a re-rendered row, a closed window) takes the tooltip with it
function stillThere() { if (!tip.hidden && target) target.isConnected ? requestAnimationFrame(stillThere) : hide() }
function hide() { clearTimeout(timer); target = null; tip.hidden = true }

/** Show a tooltip at a point, for things that aren't elements (marked text). */
export function tipAt(text: string, x: number, y: number) {
  clearTimeout(timer)
  target = null
  place()
  tip.textContent = text
  tip.hidden = false
  keepOnScreen(tip, x + 12, y + 18)
}
export const hideTip = () => { if (!target) hide() } // only a tipAt one: an element's tooltip hides by itself

document.addEventListener('pointerover', e => {
  if (e.pointerType === 'touch') return
  const el = (e.target as Element).closest?.<HTMLElement>('[title], [data-tip]')
  if (el === target) return
  hide()
  if (!el) return
  target = el
  claim(el) // right away: the native tooltip would otherwise start its own timer
  timer = setTimeout(() => show(el), 450)
})
document.addEventListener('focusin', e => {
  const el = (e.target as Element).closest?.<HTMLElement>('[title], [data-tip]')
  if (el?.matches(':focus-visible') && !el.isContentEditable) { hide(); target = el; show(el) } // a field being typed in: its tip would cover it (editable text always counts as focus-visible)
})
for (const t of ['pointerdown', 'focusout', 'wheel', 'keydown']) addEventListener(t, hide, { capture: true, passive: true })
addEventListener('scroll', hide, { capture: true, passive: true })

/** An element's title, wherever it is now (a tooltip may have moved it to data-tip). */
export const tipText = (el: Element | null | undefined) => (el instanceof HTMLElement ? el.title || el.dataset.tip : '') ?? ''
