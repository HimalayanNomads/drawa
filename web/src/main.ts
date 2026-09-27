// Boot: wire the toolbar and panels, restore the canvas, load history + files.
// Features register themselves on import (saved-layout slices, referable kinds); the imports below are the app.
import './lib/fonts' // applies the saved font choice right away
import './lib/theme'
import './lib/tooltip' // the app's own tooltips for every title="…"
import './lib/update' // checks GitHub for a newer release and offers to install it
import { api } from './lib/api'
import { $, project, shortcutOk } from './lib/dom'
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
import './canvas/find'
import { openGit } from './items/git'
import { openGitHub } from './items/github'
import { tree, closeInspector, showTab } from './panels/files'
import { cards, cur, newSession, meta, cycleCards } from './session/session'
import { attach } from './session/live'
import { refreshModels, seedInfo } from './session/gen'
import { loadSessions } from './session/history'

const drawer = $('#drawer'), inspector = $('#inspector'), drawerBtn = $('#btn-drawer')
const toggleDrawer = (open = drawer.hidden) => { drawer.hidden = !open; drawerBtn.setAttribute('aria-expanded', String(open)) }

$('#btn-new').onclick = () => newSession()
$('#btn-scratch').onclick = () => doc({ edit: true })
$('#btn-git').onclick = () => openGit()
drawerBtn.onclick = () => toggleDrawer()
$('#dclose').onclick = () => toggleDrawer(false)
$('#iclose').onclick = closeInspector
$('#refresh').onclick = () => { tree(); loadSessions() }
for (const b of document.querySelectorAll<HTMLElement>('[data-l]')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('[data-l]')) o.classList.toggle('on', o === b)
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
addEventListener('pointerdown', e => { lastDown = e.target }, true)
// Single-key shortcuts, only when not typing.
addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!inspector.hidden) closeInspector()
    else if (!drawer.hidden) toggleDrawer(false)
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey || !shortcutOk(e)) return
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
    else if (c === 'Digit2') { const s = selected(); fit(true, s.length ? s.map(rect) : undefined) } // zoom to selection
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
