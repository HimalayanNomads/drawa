// The drawing's changes as actions (lib/actions.ts), so they share the canvas's one undo history and its log: strokes
// added, removed, changed in place (resized, retyped) and moved. Actions carry strokes as data, by id; a stroke removed
// in this page is kept (with the arrows that went with it) so undo puts back the same stroke, arrows and all.

import { defineAction, recordActions } from '../../lib/actions';
import { uuid } from '../../lib/dom';
import { changed } from '../core/view';
import { dropLinks } from '../graph/links';
import { strokeMover } from './inksel';
import { hostOf, paint, remove, type Saved, type Stroke, strokeData, strokes } from './stroke';

type Shape = { p: number[][]; t?: string };
type InkAdd = { t: 'ink.add' | 'ink.remove'; strokes: Saved[] };
type InkChange = { t: 'ink.change'; ids: string[]; before: Shape[]; after: Shape[] };
type InkMove = { t: 'ink.move'; ids: string[]; dx: number; dy: number };

/** A stroke's id, given now if it has none: actions name strokes by it. */
const idOf = (s: Stroke) => (s.id ??= uuid());
/** The strokes on the page with these ids, in that order (missing ones left out). */
const byId = (ids: string[]) => {
  const all = new Map(strokes.map(s => [s.id, s]));
  return ids.map(id => all.get(id)).filter((s): s is Stroke => !!s);
};
/** Strokes taken off in this page, with what puts their arrows back. */
const gone = new Map<string, { s: Stroke; arrows: () => void }>();

/** Put a stroke back: the same one if it was taken off in this page (its arrows too), else one made from its data;
 *  not when its window has closed since. */
function putBack(d: Saved) {
  if (d.id && strokes.some(s => s.id === d.id)) return false;
  const was = d.id ? gone.get(d.id) : undefined,
    host = hostOf(d);
  if (host === null) return false;
  const s: Stroke = was?.s ?? { ...d, p: d.p.map(q => [...q]), host };
  if (s.host && !s.host.isConnected) return false;
  s.el = undefined; // painted afresh
  s.sel = false;
  strokes.push(s);
  paint(s);
  if (was) {
    gone.delete(d.id!);
    was.arrows();
  }
  return true;
}
defineAction<InkAdd>('ink.add', {
  apply: a => {
    const any = a.strokes.map(putBack).some(Boolean);
    if (any) changed();
    return any;
  },
  invert: a => ({ t: 'ink.remove', strokes: a.strokes }),
});
/** Take strokes off, keeping them (and their arrows) for undo. */
function takeOff(list: Stroke[]) {
  for (const s of list) gone.set(idOf(s), { s, arrows: dropLinks(s) });
  remove(...list);
}
defineAction<InkAdd>('ink.remove', {
  apply: a => {
    const list = byId(a.strokes.map(d => d.id!));
    takeOff(list);
    return list.length > 0;
  },
  invert: a => ({ t: 'ink.add', strokes: a.strokes }),
});
defineAction<InkChange>('ink.change', {
  apply: a => {
    const list = byId(a.ids);
    list.forEach(s => {
      const i = a.ids.indexOf(s.id!);
      s.p = a.after[i].p.map(q => [...q]);
      s.t = a.after[i].t;
      paint(s);
    });
    if (list.length) changed();
    return list.length > 0;
  },
  invert: a => ({ t: 'ink.change', ids: a.ids, before: a.after, after: a.before }),
});
defineAction<InkMove>('ink.move', {
  apply: a => {
    const list = byId(a.ids);
    if (!list.length) return false;
    const m = strokeMover(list, false);
    m(a.dx, a.dy);
    m.end();
    return true;
  },
  invert: a => ({ ...a, dx: -a.dx, dy: -a.dy }),
});

/** As data, with ids. */
const asData = (list: Stroke[]) => list.map(s => strokeData({ ...s, id: idOf(s) }));

/** New strokes, already drawn: undo takes them off again (with any arrows drawn to them since), redo puts them back. */
export const recordAdded = (...list: Stroke[]) => recordActions({ t: 'ink.add', strokes: asData(list) });

/** Take strokes off the drawing as one action undo can bring back (the eraser, Delete, Erase all). */
// Taken off here, then recorded: the eraser has already rubbed some of them out mid-swipe.
export function erase(...list: Stroke[]) {
  if (!list.length) return;
  const data = asData(list);
  takeOff(list);
  recordActions({ t: 'ink.remove', strokes: data });
}

/** A copy of the strokes' points and text, which later edits to the strokes can't reach. */
const snapshot = (list: Stroke[]): Shape[] => list.map(s => ({ p: s.p.map(q => [...q]), t: s.t }));

/** Call before strokes change in place (resized, retyped); call what it returns once they have, to record it. */
export function changing(list: Stroke[]) {
  const before = snapshot(list);
  return () => recordActions({ t: 'ink.change', ids: list.map(idOf), before, after: snapshot(list) });
}

/** Record strokes moved by an offset in canvas units (already moved). */
export const recordMoved = (list: Stroke[], dx: number, dy: number) =>
  recordActions({ t: 'ink.move', ids: list.map(idOf), dx, dy });
