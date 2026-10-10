// The actions every canvas item can go through (lib/actions.ts): moved and resized (canvas/core/itemactions.ts),
// renamed, collapsed and removed (canvas/core/window.ts). Items are named by their data-id.

/** One item's move, in canvas units. */
export type Move = {
  id: string;
  from: [number, number];
  to: [number, number];
};

/** Items moved together: a drag, a nudge, a selection moved. */
export type ItemsMove = {
  t: 'items.move';
  moves: Move[];
};

/** A window's box as its styles say it, a floating window's screen spot (--fx, --fy) included. */
export type Box = Record<'left' | 'top' | 'width' | 'height' | '--fx' | '--fy', string>;

/** An item resized (from a left or top edge it moves too). */
export type ItemResize = {
  t: 'item.resize';
  id: string;
  from: Box;
  to: Box;
};

/** A window renamed. */
export type ItemRename = {
  t: 'item.rename';
  id: string;
  from: string;
  to: string;
};

/** A window collapsed to its tab (`min`), or opened again. */
export type ItemCollapse = {
  t: 'item.collapse';
  id: string;
  min: boolean;
};

/** A window taken off the canvas, or put back while its Undo toast still holds it. */
export type ItemRemove = {
  t: 'item.remove' | 'item.restore';
  id: string;
};
