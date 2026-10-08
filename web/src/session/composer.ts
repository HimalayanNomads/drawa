// A card's message box: the textarea with send / stop, the "/" (skills, commands) and "@" (canvas items) menu,
// and the chips for canvas items attached to the next message (typed with @ or dropped on the box).
import { make, ICON, ping, toast } from '../lib/dom'
import { api, post, q as enc } from '../lib/api'
import { centerOn, onDrop, onCanvas } from '../canvas/canvas'
import { link, unlink, onForget } from '../canvas/graph'
import { canvasRefs, refOf, refIcon, isPicture, type Ref } from '../canvas/refs'
import { cards, focus, meta, clearSession, renderCard, type Session } from './session'
import { send } from './live'
import { readImages, thumb, type Pasted } from './images'
import { textRefs } from './uploads'
import { runShell } from './shell'
import { modePicker } from './mode'
import { modelPicker, effortPicker, effortNote, infoBadge } from './gen'
import { recall } from './recall'
import { who, metaNow, textOnly } from '../lib/agents'
import { enhance } from '../lib/select'
import { isSend, sendCombo, onSendKey } from '../lib/sendkey'
import { command } from '../lib/keys'
import { saveSoon } from '../lib/store'
import { keepImages } from './drafts'

command({ label: 'Send (set in Settings)', group: 'Message box', keys: ['Enter', 'Ctrl+Enter'], tip: '`Enter` or `Ctrl+Enter` sends a message: pick which in Settings (the gear)' })
command({ label: 'New line', group: 'Message box', keys: ['Shift+Enter'] })
command({ label: 'Earlier messages', group: 'Message box', keys: ['↑↓'] })
command({ label: 'Leave the box', group: 'Message box', keys: ['Esc'] })
command({ label: 'Skills and commands', group: 'Message box', keys: ['/'] })
command({ label: 'Mention a canvas item or file', group: 'Message box', keys: ['@'] })
command({ label: 'Run a shell command', group: 'Message box', keys: ['!'] })

/** Build the composer at the bottom of the card's body and hook it to the session. */
export function composer(S: Session, body: HTMLElement) {
  const chips = make('div', 'refs'), form = make('form', 'compose'), ta = make('textarea')
  const stopBtn = make('button', 'send stop'), sendBtn = make('button', 'send')
  ta.rows = 1
  ta.setAttribute('aria-label', `Message ${who(S.backend)}`)
  stopBtn.type = 'button'
  stopBtn.innerHTML = ICON.stop
  stopBtn.setAttribute('aria-label', 'Stop')
  sendBtn.type = 'submit'
  sendBtn.innerHTML = ICON.up
  sendBtn.setAttribute('aria-label', 'Send')
  const modelSel = modelPicker(S), effortSel = effortPicker(S), pick = modePicker(S)
  const gen = make('div', 'gensel') // model + effort, then the status line (text and rings together) below them
  gen.append(modelSel, effortSel)
  const note = effortNote(S)
  if (note) gen.append(note)
  gen.append(infoBadge(S))
  form.append(ta, pick, stopBtn, sendBtn)
  chips.hidden = true
  const dock = make('div', 'dock') // the card's footer: attached references above a clearly bordered message field
  const label = () => { sendBtn.title = `Send (${sendCombo()})` } // the placeholder says it too (renderCard)
  label()
  onSendKey(label) // ponytail: never unregistered; a closed card's closure is tiny, add an off() if cards churn by thousands
  dock.append(chips, gen, form)
  body.append(dock)
  for (const sel of [modelSel, effortSel, pick]) enhance(sel) // the custom dropdowns, once they're in the page
  form.onclick = e => { if (e.target === form) ta.focus() } // the whole field is the click target
  Object.assign(S, { ta, stopBtn, chips })

  // a turn is interrupted; background agents alone can only be stopped by closing the process (the next message resumes it)
  // "stopping" lasts until the card goes quiet (renderCard clears it); a failed request says so and allows a retry
  stopBtn.onclick = () => {
    if (stopBtn.dataset.state) return
    stopBtn.dataset.state = S.pending ? 'stopping' : 'closing' // a turn, or (none running) the background agents
    renderCard(S)
    post(S.pending ? 'interrupt' : 'close', { cid: S.cid }).catch(e => {
      delete stopBtn.dataset.state
      renderCard(S)
      toast(`Could not stop ${who(S.backend)}: ${(e as Error).message}`)
    })
  }
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
    send(S, p || (images.length && !refs.length ? 'Take a look at this.' : 'Take a look at these.'), undefined, refs, images).then(ok => {
      if (ok || ta.value || S.refs.length || S.images.length) return // sent, or you've started the next one: keep that
      putBack(S, p, refs, images) // not sent: put it back to try again
    })
  }
  // images: paste them (Ctrl+V) or drop image files on the message box. Each gets a "[ImageN]" marker inserted at
  // the cursor, like Claude Code's terminal, so a message can say which one it means ("what's wrong in [Image2]").
  const attach = async (files: File[]) => {
    if (textOnly(S.backend)) { noImages(S); return }
    const got = await readImages(files)
    if (!got.length) return
    const at = S.images.length
    S.images.push(...got)
    const marks = got.map((_, i) => `[Image${at + i + 1}]`).join(' ') + ' '
    ta.setRangeText(marks, ta.selectionStart, ta.selectionEnd, 'end')
    drawChips(S)
    fit()
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
  const fit = () => fitBox(ta)
  ta.oninput = () => { fit(); saveSoon() } // the draft is saved with the layout (drafts.ts)
  commandMenu(S, form)
  // after the menu's handler: when the "/" or "@" menu is open, it takes Up/Down (and prevents the default)
  const step = recall(ta, S.log)
  ta.addEventListener('keydown', e => {
    if (!e.defaultPrevented && step(e)) { e.preventDefault(); fit() }
  })
}

