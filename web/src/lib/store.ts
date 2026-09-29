// The canvas survives a reload (per project folder, this browser only). Each feature registers the slice it owns;
// save() gathers them all into one localStorage entry, restore() hands each slice back to its owner.
import { project, notice, toast, button, iconButton, ICON } from './dom'
import { saving, markStale, onOwner } from './tabs'
import { getBlob, putBlob } from './blobs'

interface Part { save: () => unknown; load?: (value: any, all: Record<string, any>) => unknown; phase: number }
const parts = new Map<string, Part>()

/** Own a key of the saved layout. `phase` orders restoring: 0 settings, 1 canvas items, 2 things that attach to items (ink). */
export function persist<T>(key: string, save: () => T, load?: (value: T, all: Record<string, any>) => unknown, phase = 1) {
  parts.set(key, { save, load, phase })
}

const KEY = () => 'drawa:canvas:' + project.root

let ready = false, restoring = false // saving before or during restore would drop whatever isn't loaded yet
let held = false // the saved layout couldn't be read: saving would replace it with an empty one, so wait for the user
const cache = new Map<string, string | undefined>() // each slice's JSON as last saved (and slices nobody here owns)
// slices whose loader failed: their saved JSON is written back as it was until the owner's state changes
const broken = new Map<string, { raw: string; base?: string }>()
let written = ''
/** Save the layout. `only`: just these slices changed (e.g. a pan: the view); the rest are reused from last time. */
export function save(slices?: string[] | Event) {
  if (!ready || restoring || held || !saving()) return
  const only = Array.isArray(slices) ? slices : undefined // also used as an event handler (onchange = save)
  for (const [k, p] of parts) if (!only || only.includes(k) || !cache.has(k)) cache.set(k, slice(k, p))
  const json = `{${[...cache].filter(([, j]) => j !== undefined).map(([k, j]) => `${JSON.stringify(k)}:${j}`).join(',')}}`
  if (json === written) return // nothing changed (a pan that came back, a click)
  try { localStorage.setItem(KEY(), json); written = json; full.hidden = true }
  catch (e) { // full (or storage blocked): every later save fails too, so this stays up until one works
    full.firstChild!.textContent = (e as Error).name === 'QuotaExceededError'
      ? 'The canvas isn’t being saved: this browser’s storage for Drawa is full (every project shares about 5 MB). Remove big snippets, scratchpads or notes to make room.'
      : `The canvas isn’t being saved: this browser won’t let Drawa store it (${(e as Error).name}).`
    full.hidden = false
  }
}
const full = notice('')
full.hidden = true
function slice(k: string, p: Part) {
  const j = JSON.stringify(p.save()), b = broken.get(k)
  if (!b) return j
  b.base ??= j // what the owner holds right after the failed restore
  if (j === b.base) return b.raw
  broken.delete(k) // the owner has new state: it wins (the old JSON is in the backup)
  return j
}
let timer = 0, all = false
/** Save shortly (debounced). `viewOnly`: only the pan/zoom changed, so only the view slice is re-serialized
 *  (ink points, snippets and cards can be big: no need to stringify them on every pan). */
export const saveSoon = (viewOnly = false) => {
  all ||= !viewOnly
  clearTimeout(timer)
  timer = setTimeout(flush, 400)
}
function flush() { timer = 0; const f = all; all = false; save(f ? undefined : ['view']) }
// a reload or close inside the 400ms would drop the last pan/zoom (or move)
addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); flush() } })

// Two tabs on one project: only the one that owns this server saves (lib/tabs.ts). Another tab's save makes this
// tab's copy out of date; taking over saves what changed here meanwhile.
addEventListener('storage', e => {
  if (e.storageArea === localStorage && e.key === KEY() && project.root && e.newValue !== written) markStale()
})
onOwner(on => { if (on) saveSoon() })

