// Undo for the drawing: a short stack of what was done to it (strokes added, removed, moved, resized or retyped),
// undone newest first. Only what was done since the page loaded: after a reload there's nothing to undo, rather
// than Ctrl+Z taking saved strokes off one by one.
import { changed } from './canvas'
import { strokes, paint, remove, type Stroke } from './ink'
import { dropLinks } from './links'

const MAX = 200 // ponytail: oldest actions fall off; no redo (add a second stack if anyone asks for Ctrl+Shift+Z)
const ops: (() => void)[] = [] // each puts the drawing back the way it was before one action
const push = (op: () => void) => { ops.push(op); if (ops.length > MAX) ops.shift() }

/** New strokes: undoing takes them off again. */
export const added = (...list: Stroke[]) => push(() => remove(...list))

/** Take strokes off the drawing as one action undo can bring back (the eraser, Delete, Erase all). */
export function erase(...gone: Stroke[]) {
  if (!gone.length) return
  const links = gone.map(dropLinks) // their arrows go now and come back with them
  push(() => { restore(gone); links.forEach(back => back()) })
  remove(...gone)
}

/** Call before strokes change in place (moved, resized, retyped); call what it returns once they have, to record it. */
export function changing(list: Stroke[]) {
  const was = list.map(s => ({ p: s.p.map(q => [...q]), t: s.t }))
  return () => push(() => list.forEach((s, i) => { Object.assign(s, was[i]); paint(s) }))
}

export function undo() {
  ops.pop()?.()
  changed()
}

function restore(list: Stroke[]) {
  for (const s of list) {
    if (s.host && !s.host.isConnected) continue // its window was closed since: nowhere to put it back
    s.el = undefined // painted afresh
    s.sel = false
    strokes.push(s)
    paint(s)
  }
}
