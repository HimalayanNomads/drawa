// The canvas survives a reload (per project folder, this browser only). Each feature registers the slice it owns;
// save() gathers them all into one localStorage entry, restore() hands each slice back to its owner.
import { project, toast, make, button } from './dom'

interface Part { save: () => unknown; load?: (value: any, all: Record<string, any>) => unknown; phase: number }
const parts = new Map<string, Part>()

/** Own a key of the saved layout. `phase` orders restoring: 0 settings, 1 canvas items, 2 things that attach to items (ink). */
export function persist<T>(key: string, save: () => T, load?: (value: T, all: Record<string, any>) => unknown, phase = 1) {
  parts.set(key, { save, load, phase })
}

const KEY = () => 'drawa:canvas:' + project.root

let warned = false
let restoring = false // saving half-restored state would drop whatever isn't loaded yet
let stale = false // another tab saved this layout since: saving from here would undo its changes
const cache = new Map<string, string | undefined>() // each slice's JSON as last saved (and slices nobody here owns)
// slices whose loader failed: their saved JSON is written back as it was until the owner's state changes
const broken = new Map<string, { raw: string; base?: string }>()
let written = ''
/** Save the layout. `only`: just these slices changed (e.g. a pan: the view); the rest are reused from last time. */
export function save(slices?: string[] | Event) {
  if (restoring || stale) return
  const only = Array.isArray(slices) ? slices : undefined // also used as an event handler (onchange = save)
  for (const [k, p] of parts) if (!only || only.includes(k) || !cache.has(k)) cache.set(k, slice(k, p))
  const json = `{${[...cache].filter(([, j]) => j !== undefined).map(([k, j]) => `${JSON.stringify(k)}:${j}`).join(',')}}`
  if (json === written) return // nothing changed (a pan that came back, a click)
  try { localStorage.setItem(KEY(), json); written = json; warned = false }
  catch (e) {
    // full (or storage blocked): the layout stops saving, so say it once instead of losing changes silently
    if (!warned) toast(`The canvas couldn't be saved in this browser (${(e as Error).name}). Remove big snippets or scratchpads to make room.`)
    warned = true
  }
}
function slice(k: string, p: Part) {
  const j = JSON.stringify(p.save()), b = broken.get(k)
  if (!b) return j
  b.base ??= j // what the owner holds right after the failed restore
  if (j === b.base) return b.raw
  broken.delete(k) // the owner has new state: it wins (the old JSON is in the backup)
  return j
}
let timer = 0, full = false
/** Save shortly (debounced). `viewOnly`: only the pan/zoom changed, so only the view slice is re-serialized
 *  (ink points, snippets and cards can be big: no need to stringify them on every pan). */
export const saveSoon = (viewOnly = false) => {
  full ||= !viewOnly
  clearTimeout(timer)
  timer = setTimeout(flush, 400)
}
function flush() { timer = 0; const f = full; full = false; save(f ? undefined : ['view']) }
// a reload or close inside the 400ms would drop the last pan/zoom (or move)
addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); flush() } })

// Two tabs on one project: the last one to save wins, and the other stops saving (it would undo those changes).
// ponytail: last writer wins; merge per slice if people really work in two tabs at once.
addEventListener('storage', e => {
  if (stale || e.storageArea !== localStorage || e.key !== KEY() || !project.root) return
  stale = true
  const hint = make('p', 'float toast elsewhere')
  hint.setAttribute('role', 'status')
  hint.append(make('span', '', 'The canvas was changed in another tab. Changes here are no longer saved.'), button('Reload', '', () => location.reload()))
  document.body.append(hint)
})

let current = '', failed = false, backedUp = false
/** A slice failed to load: back the whole saved layout up once, and say so once. */
function fail(raw: string) {
  if (backedUp) return
  backedUp = true
  try { localStorage.setItem(KEY() + ':bak', raw) } catch {}
  toast(`Part of the saved canvas could not be restored. It is kept as saved, with a copy in ${KEY()}:bak.`)
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
  try { all = JSON.parse(raw) ?? {} } catch (e) { console.error('restoring the canvas:', e); fail(raw) }
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
  } finally { restoring = false }
  save()
  return all
}
