// The changes every canvas item can go through, as actions (lib/actions.ts): moved (a drag, a nudge, a selection
// moved) and resized. Window-only ones (renamed, collapsed, removed) are in canvas/core/window.ts, with what they
// change.
import { defineAction, recordActions } from '../../lib/actions';
import { byIds, place, rect } from './items';
import { changed } from './view';

// moves: one step per drag, nudge or selection move
type Move = { id: string; from: [number, number]; to: [number, number] };
type ItemsMove = { t: 'items.move'; moves: Move[] };
defineAction<ItemsMove>('items.move', {
  apply: a => {
    const by = byIds(),
      found = a.moves.filter(m => by.has(m.id));
    for (const m of found) place(by.get(m.id)!, ...m.to);
    if (found.length) changed();
    return found.length > 0;
  },
  invert: a => ({ t: 'items.move', moves: a.moves.map(m => ({ id: m.id, from: m.to, to: m.from })) }),
});
/** Record items that moved from these spots (in the same order) to where they are now. */
export function recordMoves(els: HTMLElement[], from: { x: number; y: number }[]) {
  const moves = els
    .map((el, i): Move => ({ id: el.dataset.id!, from: [from[i].x, from[i].y], to: [rect(el).x, rect(el).y] }))
    .filter(m => m.id && (m.from[0] !== m.to[0] || m.from[1] !== m.to[1]));
  if (moves.length) recordActions({ t: 'items.move', moves });
}

// a window's box as its styles say (a floating window keeps its screen spot in --fx / --fy)
const BOX = ['left', 'top', 'width', 'height', '--fx', '--fy'] as const;
type Box = Record<(typeof BOX)[number], string>;
type ItemResize = { t: 'item.resize'; id: string; from: Box; to: Box };
/** An item's box, from its styles. */
export const boxOf = (el: HTMLElement) => Object.fromEntries(BOX.map(k => [k, el.style.getPropertyValue(k)])) as Box;
defineAction<ItemResize>('item.resize', {
  apply: a => {
    const el = byIds().get(a.id);
    if (!el) return false;
    for (const k of BOX) el.style.setProperty(k, a.to[k] || null);
    changed();
    return true;
  },
  invert: a => ({ ...a, from: a.to, to: a.from }),
});

/** Record an item resized from this box to the one it has now. */
export function recordResize(el: HTMLElement, from: Box) {
  const to = boxOf(el);
  if (el.dataset.id && BOX.some(k => from[k] !== to[k]))
    recordActions({ t: 'item.resize', id: el.dataset.id, from, to });
}
