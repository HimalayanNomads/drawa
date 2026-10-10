// The drawing's changes as actions (lib/actions.ts), so they share the canvas's one undo history and its log: strokes
// added, removed, changed in place (resized, retyped) and moved. Actions carry strokes as data, by id; a stroke removed
// in this page is kept (with the arrows that went with it) so undo puts back the same stroke, arrows and all.
// (A stroke's own fields, p for its points and t for its text, are the layout's saved format: they keep their names.)

import { defineAction, recordActions } from '../../lib/actions';
import { uuid } from '../../lib/dom';
import { InkActionType, type InkAdd, type InkChange, type InkMove, type StrokeSnapshot } from '../../types/ink';
import { changed } from '../core/view';
import { dropLinks } from '../graph/links';
import { strokeMover } from './inksel';
import { hostOf, paint, remove, type Saved, type Stroke, strokeData, strokes } from './stroke';

/** A stroke's id, given now if it has none: actions name strokes by it. */
const ensureStrokeId = (stroke: Stroke) => (stroke.id ??= uuid());
/** The strokes on the page with these ids, in that order (missing ones left out). */
const strokesWithIds = (ids: string[]) => {
  const strokesById = new Map(strokes.map(stroke => [stroke.id, stroke]));
  return ids.map(id => strokesById.get(id)).filter((stroke): stroke is Stroke => !!stroke);
};
/** Strokes taken off in this page, with what puts their arrows back. */
const removedStrokes = new Map<string, { stroke: Stroke; putArrowsBack: () => void }>();

/** Put a stroke back: the same one if it was taken off in this page (its arrows too), else one made from its data;
 *  not when its window has closed since. */
function restoreStroke(saved: Saved) {
  if (saved.id && strokes.some(stroke => stroke.id === saved.id)) return false;
  const earlier = saved.id ? removedStrokes.get(saved.id) : undefined;
  const host = hostOf(saved);
  if (host === null) return false;
  const stroke: Stroke = earlier?.stroke ?? { ...saved, p: saved.p.map(point => [...point]), host };
  if (stroke.host && !stroke.host.isConnected) return false;
  stroke.el = undefined; // painted afresh
  stroke.sel = false;
  strokes.push(stroke);
  paint(stroke);
  if (earlier) {
    removedStrokes.delete(saved.id!);
    earlier.putArrowsBack();
  }
  return true;
}
defineAction<InkAdd>(InkActionType.Add, {
  apply: action => {
    const anyBack = action.strokes.map(restoreStroke).some(Boolean);
    if (anyBack) changed();
    return anyBack;
  },
  invert: action => ({ type: InkActionType.Remove, strokes: action.strokes }),
});
/** Take strokes off, keeping them (and their arrows) for undo. */
function removeKeepingForUndo(list: Stroke[]) {
  for (const stroke of list) removedStrokes.set(ensureStrokeId(stroke), { stroke, putArrowsBack: dropLinks(stroke) });
  remove(...list);
}
defineAction<InkAdd>(InkActionType.Remove, {
  apply: action => {
    const list = strokesWithIds(action.strokes.map(saved => saved.id!));
    removeKeepingForUndo(list);
    return list.length > 0;
  },
  invert: action => ({ type: InkActionType.Add, strokes: action.strokes }),
});
defineAction<InkChange>(InkActionType.Change, {
  apply: action => {
    const list = strokesWithIds(action.ids);
    for (const stroke of list) {
      const after = action.after[action.ids.indexOf(stroke.id!)];
      stroke.p = after.points.map(point => [...point]);
      stroke.t = after.text;
      paint(stroke);
    }
    if (list.length) changed();
    return list.length > 0;
  },
  invert: action => ({ type: InkActionType.Change, ids: action.ids, before: action.after, after: action.before }),
});
defineAction<InkMove>(InkActionType.Move, {
  apply: action => {
    const list = strokesWithIds(action.ids);
    if (!list.length) return false;
    const mover = strokeMover(list, false);
    mover(action.offsetX, action.offsetY);
    mover.end();
    return true;
  },
  invert: action => ({ ...action, offsetX: -action.offsetX, offsetY: -action.offsetY }),
});

/** Strokes in their saved form, each with an id. */
const toSavedForm = (list: Stroke[]) => list.map(stroke => strokeData({ ...stroke, id: ensureStrokeId(stroke) }));

/** New strokes, already drawn: undo takes them off again (with any arrows drawn to them since), redo puts them
 *  back. */
export const recordStrokesAdded = (...list: Stroke[]) =>
  recordActions({ type: InkActionType.Add, strokes: toSavedForm(list) });

/** Take strokes off the drawing as one action undo can bring back (the eraser, Delete, Erase all). */
// Taken off here, then recorded: the eraser has already rubbed some of them out mid-swipe.
export function eraseStrokes(...list: Stroke[]) {
  if (!list.length) return;
  const saved = toSavedForm(list);
  removeKeepingForUndo(list);
  recordActions({ type: InkActionType.Remove, strokes: saved });
}

/** A copy of the strokes' points and text, which later edits to the strokes can't reach. */
const snapshotOf = (list: Stroke[]): StrokeSnapshot[] =>
  list.map(stroke => ({ points: stroke.p.map(point => [...point]), text: stroke.t }));

/** Call before strokes change in place (resized, retyped); call what it returns once they have, to record it. */
export function startStrokeChange(list: Stroke[]) {
  const before = snapshotOf(list);
  return () =>
    recordActions({ type: InkActionType.Change, ids: list.map(ensureStrokeId), before, after: snapshotOf(list) });
}

/** Record strokes moved by an offset in canvas units (already moved). */
export const recordStrokesMoved = (list: Stroke[], offsetX: number, offsetY: number) =>
  recordActions({ type: InkActionType.Move, ids: list.map(ensureStrokeId), offsetX, offsetY });
