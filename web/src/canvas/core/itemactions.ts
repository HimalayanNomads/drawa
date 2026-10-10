// The changes every canvas item can go through, as actions (lib/actions.ts): moved (a drag, a nudge, a selection
// moved) and resized. Window-only ones (renamed, collapsed, removed) are in canvas/core/window.ts, with what they
// change.
import { defineAction, recordActions } from '../../lib/actions';
import {
  ItemActionType,
  type ItemResize,
  type ItemsMove,
  type Move,
  type PositionAndSizeStyles,
} from '../../types/canvas';
import { redraw } from '../graph/graph';
import { byIds, place, rect } from './items';

// moves: one step per drag, nudge or selection move
defineAction<ItemsMove>(ItemActionType.Move, {
  apply: action => {
    const itemsById = byIds();
    const found = action.moves.filter(move => itemsById.has(move.id));
    for (const move of found) place(itemsById.get(move.id)!, ...move.to);
    if (found.length) redraw(); // a session's arrows to its windows move only on redraw; it calls changed() too
    return found.length > 0;
  },
  invert: action => ({
    type: ItemActionType.Move,
    moves: action.moves.map(move => ({ id: move.id, from: move.to, to: move.from })),
  }),
});
/** Record items that moved from these spots (in the same order) to where they are now. */
export function recordItemMoves(items: HTMLElement[], startedAt: { x: number; y: number }[]) {
  const moves = items
    .map((item, index): Move => {
      const now = rect(item);
      return { id: item.dataset.id!, from: [startedAt[index].x, startedAt[index].y], to: [now.x, now.y] };
    })
    .filter(move => move.id && (move.from[0] !== move.to[0] || move.from[1] !== move.to[1]));
  if (moves.length) recordActions({ type: ItemActionType.Move, moves });
}

// a window's box as its styles say (a floating window keeps its screen spot in --fx / --fy)
const POSITION_AND_SIZE_STYLE_NAMES: (keyof PositionAndSizeStyles)[] = [
  'left',
  'top',
  'width',
  'height',
  '--fx',
  '--fy',
];
/** An item's box, from its styles. */
export const positionAndSizeStyles = (item: HTMLElement) =>
  Object.fromEntries(
    POSITION_AND_SIZE_STYLE_NAMES.map(style => [style, item.style.getPropertyValue(style)]),
  ) as PositionAndSizeStyles;
defineAction<ItemResize>(ItemActionType.Resize, {
  apply: action => {
    const item = byIds().get(action.id);
    if (!item) return false;
    for (const style of POSITION_AND_SIZE_STYLE_NAMES) item.style.setProperty(style, action.to[style] || null);
    redraw();
    return true;
  },
  invert: action => ({ ...action, from: action.to, to: action.from }),
});

/** Record an item resized from this box to the one it has now. */
export function recordItemResize(item: HTMLElement, from: PositionAndSizeStyles) {
  const to = positionAndSizeStyles(item);
  const resized = POSITION_AND_SIZE_STYLE_NAMES.some(style => from[style] !== to[style]);
  if (item.dataset.id && resized) recordActions({ type: ItemActionType.Resize, id: item.dataset.id, from, to });
}
