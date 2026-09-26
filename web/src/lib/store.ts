// The canvas survives a reload (per project folder, this browser only). Each feature registers the slice it owns;
// save() gathers them all into one localStorage entry, restore() hands each slice back to its owner.
import { project, toast } from './dom'

interface Part { save: () => unknown; load?: (value: any, all: Record<string, any>) => unknown; phase: number }
const parts = new Map<string, Part>()

/** Own a key of the saved layout. `phase` orders restoring: 0 settings, 1 canvas items, 2 things that attach to items (ink). */
export function persist<T>(key: string, save: () => T, load?: (value: T, all: Record<string, any>) => unknown, phase = 1) {
  parts.set(key, { save, load, phase })
}

const KEY = () => 'drawa:canvas:' + project.root

let warned = false
const cache = new Map<string, string | undefined>() // each slice's JSON as last saved
let written = ''
/** Save the layout. `only`: just these slices changed (e.g. a pan: the view); the rest are reused from last time. */
export function save(slices?: string[] | Event) {
  const only = Array.isArray(slices) ? slices : undefined // also used as an event handler (onchange = save)
  for (const [k, p] of parts) if (!only || only.includes(k) || !cache.has(k)) cache.set(k, JSON.stringify(p.save()))
  const json = `{${[...cache].filter(([, j]) => j !== undefined).map(([k, j]) => `${JSON.stringify(k)}:${j}`).join(',')}}`
  if (json === written) return // nothing changed (a pan that came back, a click)
  try { localStorage.setItem(KEY(), json); written = json; warned = false }
  catch (e) {
    // full (or storage blocked): the layout stops saving, so say it once instead of losing changes silently
    if (!warned) toast(`The canvas couldn't be saved in this browser (${(e as Error).name}). Remove big snippets or scratchpads to make room.`)
    warned = true
  }
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

/** Load every slice that was saved, phase by phase (a slice's loader may be async: the next one waits for it). */
export async function restore() {
  let all: Record<string, any> = {}
  try { all = JSON.parse(localStorage.getItem(KEY()) ?? '{}') ?? {} } catch {}
  for (const [key, p] of [...parts].sort((a, b) => a[1].phase - b[1].phase)) {
    if (all[key] === undefined || !p.load) continue
    try { await p.load(all[key], all) } catch (e) { console.error(`restoring ${key}:`, e) }
  }
  return all
}
