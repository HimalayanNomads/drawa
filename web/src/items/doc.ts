// Docs: Markdown windows on the canvas. Rendered like a reply (headings, lists, code blocks with copy and pin,
// Mermaid diagrams, GitHub callouts); the pencil or a double-click edits the source, Ctrl/Cmd+Enter or Esc shows
// it again. S or the toolbar's Scratchpad makes one in view; Claude makes and edits them with canvas_create /
// canvas_update (kind "doc").
import { make, ICON, iconButton, clip, uuid } from '../lib/dom'
import { persist, each } from '../lib/store'
import { md, enhance } from '../lib/markdown'
import { onTheme } from '../lib/theme'
import { items, savedRect, freeSpot, viewCenter, centerOn, changed, type Rect } from '../canvas/canvas'
import { makeWindow, removeButton, winTitle } from '../canvas/window'
import { referable } from '../canvas/refs'
import { creatable } from '../canvas/tools'

const headingOf = (t: string) => /^#{1,3}\s+(.+)$/m.exec(t)?.[1].trim().slice(0, 60)
interface Saved { id: string; title: string; text: string; rect: Rect }
const MAX = 20_000 // characters kept per doc (the whole layout shares localStorage's ~5 MB)

// before any window: the tab's glyph is this icon
referable('doc', {
  icon: '▦',
  name: 'scratchpad',
  content: (el, label) => ({ text: `Markdown note "${label}" from my canvas:\n\n${el.dataset.src ?? ''}` }),
})

const shown = new WeakMap<HTMLElement, string>() // the source each doc's view was last drawn from

/** Show the source rendered. The content sits inside the scroller so a redraw keeps the ink layer next to it. */
function render(el: HTMLElement) {
  const out = el.querySelector<HTMLElement>('.mdoc-md')!, src = el.dataset.src ?? ''
  out.innerHTML = md(src.trim() || '*Empty. Double-click to write.*')
  enhance(out)
  shown.set(el, src)
}

function setSrc(el: HTMLElement, text: string) {
  el.dataset.src = clip(text, MAX)
  const t = el.querySelector('.win-h .t'), h = headingOf(text)
  if (t && h && t.textContent === 'Scratchpad') t.textContent = h // untitled: named after its first heading (a rename wins)
  if (shown.get(el) !== el.dataset.src) render(el) // unchanged (a click in and out): no redraw, no Mermaid rerun
  changed()
}
/** Claude's text: refused whole rather than cut short, so it hears why. */
function checked(a: Record<string, any>) {
  const text = String(a.text ?? '')
  if (text.length > MAX) throw new Error(`A scratchpad holds at most ${MAX.toLocaleString()} characters; this is ${text.length.toLocaleString()}. Split it or shorten it.`)
  return text
}

export function doc(o: { id?: string; title?: string; text?: string; rect?: Rect; edit?: boolean } = {}) {
  const id = o.id ?? uuid(), c = viewCenter()
  const view = make('div', 'mdoc-b'), out = make('div', 'md mdoc-md'), ta = make('textarea', 'mdoc-ed')
  const pencil = iconButton(ICON.pencil, 'Edit (double-click the text too)', () => toggle())
  const { el, body } = makeWindow({
    kind: 'doc', cls: 'mdoc', title: o.title ?? 'Scratchpad', minW: 220, minH: 140,
    rect: o.rect ?? freeSpot({ x: c.x - 210, y: c.y - 180, w: 420, h: 360 }),
    actions: [pencil, removeButton('Remove from canvas')],
  })
  el.dataset.id = id
  view.dataset.ink = 'm:' + id // drawing on it scrolls with the text
  view.append(out)
  ta.hidden = true
  ta.spellcheck = false
  ta.maxLength = MAX
  ta.placeholder = '# Markdown\n\nLists, code blocks, ```mermaid diagrams, > [!NOTE] callouts…'
  ta.setAttribute('aria-label', 'Markdown source')
  body.append(view, ta)
  const toggle = (edit = !!ta.hidden) => {
    if (!edit && !ta.hidden) setSrc(el, ta.value)
    ta.hidden = !edit
    view.hidden = edit
    pencil.classList.toggle('on', edit)
    if (edit) { ta.value = el.dataset.src ?? ''; ta.focus() }
  }
  view.addEventListener('dblclick', e => { if (!(e.target as Element).closest('a, button, .codeblock, .mermaid')) toggle(true) }) // a diagram's click zooms
  ta.addEventListener('keydown', e => {
    e.stopPropagation() // typing isn't a canvas shortcut
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); toggle(false) }
  })
  ta.addEventListener('blur', () => { if (!ta.hidden) setSrc(el, ta.value) }) // clicking away keeps what you wrote
  ta.addEventListener('input', () => { el.dataset.src = ta.value; changed() }) // the draft is saved as you type (drawn when you leave)
  setSrc(el, o.text ?? '')
  if (o.edit) { centerOn(el); toggle(true) }
  return el
}

// Mermaid draws in the theme's colors. ponytail: redraws whole docs, and relies on diagram.ts's onTheme (registered
// first) re-initialising Mermaid before these run; redraw only the diagrams if docs get big or many.
onTheme(() => items('doc').forEach(render))

creatable('doc', {
  size: () => ({ w: 420, h: 360 }),
  create: (a, r) => doc({ text: checked(a), title: a.title == null ? undefined : String(a.title), rect: r }), // untitled: setSrc names it from its heading
  update: (el, a) => {
    const text = checked(a), ta = el.querySelector<HTMLTextAreaElement>('.mdoc-ed')
    if (ta && !ta.hidden) ta.value = text // being edited: Claude's text replaces the draft in the box too, so leaving edit keeps it
    setSrc(el, text)
  },
})
// ponytail: every doc is drawn at boot, Mermaid included, even far off-screen; draw on first sight
// (IntersectionObserver) if boot slows with dozens of diagram-heavy docs
persist('docs',
  () => items('doc').map((el): Saved => ({ id: el.dataset.id!, title: winTitle(el), text: el.dataset.src ?? '', rect: savedRect(el) })),
  (list: Saved[]) => each(list, d => doc(d)))
