// The actions every canvas item can go through (lib/actions.ts): moved and resized (canvas/core/itemactions.ts),
// renamed, collapsed and removed (canvas/core/window.ts). Items are named by their data-id.

/** The kinds of item action. The values are what the action log holds: don't change them. */
export enum ItemActionType {
  Move = 'items.move',
  Resize = 'item.resize',
  Rename = 'item.rename',
  Collapse = 'item.collapse',
  Remove = 'item.remove',
  Restore = 'item.restore',
}

/** One item's move, in canvas units. */
export type Move = {
  id: string;
  from: [number, number];
  to: [number, number];
};

/** Items moved together: a drag, a nudge, a selection moved. */
export type ItemsMove = {
  type: ItemActionType.Move;
  moves: Move[];
};

/** A window's box as its styles say it, a floating window's screen spot (--fx, --fy) included. */
export type Box = Record<'left' | 'top' | 'width' | 'height' | '--fx' | '--fy', string>;

/** An item resized (from a left or top edge it moves too). */
export type ItemResize = {
  type: ItemActionType.Resize;
  id: string;
  from: Box;
  to: Box;
};

/** A window renamed. */
export type ItemRename = {
  type: ItemActionType.Rename;
  id: string;
  from: string;
  to: string;
};

/** A window collapsed to its tab (`min`), or opened again. */
export type ItemCollapse = {
  type: ItemActionType.Collapse;
  id: string;
  min: boolean;
};

/** A window taken off the canvas, or put back while its Undo toast still holds it. */
export type ItemRemove = {
  type: ItemActionType.Remove | ItemActionType.Restore;
  id: string;
};
