// Boot: wire the toolbar and panels, restore the canvas, load history + files.
// Features register themselves on import (saved-layout slices, referable kinds); the imports below are the app.
import './lib/fonts' // applies the saved font choice right away
import './lib/theme'
import './lib/uimode' // full or minimal interface, from your settings file (lib/prefs.ts)
import './lib/settings' // the toolbar's Settings panel
import './lib/tooltip' // the app's own tooltips for every title="…"
import './lib/update' // checks GitHub for a newer release and offers to install it
import { api } from './lib/api'
import { $, make, ICON, project, shortcutOk, pressed } from './lib/dom'
import { command } from './lib/keys'
import { showHelp, showTip } from './lib/help'
import { persist, restore, saveSoon } from './lib/store'
import { onReconnect } from './lib/connection'
import { apply, fit, zoomAt, onChange, stage, edgeGrip, rect, view as camera } from './canvas/canvas'
import { redraw } from './canvas/graph'
import { anyFull } from './canvas/fullview'
import './canvas/nav' // pan, wheel, minimap, zoom buttons
import './canvas/shapes' // moving and resizing drawn shapes in Select mode
import { setDrawing, drawing, useTool, toolKey } from './canvas/ink'
import { setMode } from './canvas/mode'
import { selected } from './canvas/select' // also Ctrl/Cmd+A, Delete, arrow-key nudges
import { addImage } from './items/image'
import { noteHere } from './items/notes'
import { doc } from './items/doc'
import './items/sketch' // whiteboards you already have still load (new ones: the Scratchpad replaced it)
import './items/diagram'
import './items/plan'
import './items/snippet'
import './items/image'
import './items/agent'
import './items/group' // Ctrl+G groups the selected windows into a frame
import './items/preview' // Ctrl+K opens project files in windows
import './canvas/find'
import './canvas/winkeys' // W steps through windows, M collapses, Shift+F full view...
import { openGit } from './items/git'
import { openGitHub } from './items/github'
import { tree, closeInspector, showTab } from './panels/files'
import { cards, cur, newSession, meta, cycleCards } from './session/session'
import { attach } from './session/live'
import { refreshModels, seedInfo } from './session/gen'
import { loadSessions } from './session/history'
import { agentsReady, installed, lastAgent, setLastAgent, title, blurb, chooser } from './lib/agents'

const drawer = $('#drawer'), inspector = $('#inspector'), drawerBtn = $('#btn-drawer')
const toggleDrawer = (open = drawer.hidden) => { drawer.hidden = !open; drawerBtn.setAttribute('aria-expanded', String(open)) }

$('#btn-new').onclick = () => newSession()

// Phones: the toolbar's tail folds into a ⋯ menu rather than scrolling off the edge. The wrapper is display:contents
// on wider screens (chrome.css), so the buttons sit in the bar as before.
const more = make('button', 'btn'), tail = make('div')
more.id = 'btn-more'
tail.id = 'bar-more'
more.innerHTML = ICON.more
more.title = 'More'
more.setAttribute('aria-label', 'More')
more.setAttribute('aria-controls', 'bar-more')
const showMore = (open: boolean) => { tail.classList.toggle('open', open); more.setAttribute('aria-expanded', String(open)) }
showMore(false)
tail.append(...['#btn-scratch', '#btn-git', '#btn-drawer', '#btn-theme', '#btn-settings'].map(s => $(s)))
$('#bar').append(more, tail)
more.onclick = () => showMore(!tail.classList.contains('open'))
tail.addEventListener('click', () => showMore(false)) // picking one closes the menu
addEventListener('pointerdown', e => { if (!more.contains(e.target as Node) && !tail.contains(e.target as Node)) showMore(false) })

/** New session ▾: which agent a new card runs. The button itself (and N) starts the last one picked; with only one
 *  agent installed there's nothing to pick, so no chevron. */
