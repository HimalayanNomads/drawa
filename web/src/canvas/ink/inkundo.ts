// Undo and redo for the drawing: a short stack of what was done to it (strokes added, removed, moved, resized or
// retyped), undone newest first, and a second stack of what was undone, redone newest first. Only what was done
// since the page loaded: after a reload there's nothing to undo, rather than Ctrl+Z taking saved strokes off one by
// one.
import { changed } from '../core/view';
import { dropLinks } from '../graph/links';
import { paint, remove, type Stroke, strokes } from './stroke';

const MAX = 200; // ponytail: oldest actions fall off; a longer history would need the steps saved more compactly
/** One drawing action: `undo` puts the drawing back the way it was before it, `redo` does it again. */
type Step = { undo: () => void; redo: () => void };
const undoSteps: Step[] = [];
const redoSteps: Step[] = [];

/** Add a step that undo can reverse, dropping the oldest past MAX. */
function keepUndoStep(step: Step) {
  undoSteps.push(step);
  if (undoSteps.length > MAX) undoSteps.shift();
}

/** Record a new action: it can be undone, and what was undone before it can no longer be redone. */
function pushUndo(step: Step) {
  keepUndoStep(step);
  redoSteps.length = 0;
}

/** New strokes: undoing takes them off again, with any arrows drawn to them since; redo brings both back. */
export function recordAdded(...list: Stroke[]) {
  let linkBacks: (() => void)[] = [];
  pushUndo({
    /** Take the strokes off, and their arrows with them (the eraser does the same). */
    undo: () => {
      linkBacks = list.map(dropLinks);
      remove(...list);
    },
    /** Put the strokes back, then the arrows that went with them. */
    redo: () => {
      restore(list);
      linkBacks.forEach(back => back());
      linkBacks = [];
    },
  });
}

/** Take strokes off the drawing as one action undo can bring back (the eraser, Delete, Erase all). */
export function erase(...gone: Stroke[]) {
  if (!gone.length) return;
  let linkBacks: (() => void)[] = [];
  /** Take the strokes off; their arrows go now and come back with them. */
  const takeOff = () => {
    linkBacks = gone.map(dropLinks);
    remove(...gone);
  };
  /** Put the strokes back, then their arrows. */
  const putBack = () => {
    restore(gone);
    linkBacks.forEach(back => back());
    linkBacks = [];
  };
  takeOff();
  pushUndo({ undo: putBack, redo: takeOff });
}

/** A copy of the strokes' points and text, which later edits to the strokes can't reach. */
const snapshot = (list: Stroke[]) => list.map(s => ({ p: s.p.map(q => [...q]), t: s.t }));

/** Call before strokes change in place (moved, resized, retyped); call what it returns once they have, to record it. */
export function changing(list: Stroke[]) {
  const before = snapshot(list);
  return () => {
    const after = snapshot(list);
    /** Give the strokes the points and text of a snapshot. A copy goes in, not the snapshot itself: a resize edits
     *  `s.p` in place, which would otherwise rewrite the snapshot a later undo or redo uses. */
    const applySnapshot = (saved: typeof before) =>
      list.forEach((s, i) => {
        s.p = saved[i].p.map(q => [...q]);
        s.t = saved[i].t;
        paint(s);
      });
    pushUndo({ undo: () => applySnapshot(before), redo: () => applySnapshot(after) });
  };
}

/** Undo the last drawing action (Ctrl+Z in Draw mode); it can be redone until something new is drawn. */
export function undo() {
  const step = undoSteps.pop();
  if (!step) return;
  step.undo();
  redoSteps.push(step);
  changed();
}

/** Redo the last undone drawing action (Ctrl+Shift+Z or Ctrl+Y in Draw mode, or the toolbar's Redo). */
export function redo() {
  const step = redoSteps.pop();
  if (!step) return;
  step.redo();
  keepUndoStep(step);
  changed();
}

/** Put strokes back on the drawing, unless their window has closed since. */
function restore(list: Stroke[]) {
  for (const s of list) {
    if (s.host && !s.host.isConnected) continue; // its window was closed since: nowhere to put it back
    s.el = undefined; // painted afresh
    s.sel = false;
    strokes.push(s);
    paint(s);
  }
}
