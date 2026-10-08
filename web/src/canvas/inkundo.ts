// Undo/redo for the drawing: a short stack of what was done to it (strokes added, removed, moved, resized or
// retyped), undone newest first. Only what was done since the page loaded: after a reload there's nothing to undo,
// rather than Ctrl+Z taking saved strokes off one by one.
import { changed } from './canvas'
import { strokes, paint, remove, type Stroke } from './ink'
import { dropLinks } from './links'

const MAX = 200 // oldest actions fall off both stacks
type Entry = { undo: () => void; redo: () => void }
const ops: Entry[] = []
const redos: Entry[] = []
const push = (entry: Entry) => {
  ops.push(entry)
  if (ops.length > MAX) ops.shift()
  redos.length = 0 // a new action drops anything that was undone
}

/** New strokes: undoing takes them off again. */
export const added = (...list: Stroke[]) => push({
  undo: () => remove(...list),
  redo: () => restore(list),
})

/** Take strokes off the drawing as one action undo can bring back (the eraser, Delete, Erase all). */
export function erase(...gone: Stroke[]) {
  if (!gone.length) return
  let linkBacks: (() => void)[] = []
  const doErase = () => {
    linkBacks = gone.map(dropLinks) // their arrows go now and come back with them
    remove(...gone)
  }
  const doRestore = () => {
    restore(gone)
    linkBacks.forEach(back => back())
    linkBacks = []
  }
  doErase()
  push({ undo: doRestore, redo: doErase })
}

/** Call before strokes change in place (moved, resized, retyped); call what it returns once they have, to record it. */
export function changing(list: Stroke[]) {
  const was = list.map(s => ({ p: s.p.map(q => [...q]), t: s.t }))
  return () => {
    const now = list.map(s => ({ p: s.p.map(q => [...q]), t: s.t }))
    push({
      undo: () => list.forEach((s, i) => { Object.assign(s, was[i]); paint(s) }),
      redo: () => list.forEach((s, i) => { Object.assign(s, now[i]); paint(s) }),
    })
  }
}

export function undo() {
  const entry = ops.pop()
  if (!entry) return
  entry.undo()
  redos.push(entry)
  changed()
}

export function redo() {
  const entry = redos.pop()
  if (!entry) return
  entry.redo()
  ops.push(entry)
  if (ops.length > MAX) ops.shift()
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
