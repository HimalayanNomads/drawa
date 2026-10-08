// Custom dropdown over a native <select>. The select stays in the DOM (hidden) as the single source of
// truth, so code that reads/sets .value, assigns onchange, or replaces <option>s keeps working unchanged;
// we only render a trigger button and a popover listbox that mirror it.
import { keepOnScreen, make, iconButton } from './dom'

let seq = 0
const svg = (d: string) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`
const CHEVRON = svg('M4.5 6.5 8 10l3.5-3.5'), CHECK = svg('M3.5 8.5l3 3 6-7')

/** Rich menus: `row(o)` draws an option's row instead of its text and title (the check mark moves to its left), and
 *  `action(o)` adds a button at its right end (null: none). Tab from the list reaches the highlighted row's button, Tab or Shift+Tab
 *  from it goes back; `label` names the row too ("Remove worktree feat/auth"). Clicking it closes the menu
 *  without picking the row, then runs. */
export interface Rich {
  row(o: HTMLOptionElement): Node[]
  action?(o: HTMLOptionElement): { icon: string; label: string; run: () => void } | null
  /** The text a row matches when you type in the menu's search box (shown with more than SEARCH_FROM rows); `empty`
   *  is the row shown when nothing matches. */
  search?(o: HTMLOptionElement): string
  empty?: string
  /** Rows from which the search box shows (default SEARCH_FROM + 1): a short list can still want it. */
  searchFrom?: number
  /** Muted words before the trigger's label, saying what it picks ("2 worktrees:"); read again whenever the options change. */
  prefix?(): string
}

const SEARCH_FROM = 5

export function enhance(select: HTMLSelectElement, rich?: Rich): void {
  const trigger = make('button', 'btn xsel')
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.innerHTML = `<span class="xsel-label"></span>${CHEVRON}`
  const label = trigger.firstElementChild as HTMLElement
  const pre = rich?.prefix ? label.parentElement!.insertBefore(make('span', 'xsel-pre'), label) : null
  select.after(trigger)
  select.hidden = true
  const id = `xsel-${++seq}`
  // menu: the popover; list: its rows (the menu itself unless it has a search box, which stays put above them)
  let menu: HTMLElement | null = null, list: HTMLElement | null = null, box: HTMLInputElement | null = null, active = -1

  // Mirror everything the trigger shows from the select. Cheap, so it just runs on any change.
  const sync = () => {
    label.textContent = select.selectedOptions[0]?.textContent ?? ''
    if (pre) pre.textContent = rich!.prefix!()
    for (const a of ['title', 'aria-label']) {
      const v = select.getAttribute(a)
      if (v == null) trigger.removeAttribute(a); else trigger.setAttribute(a, v)
    }
    if (select.dataset.mode) trigger.dataset.mode = select.dataset.mode; else delete trigger.dataset.mode
    if (select.dataset.loading !== undefined) trigger.dataset.loading = ''; else delete trigger.dataset.loading
    trigger.disabled = select.disabled
    trigger.hidden = select.dataset.off !== undefined // nothing to pick right now (e.g. a model with no effort levels)
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
    attributes: true, attributeFilter: ['data-mode', 'data-loading', 'data-off', 'title', 'aria-label', 'disabled', 'selected', 'label'],
  })
  select.addEventListener('change', sync)
  sync()

  function render() {
    list!.replaceChildren(...[...select.options].map((o, i) => {
      const item = document.createElement('div')
      item.className = 'xsel-item'
      item.id = `${id}-${i}`
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(o.selected))
      item.innerHTML = CHECK
      item.onpointermove = () => setActive(i)
      item.onclick = () => choose(i)
      if (rich) {
        const body = item.appendChild(make('div', 'xsel-row'))
        body.append(...rich.row(o))
        const a = rich.action?.(o)
        // an option's children are presentational to screen readers: the row says what its button (a Tab away) does
        if (a) item.setAttribute('aria-description', `${a.label}: press Tab while highlighted`)
        if (a) item.append(iconButton(a.icon, a.label, () => { close(true); a.run() }, 'xsel-act'))
        return item
      }
      const text = item.appendChild(document.createElement('span'))
      text.className = 'xsel-text'
      text.textContent = o.textContent
      if (o.title) {
        const desc = item.appendChild(document.createElement('span'))
        desc.className = 'xsel-desc'
        desc.textContent = o.title
      }
      return item
    }))
    if (box) filter()
    else setActive(Math.min(active, select.options.length - 1))
  }

  /** Rows whose search text holds every typed term; the highlight moves to the first of them when it was filtered out. */
  function filter() {
    const terms = box!.value.toLowerCase().split(/\s+/).filter(Boolean), items = [...list!.querySelectorAll<HTMLElement>('.xsel-item')]
    items.forEach((el, i) => { const t = rich!.search!(select.options[i]).toLowerCase(); el.hidden = !terms.every(w => t.includes(w)) })
    list!.querySelector('.xsel-none')?.remove()
    const shown = visible()
    if (!shown.length) list!.append(make('div', 'xsel-none', rich!.empty ?? 'No matches'))
    setActive(shown.includes(active) ? active : shown[0] ?? -1)
  }
  /** Indexes of the rows not filtered out. */
  const visible = () => [...list!.querySelectorAll<HTMLElement>('.xsel-item')].flatMap((el, i) => el.hidden ? [] : [i])

  function setActive(i: number) {
    active = i
    const items = list!.querySelectorAll('.xsel-item'), home = box ?? menu!
    for (let j = 0; j < items.length; j++) items[j].classList.toggle('active', j === i)
    const el = items[i]
    if (el) { home.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }) }
    else home.removeAttribute('aria-activedescendant')
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
    menu.className = rich ? 'xsel-menu xsel-rich' : 'xsel-menu'
    menu.id = id
    menu.tabIndex = -1
    list = menu
    box = null
    if (rich?.search && select.options.length >= (rich.searchFrom ?? SEARCH_FROM + 1)) {
      menu.classList.add('xsel-search')
      box = menu.appendChild(make('input', 'xsel-find'))
      box.type = 'search'
      box.placeholder = 'Search'
      box.setAttribute('aria-label', 'Search the list')
      box.setAttribute('role', 'combobox')
      box.setAttribute('aria-controls', `${id}-list`)
      box.oninput = filter
      list = menu.appendChild(make('div', 'xsel-list'))
      list.id = `${id}-list`
    }
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', select.getAttribute('aria-label') ?? label.textContent ?? '')
    menu.onkeydown = onKey
    // Tab can walk into the rows' buttons: leaving the menu altogether closes it
    menu.addEventListener('focusout', e => { if (menu && !menu.contains(e.relatedTarget as Node) && e.relatedTarget !== trigger) close() })
    active = select.selectedIndex
    document.body.append(menu)
    render()
    place()
    if (box) menu.style.width = `${menu.offsetWidth}px` // filtering hides rows: the menu keeps its width rather than jumping
    trigger.setAttribute('aria-expanded', 'true')
    trigger.setAttribute('aria-controls', id)
    ;(box ?? menu).focus({ preventScroll: true })
    addEventListener('pointerdown', onOutside, true)
    addEventListener('scroll', onScroll, true)
    addEventListener('resize', onResize)
  }

  function close(refocus = false) {
    if (!menu) return
    const m = menu
    menu = list = box = null // first: removing it moves focus, and its focusout would close again
    m.remove()
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
    const n = select.options.length, typing = !!box && e.target === box
    const onButton = e.target !== menu && !typing
    if (onButton && (e.key === 'Enter' || e.key === ' ')) { e.stopPropagation(); return } // the row's button acts, not the row
    if (onButton && e.key.startsWith('Arrow')) (box ?? menu!).focus({ preventScroll: true })
    // in the search box, keys type and edit (Home, End, Space and letters included); arrows and Enter still drive the list
    if (typing && !['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) { e.stopPropagation(); return }
    const shown = box ? visible() : [...Array(n).keys()], at = shown.indexOf(active)
    switch (e.key) {
      case 'ArrowDown': setActive(shown[Math.min(at + 1, shown.length - 1)] ?? -1); break
      case 'ArrowUp': setActive(shown[Math.max(at - 1, 0)] ?? -1); break
      case 'Home': setActive(shown[0] ?? -1); break
      case 'End': setActive(shown[shown.length - 1] ?? -1); break
      case 'Enter': case ' ': if (shown.includes(active)) choose(active); break
      case 'Escape':
        if (box?.value) { box.value = ''; filter(); box.focus() } else close(true) // the text first, then the menu
        break
      case 'Tab': {
        if (onButton) { (box ?? menu!).focus({ preventScroll: true }); break } // back to the list, its row still highlighted
        const act = !e.shiftKey && list!.querySelectorAll('.xsel-item')[active]?.querySelector<HTMLElement>('.xsel-act')
        if (act) { act.focus(); break } // the highlighted row's button, not the first one in DOM order
        close(true); return
      } // focus is back on the trigger, so Tab carries on from there
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

/** A row of buttons over a native <select>, for a few short choices; like `enhance`, the select stays the source of truth. */
export function segmented(select: HTMLSelectElement): void {
  const row = make('div', 'seg')
  row.setAttribute('role', 'radiogroup')
  const name = select.id && document.querySelector(`label[for="${select.id}"]`)?.textContent
  if (name) row.setAttribute('aria-label', name)
  select.after(row)
  select.hidden = true
  const sync = () => [...row.children].forEach((b, i) => {
    const on = select.options[i]?.selected ?? false
    b.classList.toggle('on', on)
    b.setAttribute('aria-checked', String(on))
  })
  const render = () => {
    row.replaceChildren(...[...select.options].map(o => {
      const b = make('button', '', o.textContent)
      b.setAttribute('role', 'radio')
      if (o.title) b.title = o.title
      b.onclick = () => { if (o.selected) return; select.value = o.value; select.dispatchEvent(new Event('change')) }
      return b
    }))
    sync()
  }
  for (const prop of ['value', 'selectedIndex'] as const) {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop)!
    Object.defineProperty(select, prop, { configurable: true, get() { return d.get!.call(this) }, set(v) { d.set!.call(this, v); sync() } })
  }
  new MutationObserver(render).observe(select, { childList: true, subtree: true, characterData: true })
  select.addEventListener('change', sync)
  render()
}