function newSessionMenu() {
  const list = installed(), btn = $('#btn-new')
  if (list.length < 2) return
  const label = () => { btn.title = `New ${title(lastAgent())} session (N)`; btn.setAttribute('aria-label', btn.title) }
  const menu = chooser('Agent for a new session', list.map(a => ({ value: a.name, text: a.title, desc: blurb(a.name) })), lastAgent(),
    v => { setLastAgent(v); label(); newSession({ backend: v }) }, true)
  menu.classList.add('newagent')
  btn.after(menu)
  label()
}
$('#btn-scratch').onclick = () => doc({ edit: true })
$('#btn-git').onclick = () => openGit()
drawerBtn.onclick = () => toggleDrawer()
$('#dclose').onclick = () => toggleDrawer(false)
$('#iclose').onclick = closeInspector
$('#refresh').onclick = () => { tree(); loadSessions() }
for (const b of document.querySelectorAll('.seg [data-l], .seg [data-r]')) pressed(b, b.classList.contains('on'))
for (const b of document.querySelectorAll<HTMLElement>('.seg [data-l]')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('.seg [data-l]')) pressed(o, o === b)
    $('#tree').hidden = b.dataset.l !== 'tree'
    $('#sessions').hidden = b.dataset.l !== 'sessions'
  }
}
for (const b of document.querySelectorAll<HTMLElement>('[data-r]')) b.onclick = () => showTab(b.dataset.r as 'changes' | 'viewer')

persist('view', () => ({ ...camera }), v => { Object.assign(camera, v) }, 0)

// Inspector: drag its left edge to widen it.
edgeGrip(inspector, 360)

const PAN: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
const ZOOM: Record<string, number> = { '+': 1.25, '=': 1.25, '-': 1 / 1.25 }
let lastDown: EventTarget | null = null
// what the handler below answers to, for the ? sheet, Ctrl+K and the launch tips (lib/keys.ts)
const fitSelection = () => { const s = selected(); fit(true, s.length ? s.map(rect) : undefined) }
for (const c of [
  { label: 'Pan (Shift: farther)', keys: ['←→↑↓'], tip: 'Arrow keys pan the canvas; hold `Shift` to go farther' },
  { label: 'Zoom in / out', keys: ['+', '-'] },
  { label: 'Fit everything', keys: ['F', 'Shift+1'], run: () => fit(), tip: '`F` fits everything on screen; `Shift+2` zooms to the selection' },
  { label: 'Zoom to selection', keys: ['Shift+2'], run: fitSelection },
  { label: 'Zoom to 100%', keys: ['Shift+0'], run: () => zoomAt(1, undefined, undefined, true) },
  { label: 'Select mode', keys: ['V', '1'], run: () => setMode('select') },
  { label: 'Hand mode (or hold Space)', keys: ['H'], run: () => setMode('hand'), tip: 'Hold `Space` and drag to pan from any mode' },
]) command({ ...c, group: 'Canvas' })
for (const c of [
  { label: 'New session', keys: ['N'], run: () => newSession() },
  { label: 'Next / previous session', keys: ['C', 'Shift+C'], tip: '`C` steps through your sessions; `Enter` starts typing in one' },
  { label: 'Type in the focused session', keys: ['Enter'] },
  { label: 'Sticky note', keys: ['T'], run: noteHere, tip: '`T` drops a sticky note in the middle of the view' },
  { label: 'Scratchpad', keys: ['S'], run: () => doc({ edit: true }), tip: '`S` opens a scratchpad for Markdown, code and diagrams' },
  { label: 'Insert picture', keys: ['9'], run: () => pickImage.click() },
  { label: 'Git', keys: ['G'], run: () => openGit(), tip: '`G` opens Git: changes, commit and push' },
  { label: 'GitHub', keys: ['Shift+G'], run: () => openGitHub() },
  { label: 'History & files', keys: ['Shift+H'], run: () => toggleDrawer(), tip: '`Shift+H` opens past sessions and the project files' },
]) command({ ...c, group: 'Items' })
command({ label: 'Draw mode', group: 'Draw', keys: ['D'], run: () => setDrawing(!drawing), tip: '`D` draws on the canvas; `A` draws an arrow between two items' })
addEventListener('pointerdown', e => { lastDown = e.target }, true)
// Single-key shortcuts, only when not typing.
addEventListener('keydown', e => {
  // Esc backs out one layer: this runs after every other handler, so anything nearer (a field, menu, dialog, Draw
  // mode, full view, the selection) takes it first and calls preventDefault
  if (e.key === 'Escape') {
    if (e.defaultPrevented || !shortcutOk(e)) return
    if (tail.classList.contains('open')) { e.preventDefault(); showMore(false); more.focus() }
    else if (!inspector.hidden) { e.preventDefault(); closeInspector() }
    else if (!drawer.hidden) { e.preventDefault(); toggleDrawer(false) }
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey || !shortcutOk(e)) return
  if (e.key === '?') { e.preventDefault(); showHelp(); return }
  const k = e.key.toLowerCase(), c = e.code
  // arrows pan, unless something else took them (select.ts nudging a selection, a menu) or the last click was in a
  // window (its arrows scroll it) or a window is in full view; + / - zoom around the middle
  const pan = PAN[e.key]
  if (pan) {
    if (e.defaultPrevented || anyFull() || [e.target, lastDown].some(t => t instanceof Element && t.closest('.item, dialog'))) return
    e.preventDefault()
    const step = e.shiftKey ? 400 : 80
    camera.x -= pan[0] * step
    camera.y -= pan[1] * step
    return apply(!e.repeat) // a held key moves at once: a glide per repeat would lag behind
  }
  // not on the number row: Shift+0 types "=" on some layouts, "-" is Digit6 on AZERTY
  const zoom = !c.startsWith('Digit') && !anyFull() && ZOOM[e.key]
  if (zoom) return zoomAt(camera.k * zoom, undefined, undefined, true)
  // Excalidraw's keys where we have the tool; the number row by its physical key (Shift+1 types "!")
  if (e.shiftKey) {
    if (c === 'Digit1') fit()
    else if (c === 'Digit2') fitSelection()
    else if (c === 'Digit0') zoomAt(1, undefined, undefined, true)
    else if (k === 'g') openGitHub()
    else if (k === 'h') toggleDrawer()
    else if (k === 'c') cycleCards(-1)
    return
  }
  if (k === 'n') { e.preventDefault(); newSession() }
  else if (k === 'c') cycleCards(1) // step through the session cards
  else if (e.key === 'Enter' && cur && document.activeElement === document.body) { e.preventDefault(); cur.ta.focus() } // type in the focused card
  else if (k === 'd') setDrawing(!drawing)
  else if (drawing) return // in Draw mode, P/A/E/T and 7/5/0/8 pick its tools (canvas/ink.ts)
  else if (k === 'v' || c === 'Digit1') setMode('select')
  else if (k === 'h') setMode('hand')
  else if (k === 't') { e.preventDefault(); noteHere() }
  else if (toolKey(e)) useTool(toolKey(e)!) // the draw tools' keys switch Draw mode on with that tool
  else if (c === 'Digit9') pickImage.click()
  else if (k === 's') { e.preventDefault(); doc({ edit: true }) } // a scratchpad (T: a sticky note)
  else if (k === 'f') fit()
  else if (k === 'g') openGit()
})
// 9: insert a picture from a file (like Excalidraw's image tool), in the middle of the view
const pickImage = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true })
pickImage.onchange = () => { for (const f of pickImage.files ?? []) addImage(f, f.name).catch(console.warn); pickImage.value = '' }