/* ---------- a layout that doesn't load ---------- */
// Each load that restores cleanly keeps a copy of the layout in IndexedDB (the last few different ones), so a layout
// that later fails to load can go back to one that worked. IndexedDB, not localStorage: its room is far bigger, and
// a copy here would eat into the ~5MB every project shares.
const SLOTS = 3
const slot = (i: number) => `drawa:layout:${project.root}:${i}`
async function backups() {
  const all = await Promise.all([...Array(SLOTS).keys()].map(i => getBlob(slot(i)).catch(() => undefined)))
  return all.map((f, i) => ({ i, f: f as File | undefined })).sort((a, b) => (b.f?.lastModified ?? 0) - (a.f?.lastModified ?? 0))
}
async function keep(raw: string) {
  const list = await backups()
  if (raw === '{}' || await list[0].f?.text() === raw) return
  await putBlob(slot(list[list.length - 1].i), new File([raw], 'layout', { lastModified: Date.now() }))
}
/** The newest kept layout that isn't `raw` (what failed to load). */
async function previous(raw: string) {
  for (const { f } of await backups()) if (f && await f.text() !== raw) return f
}

let current = '', failed = false, problem: HTMLElement | undefined
/** The saved layout (all of it, or a slice: `whole`) didn't load: say so once, and offer the last one that did. */
function fail(raw: string, whole = false) {
  if (problem) return
  held = whole
  const fresh = button('Start fresh', '', () => { held = false; problem!.remove(); save() })
  problem = whole ? notice('The saved canvas couldn’t be read, so this one starts empty. It isn’t saved over until you choose.', fresh)
    : notice('Part of the saved canvas couldn’t be restored. It’s kept as saved.', iconButton(ICON.x, 'Dismiss', () => problem!.remove()))
  putBlob(`drawa:broken:${project.root}`, new File([raw], 'layout')).catch(() => {}) // for rescuing it by hand
  previous(raw).then(f => {
    if (!f) return
    problem!.insertBefore(button('Restore previous canvas', '', async () => {
      held = true // the page is going: don't save this one over it on the way out
      try { localStorage.setItem(KEY(), await f.text()) } catch (e) { held = whole; return toast(`Couldn’t restore it: ${(e as Error).name}`) }
      location.reload()
    }), problem!.children[1])
    problem!.firstChild!.textContent += ` The canvas from ${new Date(f.lastModified).toLocaleString()} can be restored.`
  }).catch(() => {})
}
/** For loaders: run `f` on each saved entry, so one bad entry doesn't stop the rest (and its slice is kept as saved). */
export function each<T>(list: T[] | undefined, f: (x: T) => unknown) {
  if (!Array.isArray(list)) { if (list != null && restoring) failed = true; return }
  for (const x of list) {
    try { f(x) } catch (e) { console.error(`restoring ${current}:`, e); if (restoring) failed = true }
  }
}

/** Load every slice that was saved, phase by phase (a slice's loader may be async: the next one waits for it). */
export async function restore() {
  let all: Record<string, any> = {}
  const raw = localStorage.getItem(KEY()) ?? '{}'
  try { all = JSON.parse(raw) ?? {} } catch (e) { console.error('restoring the canvas:', e); fail(raw, true) }
  written = raw
  restoring = true
  try {
    for (const [k, v] of Object.entries(all)) if (!parts.has(k)) cache.set(k, JSON.stringify(v)) // no owner here (another version's): keep it
    for (const [key, p] of [...parts].sort((a, b) => a[1].phase - b[1].phase)) {
      if (all[key] === undefined || !p.load) continue
      current = key
      failed = false
      try { await p.load(all[key], all) } catch (e) { console.error(`restoring ${key}:`, e); failed = true }
      if (failed) { broken.set(key, { raw: JSON.stringify(all[key]) }); fail(raw) }
    }
  } finally { restoring = false; ready = true }
  if (!problem) keep(raw).catch(() => {})
  save()
  return all
}
