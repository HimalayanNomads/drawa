// Editing a file window's file in place: the pencil swaps the highlighted view for an editor (lib/codeedit.ts,
// loaded on first use), Ctrl+S or Vim's :w saves it, the pencil again (or :q) goes back to the view. A save only
// goes through while the file on disk is still what the editor started from (POST /api/file), so it never throws
// away someone else's change. Vim motions are a setting (`vim` in your settings file), off until you turn it on.
// ponytail: an unsaved draft isn't kept through a reload (the page asks before leaving instead); keep drafts in
// the layout if that ever bites.
import { api, post, q } from '../lib/api'
import { $, make, toast, confirmBox, pressed } from '../lib/dom'
import { segmented } from '../lib/select'
import { prefs, setPrefs, onPrefs } from '../lib/prefs'
import { command } from '../lib/keys'
import { onForget } from '../canvas/graph'
import { onGone, parked } from '../canvas/canvas'
import { saved as shown } from '../panels/files'
import type { Editor } from '../lib/codeedit'

interface Edit { editor: Editor; base: string; saving?: Promise<boolean>; quit(force?: boolean): Promise<void>; close(): void }
interface File { text: string | null; noEdit?: string }
const edits = new Map<HTMLElement, Edit>(), opening = new WeakSet<HTMLElement>()
/** The editor holds the window's content box, or is about to: the file view must not be drawn into it. */
export const editing = (el: HTMLElement) => edits.has(el) || opening.has(el)
/** What the window's editor holds now, for its copy button; undefined when it isn't being edited. */
export const draft = (el: HTMLElement) => edits.get(el)?.editor.text()
/** Put the editor's cursor on `line` (Ctrl+K opening a code symbol in a window being edited). */
export const editAt = (el: HTMLElement, line: number) => edits.get(el)?.editor.goto(line)
/** Put the keys in the window's editor (Edit again on a file already being edited). */
export const editFocus = (el: HTMLElement) => edits.get(el)?.editor.focus()
const read = (path: string) => api<File>('file?path=' + q(path))

/** Edit `path` in `host` (the window `el`'s content box), or stop editing if it already is. `done` shows the file
 *  again; `button` is the pencil, shown pressed while editing. */
export async function toggleEdit(el: HTMLElement, host: HTMLElement, path: string, button: HTMLElement, done: () => void) {
  const open = edits.get(el)
  if (open) return open.quit()
  if (opening.has(el)) return // a second click while the editor loads
  opening.add(el)
  try { await start(el, host, path, button, done) } finally { opening.delete(el) }
}

async function start(el: HTMLElement, host: HTMLElement, path: string, button: HTMLElement, done: () => void) {
  let file: File
  try { file = await read(path) }
  catch (e) { return toast(`Couldn't read ${path}: ${(e as Error).message}`) }
  const base = file.text
  if (base == null) return toast(`${path} isn't a text file.`)
  if (file.noEdit) return toast(`${path} can't be edited here: ${file.noEdit}.`)
  const box = make('div', 'pvnode-ed')
  let editor: Editor
  try {
    const { codeEditor } = await import('../lib/codeedit')
    if (!el.isConnected) return // removed while loading
    for (const c of [...host.children]) if (!c.matches('svg.ink-local')) c.remove()
    host.prepend(box)
    editor = await codeEditor(box, {
      path, text: base, vim: prefs().vim === 'on',
      save: () => save(e, path),
      quit: force => void e.quit(force),
    })
  } catch (err) {
    toast(`Couldn't open the editor: ${(err as Error).message}`)
    opening.delete(el)
    return done() // the file view again, if the box was cleared
  }
  if (!el.isConnected) { // removed while the language loaded: onForget has been and gone, so don't start
    editor.destroy()
    opening.delete(el)
    return done()
  }
  const e: Edit = {
    base, editor,
    async quit(force) {
      if (force || !e.editor.dirty() || await confirmBox('Discard your changes?', `${path} has changes you haven't saved.`, 'Discard')) e.close()
    },
    close() {
      edits.delete(el)
      e.editor.destroy()
      delete el.dataset.state
      pressed(button, false)
      done()
    },
  }
  edits.set(el, e)
  el.dataset.state = 'editing' // canvas_update leaves the window alone while you edit
  pressed(button, true)
  e.editor.focus()
}

/** Save what the editor holds now; true once it's on disk. A save asked for while one is on its way waits for it,
 *  then saves what's there by then (each save needs the text the one before it wrote). */
async function save(e: Edit, path: string): Promise<boolean> {
  while (e.saving) await e.saving
  if (!e.editor.dirty()) return true
  const p = e.saving = write(e, path)
  try { return await p } finally { e.saving = undefined }
}

async function write(e: Edit, path: string) {
  const { text, done } = e.editor.take()
  const saved = () => { e.base = text; done(); toast(`Saved ${path}`); shown(path); return true }
  try {
    await post('file', { path, base: e.base, text })
    return saved()
  } catch (err) {
    // the answer may have been lost after the file was written: if the disk holds what was sent, it was saved
    const disk = await read(path).then(f => f.text, () => null)
    if (disk === text) return saved()
    toast((err as { status?: number }).status === 409
      ? `${path} changed on disk since you opened it, so it wasn't saved. Copy your changes, then stop editing to read it again.`
      : `Couldn't save ${path}: ${(err as Error).message}`)
    return false
  }
}

onPrefs(p => { for (const e of edits.values()) e.editor.setVim(p.vim === 'on') })
// × parks the window while its Undo shows: the editor stays as it is, unsaved changes included, and goes only once
// the window is gone for good (onGone). Any other removal closes it now.
onForget(el => queueMicrotask(() => { if (!el.isConnected && !parked(el)) edits.get(el)?.close() }))
onGone(el => edits.get(el)?.close())
addEventListener('beforeunload', ev => { if ([...edits.values()].some(e => e.editor.dirty())) ev.preventDefault() })

command({ label: 'Save the file you’re editing (or :w with Vim motions on)', group: 'Windows', keys: ['Ctrl+S'] })

// the Settings panel's control
const sel = $<HTMLSelectElement>('#vim')
sel.replaceChildren(...([['off', 'Plain'], ['on', 'Vim']] as const)
  .map(([value, textContent]) => Object.assign(document.createElement('option'), { value, textContent })))
sel.onchange = () => setPrefs({ vim: sel.value === 'on' ? 'on' : 'off' })
segmented(sel)
const sync = () => { sel.value = prefs().vim }
onPrefs(sync)
sync()
