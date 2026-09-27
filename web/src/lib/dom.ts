// Small DOM helpers and the page's fixed elements.

export const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T

export function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string | null) {
  const e = document.createElement(tag)
  if (e instanceof HTMLButtonElement) e.type = 'button' // never a form's submit button by accident
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

const svg = (d: string) => `<svg viewBox="0 0 16 16">${d}</svg>`
export const ICON = {
  x: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  ungroup: svg('<path d="M2.5 2.5h5v5h-5zM8.5 8.5h5v5h-5z"/>'), // two boxes apart
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  up: svg('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>'),
  expand: svg('<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/>'),
  pencil: svg('<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/>'),
  pin: svg('<path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-3h-8v8h3"/>'),
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
  float: svg('<rect x="2" y="3" width="12" height="10" rx="1"/><rect x="7.5" y="7.5" width="5" height="4" fill="currentColor" stroke="none"/>'),
  full: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  collapse: svg('<path d="M3.5 8h9"/>'),
  open: svg('<path d="M4 6.5 8 10.5l4-4"/>'),
  sun: svg('<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>'),
  moon: svg('<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/>'),
  grip: svg('<circle cx="6" cy="4" r=".9"/><circle cx="10" cy="4" r=".9"/><circle cx="6" cy="8" r=".9"/><circle cx="10" cy="8" r=".9"/><circle cx="6" cy="12" r=".9"/><circle cx="10" cy="12" r=".9"/>'),
}

/** A v4 UUID. `crypto.randomUUID()` only works in secure contexts (https, or localhost) — this app is also
 *  opened over plain http from another device's browser on the network, where `getRandomValues` still works. */
export function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0'))
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h.slice(10).join('')}`
}

/** At most `max` characters, saying so at the end. The result stays within `max`, so clipping it again changes nothing. */
export const clip = (text: string, max: number, note = '\n… (truncated)') => (text.length > max ? text.slice(0, max - note.length) + note : text)

/** Elements you type into: keys there aren't shortcuts, and pasting there isn't the canvas's. */
export const EDITABLE = 'input, textarea, select, [contenteditable="plaintext-only"], [contenteditable="true"]'
/** Put a fixed-position element at (x, y), moved just enough to stay on screen (`top`: the lowest top allowed). */
export function keepOnScreen(el: HTMLElement, x: number, y: number, top = 8) {
  el.style.left = `${Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, x))}px`
  el.style.top = `${Math.max(top, Math.min(innerHeight - el.offsetHeight - 8, y))}px`
}
/** The nearest `sel` at a screen point, looking through everything stacked there (overlays included). */
export const closestAt = <T extends Element = HTMLElement>(x: number, y: number, sel: string) =>
  document.elementsFromPoint(x, y).map(el => el.closest<T>(sel)).find(Boolean) ?? null
/** Is this event target a field being typed in? */
export const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest(EDITABLE)
/** May a single-key shortcut run: not while typing, not while a dialog is open. */
export const shortcutOk = (e: KeyboardEvent) => !typing(e.target) && !document.querySelector('dialog[open]')

/** A square icon button; the click doesn't reach the window under it (no drag, no focus steal). */
export function iconButton(icon: string, label: string, onClick: () => void, cls = '') {
  const b = make('button', 'icon' + (cls ? ' ' + cls : ''))
  b.innerHTML = icon
  b.title = label
  b.setAttribute('aria-label', label)
  b.onclick = e => { e.stopPropagation(); onClick() }
  return b
}

/** Copies `text()` to the clipboard; the icon turns into a check for a moment to confirm. */
export function copyButton(text: () => string, label = 'Copy') {
  const flash = (ok: boolean) => {
    b.innerHTML = ok ? ICON.check : ICON.x
    b.classList.add(ok ? 'on' : 'failed')
    b.dataset.tip = ok ? label : 'Copy failed (the browser blocked the clipboard)'
    setTimeout(() => { b.innerHTML = ICON.copy; b.classList.remove('on', 'failed'); b.dataset.tip = label }, 1600)
  }
  // no clipboard outside secure pages (plain http on a LAN address): say so instead of doing nothing
  const b = iconButton(ICON.copy, label, () => {
    if (!navigator.clipboard?.writeText) return flash(false)
    navigator.clipboard.writeText(text()).then(() => flash(true), () => flash(false))
  }, 'copybtn')
  return b
}

/** A text button (.btn), optionally with a modifier class like primary. */
export function button(label: string, cls: string, onClick: () => void) {
  const b = make('button', 'btn' + (cls ? ' ' + cls : ''), label)
  b.onclick = onClick
  return b
}

/** The folder Claude works in, set once at boot from the server. */
export const project = { root: '', name: '' }
export const rel = (p: string) => (p && p.startsWith(project.root + '/') ? p.slice(project.root.length + 1) : p)

/** "5m ago", "3d ago", or the date once it's two months old. `t`: unix seconds, or an ISO date ('' gives ''). */
export const ago = (t: number | string) => {
  if (typeof t === 'string') { if (!t) return ''; t = Date.parse(t) / 1000 }
  const s = Date.now() / 1000 - t
  return s < 60 ? 'just now' : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : s < 86400 * 60 ? `${(s / 86400) | 0}d ago` : new Date(t * 1000).toLocaleDateString()
}

/** A link that opens outside the app, in a new tab. */
export function extLink(cls: string, text: string, href: string) {
  const a = make('a', cls, text) as HTMLAnchorElement
  if (/^https?:\/\//i.test(href)) Object.assign(a, { href, target: '_blank', rel: 'noopener' }) // never javascript: from a server field
  return a
}

/** "dir/sub/" muted + "file.ts" emphasized. */
export function pathEl(cls: string, p: string) {
  const e = make('span', cls), i = p.lastIndexOf('/') + 1
  e.append(p.slice(0, i), make('b', '', p.slice(i)))
  e.title = p
  return e
}

/** A brief outline flash drawing the eye to an element. Web Animations: no forced layout, safe to call often. */
let quietUntil = 0
export const ping = (el: HTMLElement) => {
  if (performance.now() < quietUntil || !el.isConnected) return
  const c = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  const to = reducedMotion() ? '3px' : '9px' // reduced motion: the outline fades where it is instead of spreading
  el.animate([{ outline: `2px solid ${c}`, outlineOffset: '3px' }, { outline: '2px solid transparent', outlineOffset: to }], { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)' })
}
const still = matchMedia('(prefers-reduced-motion: reduce)')
/** Has the user asked for less motion? (For script-driven motion like smooth scrolling; CSS has its own fallback.) */
export const reducedMotion = () => still.matches
/** No pings while something rebuilds in bulk (replaying a saved session would flash every file it touched). */
export const quietPings = (on: boolean) => { quietUntil = on ? Infinity : 0 }

/** In-app confirmation (instead of the browser's native confirm()). Resolves true when the action button is chosen. */
export function confirmBox(title: string, body: string, action: string): Promise<boolean> {
  const d = $<HTMLDialogElement>('#confirm')
  d.querySelector('h2')!.textContent = title
  d.querySelector('p')!.textContent = body
  d.querySelector<HTMLButtonElement>('button[value=ok]')!.textContent = action
  d.returnValue = ''
  d.onclick = e => { if (e.target === d) d.close('') } // click outside the box = cancel
  d.showModal()
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }))
}

/** A short message at the bottom of the screen that goes away by itself: for failures nobody would otherwise see. */
export function toast(text: string) {
  const t = document.body.appendChild(make('p', 'float toast', text))
  t.setAttribute('role', 'status')
  setTimeout(() => t.remove(), 6000)
}

/** `f`, run at most once per frame, with the latest arguments: for pointermove, scroll and wheel handlers. */
export function perFrame<A extends unknown[]>(f: (...a: A) => void) {
  let raf = 0, last: A
  return (...a: A) => { last = a; raf ||= requestAnimationFrame(() => { raf = 0; f(...last) }) }
}
