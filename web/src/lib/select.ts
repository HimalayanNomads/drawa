// Custom dropdown over a native <select>. The select stays in the DOM (hidden) as the single source of
// truth, so code that reads/sets .value, assigns onchange, or replaces <option>s keeps working unchanged;
// we only render a trigger button and a popover listbox that mirror it.
import { keepOnScreen, make } from './dom'

let seq = 0
const svg = (d: string) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`
const CHEVRON = svg('M4.5 6.5 8 10l3.5-3.5'), CHECK = svg('M3.5 8.5l3 3 6-7')

export function enhance(select: HTMLSelectElement): void {
  const trigger = make('button', 'btn xsel')
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.innerHTML = `<span class="xsel-label"></span>${CHEVRON}`
  const label = trigger.firstElementChild as HTMLElement
  select.after(trigger)
  select.hidden = true
  const id = `xsel-${++seq}`
  let menu: HTMLElement | null = null, active = -1

  // Mirror everything the trigger shows from the select. Cheap, so it just runs on any change.
  const sync = () => {
    label.textContent = select.selectedOptions[0]?.textContent ?? ''
    for (const a of ['title', 'aria-label']) {
      const v = select.getAttribute(a)
      if (v == null) trigger.removeAttribute(a); else trigger.setAttribute(a, v)
    }
    if (select.dataset.mode) trigger.dataset.mode = select.dataset.mode; else delete trigger.dataset.mode
    if (select.dataset.loading !== undefined) trigger.dataset.loading = ''; else delete trigger.dataset.loading
    trigger.disabled = select.disabled
    if (menu) render() // options arrived (or changed) while open
  }

  // Programmatic `select.value = x` fires no event, so intercept the setters on this instance only.
  for (const prop of ['value', 'selectedIndex'] as const) {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop)!
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return d.get!.call(this) },
      set(v) { d.set!.call(this, v); sync() },
    })
  }
  new MutationObserver(sync).observe(select, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['data-mode', 'data-loading', 'title', 'aria-label', 'disabled', 'selected', 'label'],
  })
  select.addEventListener('change', sync)
  sync()

  function render() {
    menu!.replaceChildren(...[...select.options].map((o, i) => {
      const item = document.createElement('div')
      item.className = 'xsel-item'
      item.id = `${id}-${i}`
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(o.selected))
      item.innerHTML = CHECK
      const text = item.appendChild(document.createElement('span'))
      text.className = 'xsel-text'
      text.textContent = o.textContent
      if (o.title) {
        const desc = item.appendChild(document.createElement('span'))
        desc.className = 'xsel-desc'
        desc.textContent = o.title
      }
      item.onpointermove = () => setActive(i)
      item.onclick = () => choose(i)
      return item
    }))
    setActive(Math.min(active, select.options.length - 1))
  }

  function setActive(i: number) {
    active = i
    const items = menu!.children
    for (let j = 0; j < items.length; j++) items[j].classList.toggle('active', j === i)
    const el = items[i]
    if (el) { menu!.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }) }
    else menu!.removeAttribute('aria-activedescendant')
  }

  // Below the trigger; flip above when it doesn't fit and there is more room up there.
  function place() {
    const r = trigger.getBoundingClientRect(), m = menu!
    m.style.minWidth = `${r.width}px`
    const below = innerHeight - r.bottom, up = m.offsetHeight + 12 > below && r.top > below
    m.classList.toggle('up', up)
    keepOnScreen(m, r.left, up ? r.top - 6 - m.offsetHeight : r.bottom + 6)
  }

  function open() {
    if (menu || select.disabled) return
    menu = document.createElement('div')
    menu.className = 'xsel-menu'
    menu.id = id
    menu.tabIndex = -1
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', select.getAttribute('aria-label') ?? label.textContent ?? '')
    menu.onkeydown = onKey
    active = select.selectedIndex
    document.body.append(menu)
    render()
    place()
    trigger.setAttribute('aria-expanded', 'true')
    trigger.setAttribute('aria-controls', id)
    menu.focus({ preventScroll: true })
    addEventListener('pointerdown', onOutside, true)
    addEventListener('scroll', onScroll, true)
    addEventListener('resize', onResize)
  }

  function close(refocus = false) {
    if (!menu) return
    menu.remove()
    menu = null
    trigger.setAttribute('aria-expanded', 'false')
    trigger.removeAttribute('aria-controls')
    removeEventListener('pointerdown', onOutside, true)
    removeEventListener('scroll', onScroll, true)
    removeEventListener('resize', onResize)
    if (refocus) trigger.focus()
  }
  const onOutside = (e: Event) => { if (!menu!.contains(e.target as Node) && !trigger.contains(e.target as Node)) close() }
  const onScroll = (e: Event) => { if (!menu!.contains(e.target as Node)) close() } // the menu's own scroll is fine
  const onResize = () => close()

  function choose(i: number) {
    close(true)
    if (i < 0 || (i === select.selectedIndex && !('repick' in select.dataset))) return // data-repick: a menu of actions, where the same pick acts again
    select.selectedIndex = i
    // Same events a native pick fires, so existing onchange handlers run.
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function onKey(e: KeyboardEvent) {
    const n = select.options.length
    switch (e.key) {
      case 'ArrowDown': setActive(Math.min(active + 1, n - 1)); break
      case 'ArrowUp': setActive(Math.max(active - 1, 0)); break
      case 'Home': setActive(0); break
      case 'End': setActive(n - 1); break
      case 'Enter': case ' ': choose(active); break
      case 'Escape': close(true); break
      case 'Tab': close(true); return // focus is back on the trigger, so Tab carries on from there
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return
        // Type-ahead: next option (wrapping) whose label starts with the typed letter.
        const k = e.key.toLowerCase()
        for (let s = 1; s <= n; s++) {
          const i = (active + s) % n
          if (select.options[i].textContent?.trim().toLowerCase().startsWith(k)) { setActive(i); break }
        }
      }
    }
    e.preventDefault()
    e.stopPropagation() // keep app-wide shortcuts (N, D, S, F...) from firing while the list is open
  }

  trigger.onclick = () => (menu ? close() : open())
  trigger.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open() }
  }
}
