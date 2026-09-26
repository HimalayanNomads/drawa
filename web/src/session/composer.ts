// A card's message box: the textarea with send / stop, the "/" (skills, commands) and "@" (canvas items) menu,
// and the chips for canvas items attached to the next message (typed with @ or dropped on the box).
import { make, ICON, ping } from '../lib/dom'
import { api, post, q as enc } from '../lib/api'
import { centerOn, onDrop, onCanvas } from '../canvas/canvas'
import { link, unlink } from '../canvas/graph'
import { canvasRefs, refOf, refIcon, type Ref } from '../canvas/refs'
import { cards, focus, meta, clearSession, type Session } from './session'
import { send } from './live'
import { readImages, thumb } from './images'
import { textRefs } from './uploads'
import { runShell } from './shell'
import { modePicker } from './mode'
import { recall } from './recall'
import { enhance } from '../lib/select'

/** Build the composer at the bottom of the card's body and hook it to the session. */
export function composer(S: Session, body: HTMLElement) {
  const chips = make('div', 'refs'), form = make('form', 'compose'), ta = make('textarea')
  const stopBtn = make('button', 'send stop'), sendBtn = make('button', 'send')
  ta.rows = 1
  ta.setAttribute('aria-label', 'Message Claude')
  stopBtn.type = 'button'
  stopBtn.innerHTML = ICON.stop
  stopBtn.title = 'Stop what Claude is doing'
  stopBtn.setAttribute('aria-label', 'Stop')
  sendBtn.type = 'submit'
  sendBtn.innerHTML = ICON.up
  sendBtn.title = 'Send (Enter)'
  sendBtn.setAttribute('aria-label', 'Send')
  const pick = modePicker(S)
  form.append(ta, pick, stopBtn, sendBtn)
  chips.hidden = true
  const dock = make('div', 'dock') // the card's footer: attached references above a clearly bordered message field
  dock.append(chips, form)
  body.append(dock)
  enhance(pick) // the custom dropdown, once the picker is in the page
  form.onclick = e => { if (e.target === form) ta.focus() } // the whole field is the click target
  Object.assign(S, { ta, stopBtn, chips })

  stopBtn.onclick = () => post('interrupt', { cid: S.cid }).catch(() => {})
  form.onsubmit = e => {
    e.preventDefault()
    const p = ta.value.trim()
    if (p.startsWith('!')) { // shell mode: run it here, it goes to Claude with the next message
      if (!p.slice(1).trim()) return
      ta.value = ''
      ta.style.height = ''
      form.classList.remove('shell')
      runShell(S, p.slice(1).trim())
      return
    }
    if (/^\/clear\s*$/.test(p)) { ta.value = ''; ta.style.height = ''; clearSession(S); return } // handled here: see clearSession
    if (!p && !S.refs.length && !S.images.length) return
    ta.value = ''
    ta.style.height = ''
    const refs = S.refs.splice(0), images = S.images.splice(0)
    drawChips(S)
    send(S, p || (images.length && !refs.length ? 'Take a look at this.' : 'Take a look at these.'), undefined, refs, images)
  }
  // images: paste them (Ctrl+V) or drop image files on the message box
  const attach = async (files: File[]) => {
    const got = await readImages(files)
    if (!got.length) return
    S.images.push(...got)
    drawChips(S)
    ta.focus()
  }
  // anything else: text files go along as their contents (session/uploads.ts)
  const attachAny = async (files: File[]) => {
    const images = files.filter(f => f.type.startsWith('image/'))
    if (images.length) attach(images)
    for (const r of await textRefs(files.filter(f => !f.type.startsWith('image/')))) addRef(S, r)
  }
  ta.addEventListener('paste', e => {
    const files = [...e.clipboardData?.files ?? []]
    if (files.length) { e.preventDefault(); attachAny(files) }
  })
  dock.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dock.classList.add('dropping') } })
  dock.addEventListener('dragleave', e => { if (!dock.contains(e.relatedTarget as Node)) dock.classList.remove('dropping') })
  dock.addEventListener('drop', e => {
    dock.classList.remove('dropping')
    const files = [...e.dataTransfer?.files ?? []]
    if (files.length) { e.preventDefault(); attachAny(files) }
  })
  const fit = () => {
    ta.style.height = 'auto'
    ta.style.height = ta.scrollHeight + 'px'
    ta.style.overflowY = ta.scrollHeight > 180 ? 'auto' : 'hidden' // scroll only past the max height
    form.classList.toggle('shell', ta.value.startsWith('!')) // shell mode: amber field, $ prompt
  }
  ta.oninput = fit
  commandMenu(S, form)
  // after the menu's handler: when the "/" or "@" menu is open, it takes Up/Down (and prevents the default)
  const step = recall(ta, S.log)
  ta.addEventListener('keydown', e => { if (!e.defaultPrevented && step(e)) { e.preventDefault(); fit() } })
}

