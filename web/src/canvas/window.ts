// Windows on the canvas (session cards, terminals, diagrams, sketches, plans) share one shape: a folder.
// The header is a tab on the top-left that carries the title and the window's buttons; the body sits under it.
// Drag by the tab, double-click it (or its – button) to collapse the window down to the tab, resize from the corner.
import { make, ICON, iconButton } from '../lib/dom'
import { addItem, place, front, draggable, resizable, changed, type Rect } from './canvas'
import { redraw, forget } from './graph'
import { toggleDock, toggleFloat, syncPin } from './dock'
import { toggleFull, syncFull } from './fullview'
import { refIcon, refOf, winTitle } from './refs'
import { tipText } from '../lib/tooltip'

interface WindowOpts {
  kind: string // data-kind: minimap color, saved layout, references
  cls: string // the window's own class, for its content styles
  title: string
  rect: Rect
  minW: number
  minH: number
  actions?: HTMLElement[] // buttons at the tab's end (the collapse button goes before them)
  onChange?: () => void // after it moves, resizes or collapses (default: re-route the edges)
}
export { winTitle } // its home is refs.ts
/** What to call any canvas item: its window title, else its reference label, else its title attribute. */
export const titleOf = (el: HTMLElement) => (winTitle(el) || refOf(el)?.label || tipText(el)).trim()
/** Open a collapsed window. */
export const expand = (el: HTMLElement) => { if (el.classList.contains('min')) el.querySelector<HTMLElement>('.minbtn')?.click() }
/** Collapse an open window to its tab. */
export const collapse = (el: HTMLElement) => { if (!el.classList.contains('min')) el.querySelector<HTMLElement>('.minbtn')?.click() }
/** Put the cursor in a window's message box, if it has one. */
export const focusInput = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('.compose textarea')?.focus({ preventScroll: true })
/** Rename a window: its tab, plus a `rename` event for kinds that keep their title elsewhere (a session's title, a
 *  plan's name, an image's alt text). Use this, not the tab's textContent, so they stay in step. */
export function setTitle(el: HTMLElement, name: string) {
  const t = el.querySelector(':scope > .win-h .t')
  if (!t || t.textContent === name) return
  t.textContent = name
  el.dispatchEvent(new CustomEvent('rename', { detail: name }))
  changed()
}

/** The × that takes an item off the canvas: its arrows go, it's removed, the layout is saved. `also`: the kind's
 *  own cleanup (stored data). Finds its item when clicked, so it can be made before the window exists. */
export function removeButton(label: string, also?: (el: HTMLElement) => void, cls = '') {
  const b: HTMLButtonElement = iconButton(ICON.x, label, () => {
    const el = b.closest<HTMLElement>('.item')
    if (!el) return
    forget(el)
    el.remove()
    also?.(el)
    changed()
  }, 'closebtn' + (cls ? ' ' + cls : '')) // closebtn: how a multi-select delete finds each item's own way out
  return b
}

interface Win { el: HTMLElement; head: HTMLElement; title: HTMLElement; body: HTMLElement }

export function makeWindow(o: WindowOpts): Win {
  const el = make('div', 'win ' + o.cls), head = make('header', 'win-h'), title = make('span', 't', o.title), body = make('div', 'win-b')
  title.dataset.glyph = refIcon(o.kind) // the tab's glyph is the kind's icon (see referable)
  head.append(title, ...(o.actions ?? []))
  el.append(head, body)
  addItem(el, o.kind)
  place(el, o.rect.x, o.rect.y)
  el.style.width = `${o.rect.w}px`
  el.style.height = `${o.rect.h}px`
  front(el)
  const onChange = o.onChange ?? redraw
  draggable(el, head, onChange)
  minimizable(el, head, onChange, !!o.rect.min)
  head.insertBefore(make('span', 'spacer'), head.querySelector(':scope > .minbtn'))
  // stick to screen, pin and full view: in a strip just outside the tab, so showing them on hover never moves
  // minimize and close (a narrow tab would otherwise shrink its title and shift them)
  const extra = head.appendChild(make('span', 'win-x')).appendChild(make('span'))
  extra.append(iconButton(ICON.float, '', () => toggleFloat(el), 'floatbtn'), iconButton(ICON.pin, '', () => toggleDock(el), 'pinbtn'), iconButton(ICON.full, '', () => toggleFull(el), 'fullbtn'))
  syncPin(el)
  syncFull(el)
  resizable(el, o.minW, o.minH, onChange)
  renamable(el, title)
  return { el, head, title, body }
}

/** Double-click the title to rename the window (Enter saves, Esc cancels). The new name goes out as a `rename`
 *  event, for kinds that keep their title elsewhere (a session's title, a plan's name across versions). */
function renamable(el: HTMLElement, t: HTMLElement) {
  t.title = 'Double-click or F2 to rename'
  t.addEventListener('dblclick', e => { e.stopPropagation(); rename(el) })
}
/** Edit a window's title in place (its tab's double-click, or F2). */
export function rename(el: HTMLElement) {
  const t = el.querySelector<HTMLElement>(':scope > .win-h .t')
  if (!t || t.isContentEditable) return
  const before = t.textContent ?? ''
  t.contentEditable = 'plaintext-only'
  t.classList.add('renaming')
  t.focus()
  getSelection()?.selectAllChildren(t)
  const done = (keep: boolean) => {
    t.removeEventListener('keydown', key)
    t.contentEditable = 'false'
    t.classList.remove('renaming')
    const name = (t.textContent ?? '').replace(/\s+/g, ' ').trim()
    t.textContent = before
    if (keep && name) setTitle(el, name)
  }
  const key = (k: KeyboardEvent) => {
    k.stopPropagation() // typing isn't a canvas shortcut
    if (k.key === 'Enter') { k.preventDefault(); t.blur() }
    else if (k.key === 'Escape') { k.preventDefault(); done(false) }
  }
  t.addEventListener('keydown', key)
  t.addEventListener('blur', () => { if (t.isContentEditable) done(true) }, { once: true })
}

/** Collapse a window to its tab. `start` restores a saved collapse. */
function minimizable(el: HTMLElement, head: HTMLElement, onToggle: () => void, start: boolean) {
  const b = make('button', 'icon minbtn')
  const sync = () => {
    const min = el.classList.contains('min')
    b.innerHTML = min ? ICON.open : ICON.collapse
    b.title = min ? 'Expand (M)' : 'Collapse (M)'
    b.setAttribute('aria-label', b.title)
    b.setAttribute('aria-expanded', String(!min))
  }
  const toggle = () => {
    if (!el.classList.contains('min')) el.dataset.fullH = String(el.offsetHeight)
    const min = el.classList.toggle('min')
    sync()
    onToggle()
    changed()
    el.dispatchEvent(new CustomEvent('collapse', { detail: min, bubbles: true })) // e.g. a session takes its windows along
  }
  b.onclick = e => { e.stopPropagation(); toggle() }
  head.addEventListener('dblclick', e => { if (!(e.target as Element).closest('button, input, .t')) toggle() }) // the title renames instead
  head.insertBefore(b, head.querySelector(':scope > button'))
  if (start) { el.dataset.fullH = String(parseFloat(el.style.height) || el.offsetHeight); el.classList.add('min') }
  sync()
}