// The hint teaches pan/zoom once, then gets out of the way.
const hint = $('#hint')
const dismiss = () => hint.classList.add('gone')
stage.addEventListener('wheel', dismiss, { once: true })
stage.addEventListener('pointerdown', e => { if (e.target === stage) dismiss() }, { once: true })
setTimeout(dismiss, 12000)

/* ---------- boot ---------- */
project.root = (await api<{ root: string }>('info')).root
project.name = project.root.split('/').pop() || project.root
document.title = `${project.name} · Drawa`
$('#pname').textContent = project.name
$('#ppath').textContent = project.root

// Models and skills / slash commands come from Claude itself (slow the first time: the server asks a fresh process).
api<typeof meta>('meta').then(m => {
  Object.assign(meta, m)
  refreshModels() // fills in every card's model picker, restored ones included
  for (const S of cards) seedInfo(S) // and every card's status line, if its own process hasn't reported yet
}).catch(() => {})

await agentsReady // which agents there are: cards restore with theirs, and the New session menu lists them
newSessionMenu()
await restore()
apply()
if (!cards.length) newSession()
document.fonts.ready.then(redraw) // card text reflow can shift edge anchors
onChange(saveSoon)
// server back after an outage (or a restart): pick the live streams and lists up again
onReconnect(() => { for (const S of cards) attach(S); tree(); loadSessions() })
tree()
loadSessions()
cur?.ta.focus({ preventScroll: true })
showTip()