/* ---------- "/" menu: skills and slash commands; "@" menu: canvas items ---------- */
function commandMenu(S: Session, form: HTMLFormElement) {
  const menu = make('div', 'cmds')
  menu.setAttribute('role', 'listbox')
  menu.hidden = true
  form.before(menu)
  let items: { title: string; sub: string; pick: () => void }[] = [], sel = 0
  // project files for "@": fetched per query (server-side fuzzy search), newest answer wins
  let fileQ: string | null = null, found: string[] = [], typing = 0
  const searchFiles = (q: string) => {
    if (q === fileQ) return
    fileQ = q
    clearTimeout(typing) // ask once typing pauses, not per keystroke (each ask scans every project file)
    typing = setTimeout(() => api<string[]>('files?q=' + enc(q)).then(list => { if (fileQ === q) { found = list; if (!menu.hidden || document.activeElement === S.ta) draw() } }).catch(() => {}), 120)
  }
  const pick = (i: number) => {
    const it = items[i]
    if (!it) return
    it.pick()
    menu.hidden = true
    S.ta.focus()
    draw()
  }
  const draw = () => {
    const before = S.ta.value.slice(0, S.ta.selectionStart)
    const at = /(^|\s)@([^\s@]*)$/.exec(before)
    if (at) {
      const q = at[2].toLowerCase()
      items = canvasRefs().filter(r => r.label.toLowerCase().includes(q) && !S.refs.some(x => x.el === r.el)).slice(0, 40).map(r => ({
        title: `${refIcon(r.kind)}  ${r.label}`,
        sub: r.kind,
        pick: () => {
          const start = before.length - at[2].length - 1
          S.ta.setRangeText('', start, S.ta.selectionStart, 'end')
          addRef(S, r)
        },
      }))
      searchFiles(at[2])
      const start = before.length - at[2].length - 1
      items.push(...found.slice(0, 40 - items.length).map(path => ({
        title: path,
        sub: 'file',
        // like the terminal: the path goes into the message as @path, and Claude reads it
        pick: () => { S.ta.setRangeText(`@${path} `, start, S.ta.selectionStart, 'end') },
      })))
      if (!items.length) items = [{ title: at[2] ? 'No matches' : 'Type to search files', sub: 'Project files, and scratchpads, diagrams, plans and notes on the canvas', pick: () => {} }]
    } else {
      const q = S.ta.value.slice(1).toLowerCase()
      items = !S.ta.value.startsWith('/') || S.ta.value.includes(' ') ? [] : meta.commands
        .filter(c => c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
        .slice(0, 40)
        .map(c => ({
          title: '/' + c.name + (c.argumentHint ? ' ' + c.argumentHint : ''),
          sub: c.description.replace(/\s*\((user|project|plugin[^)]*)\)$/, ''),
          pick: () => { S.ta.value = `/${c.name} ` },
        }))
    }
    menu.hidden = !items.length
    sel = Math.max(0, Math.min(sel, items.length - 1))
    menu.replaceChildren(...items.map((c, i) => {
      const o = make('button', 'cmd' + (i === sel ? ' on' : ''))
      o.type = 'button'
      o.setAttribute('role', 'option')
      o.append(make('b', '', c.title), make('span', '', c.sub))
      o.onmousedown = e => { e.preventDefault(); pick(i) }
      return o
    }))
    menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }
  S.ta.addEventListener('input', () => { sel = 0; draw() })
  S.ta.addEventListener('blur', () => setTimeout(() => (menu.hidden = true), 100))
  S.ta.addEventListener('keydown', e => {
    if (!menu.hidden && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; draw(); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(sel); return }
      if (e.key === 'Escape') { menu.hidden = true; return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit() }
  })
}

/* ---------- references to canvas items ---------- */
export function addRef(S: Session, r: Ref) {
  if (!S.refs.some(x => x.el === r.el)) S.refs.push(r)
  // dashed arrow card -> item while attached; stays once sent. Things that aren't on the canvas (a GitHub pull
  // request) are detached elements: no arrow, and clicking their chip runs their own onclick (opens them).
  if (r.el.isConnected) { link(S, r.el, 'ref'); ping(r.el) }
  drawChips(S)
  S.ta.focus()
}

/** A reference chip: click to fly to the item; with `remove`, an × to detach it. */
export function chip(r: Ref, remove?: () => void) {
  const c = make('span', 'chip'), label = make('button', '', `${refIcon(r.kind)} ${r.label}`)
  c.dataset.kind = r.kind
  label.type = 'button'
  label.title = `Show on canvas: ${r.label}`
  label.onclick = () => (!r.el.isConnected ? r.el.click() : onCanvas(r.el) ? centerOn(r.el) : r.el.scrollIntoView({ block: 'nearest' }))
  c.append(label)
  if (remove) {
    const x = make('button', 'x', '×')
    x.type = 'button'
    x.title = 'Remove reference'
    x.setAttribute('aria-label', `Remove reference ${r.label}`)
    x.onclick = remove
    c.append(x)
  }
  return c
}

function drawChips(S: Session) {
  S.chips.hidden = !S.refs.length && !S.images.length
  S.chips.replaceChildren(
    ...S.images.map(img => thumb(img, () => { S.images.splice(S.images.indexOf(img), 1); drawChips(S) })),
    ...S.refs.map(r => chip(r, () => {
      S.refs.splice(S.refs.indexOf(r), 1)
      if (!S.sentRefs.has(r.el)) unlink(S, r.el, 'ref') // never sent: the reference link goes too
      drawChips(S)
    })))
}

// A file dropped anywhere but the message box shouldn't make the browser open it and leave the app.
for (const t of ['dragover', 'drop']) addEventListener(t, e => { if ((e as DragEvent).dataTransfer?.types.includes('Files')) e.preventDefault() })

// Drop a referable item onto a card's message box to reference it in the next message.
// (Only the message box: moving windows around over a card shouldn't attach them.)
let hovered: HTMLElement | null = null
onDrop((el, x, y, final) => {
  const r = refOf(el)
  const zone = r ? document.elementsFromPoint(x, y).map(e => e.closest<HTMLElement>('.card .dock')).find(Boolean) ?? null : null
  const card = zone?.closest<HTMLElement>('.card') ?? null
  if (hovered !== card) { hovered?.classList.remove('droptarget'); card?.classList.add('droptarget'); hovered = card }
  if (!final || !card || !r) return !!card
  hovered = null
  card.classList.remove('droptarget')
  const S = cards.find(s => s.card === card)
  if (S) { addRef(S, r); focus(S) }
  return true
})