function fitBox(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 'px'
  ta.style.overflowY = ta.scrollHeight > 180 ? 'auto' : 'hidden' // scroll only past the max height
  ta.form?.classList.toggle('shell', ta.value.startsWith('!')) // shell mode: amber field, $ prompt
}

/* ---------- "/" menu: skills and slash commands; "@" menu: canvas items ---------- */
let menus = 0 // numbers each card's menu, so its rows' ids are unique on the page
function commandMenu(S: Session, form: HTMLFormElement) {
  const menu = make('div', 'cmds')
  menu.setAttribute('role', 'listbox')
  menu.id = `cmds-${++menus}`
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
      items = !S.ta.value.startsWith('/') || S.ta.value.includes(' ') ? [] : (S.backend === 'claude' ? meta.commands : metaNow(S.backend).commands)
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
    if (menu.hidden) S.ta.removeAttribute('aria-activedescendant')
    else S.ta.setAttribute('aria-activedescendant', `${menu.id}-${sel}`)
    menu.replaceChildren(...items.map((c, i) => {
      const o = make('button', 'cmd' + (i === sel ? ' on' : ''))
      o.type = 'button'
      o.id = `${menu.id}-${i}`
      o.tabIndex = -1
      o.setAttribute('role', 'option')
      o.setAttribute('aria-selected', String(i === sel))
      o.append(make('b', '', c.title), make('span', '', c.sub))
      o.onmousedown = e => { e.preventDefault(); pick(i) }
      return o
    }))
    menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }
  S.ta.addEventListener('input', () => { sel = 0; draw() })
  S.ta.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; S.ta.removeAttribute('aria-activedescendant') }, 100))
  S.ta.addEventListener('keydown', e => {
    if (!menu.hidden && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; draw(); return }
      // only plain Enter/Tab pick: Ctrl/Cmd+Enter always sends, and an IME's Enter confirms its own text
      const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing
      if (plain && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); pick(sel); return }
      if (e.key === 'Escape') { e.preventDefault(); menu.hidden = true; S.ta.removeAttribute('aria-activedescendant'); return }
    }
    // the send key is a setting (lib/sendkey.ts); anything else on Enter is a new line. Esc leaves the box so
    // single-key shortcuts work again
    if (isSend(e)) { e.preventDefault(); form.requestSubmit() }
    else if (e.key === 'Escape') S.ta.blur()
  })
}

/* ---------- references to canvas items ---------- */
const noImages = (S: Session) => toast(`Images aren't supported in ${who(S.backend)}: it takes text only.`)

export function addRef(S: Session, r: Ref) {
  if (textOnly(S.backend) && isPicture(r.kind)) { noImages(S); return } // @ or dropped on it: refused like a pasted one
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

/** Puts a message back in the box (not sent, taken back to edit, or restored as a draft), after whatever you've typed since. */
export function putBack(S: Session, p: string, refs: Ref[], images: Pasted[], focus = true) {
  S.ta.value = S.ta.value && p ? S.ta.value + '\n' + p : S.ta.value || p
  S.refs.push(...refs.filter(r => !S.refs.some(x => x.el === r.el)))
  for (const r of refs) if (r.el.isConnected) link(S, r.el, 'ref') // (a restored draft's arrows)
  S.images.push(...images)
  drawChips(S)
  fitBox(S.ta)
  if (focus) S.ta.focus()
}

/** Take picture n (1-based) off the message: its [ImageN] marker goes, and later ones move down to keep pointing at theirs. */
function dropImage(S: Session, n: number) {
  S.images.splice(n - 1, 1)
  S.ta.value = S.ta.value.replace(new RegExp(`\\[Image${n}\\] ?`, 'g'), '').replace(/\[Image(\d+)\]/g, (m, d) => (+d > n ? `[Image${+d - 1}]` : m))
  fitBox(S.ta)
  drawChips(S)
}

function drawChips(S: Session) {
  saveSoon()
  keepImages(S)
  S.chips.hidden = !S.refs.length && !S.images.length
  S.chips.replaceChildren(
    ...S.images.map((img, i) => thumb(img, () => dropImage(S, i + 1))),
    ...S.refs.map(r => chip(r, () => {
      S.refs.splice(S.refs.indexOf(r), 1)
      if (!S.sentRefs.has(r.el)) unlink(S, r.el, 'ref') // never sent: the reference link goes too
      drawChips(S)
    })))
}

// An item deleted from the canvas can't be sent any more: its chip goes (sending would pass its last content)
onForget(el => {
  for (const S of cards) {
    const i = S.refs.findIndex(r => r.el === el)
    if (i >= 0) { S.refs.splice(i, 1); drawChips(S) }
  }
})

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
