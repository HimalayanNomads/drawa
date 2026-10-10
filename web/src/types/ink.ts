// The drawing's actions (lib/actions.ts, canvas/ink/inkactions.ts). Strokes are named by their id.
import type { Saved } from '../canvas/ink/stroke';

/** Strokes added, or taken off. Each carries its data, so the action can put it back. */
export type InkAdd = {
  t: 'ink.add' | 'ink.remove';
  strokes: Saved[];
};

/** A stroke's points and text at one moment: what a change in place sets. */
export type StrokeSnapshot = {
  p: number[][];
  t?: string;
};

/** Strokes changed in place (resized, retyped): `before` and `after` line up with `ids`. */
export type InkChange = {
  t: 'ink.change';
  ids: string[];
  before: StrokeSnapshot[];
  after: StrokeSnapshot[];
};

/** Strokes moved, in canvas units. */
export type InkMove = {
  t: 'ink.move';
  ids: string[];
  dx: number;
  dy: number;
};
