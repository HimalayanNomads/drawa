// The drawing's actions (lib/actions.ts, canvas/ink/inkactions.ts). Strokes are named by their id.
import type { Saved } from '../canvas/ink/stroke';

/** The kinds of drawing action. The values are what the action log holds: don't change them. */
export enum InkActionType {
  Add = 'ink.add',
  Remove = 'ink.remove',
  Change = 'ink.change',
  Move = 'ink.move',
}

/** Strokes added, or taken off. Each carries its saved form (its short keys are the layout's saved format), so
 *  the action can put it back. */
export type InkAdd = {
  type: InkActionType.Add | InkActionType.Remove;
  strokes: Saved[];
};

/** A stroke's points and text at one moment: what a change in place sets. */
export type StrokeSnapshot = {
  points: number[][];
  text?: string;
};

/** Strokes changed in place (resized, retyped): `before` and `after` line up with `ids`. */
export type InkChange = {
  type: InkActionType.Change;
  ids: string[];
  before: StrokeSnapshot[];
  after: StrokeSnapshot[];
};

/** Strokes moved by an offset, in canvas units. */
export type InkMove = {
  type: InkActionType.Move;
  ids: string[];
  offsetX: number;
  offsetY: number;
};
