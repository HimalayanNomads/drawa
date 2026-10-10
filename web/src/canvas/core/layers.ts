// Layer order: bring forward / send backward / to front / to back, from the right-click menu (canvas/core/menu.ts), the
// selection bar and ] / [ (with Shift: all the way). Only windows on the canvas take part: pinned and floating ones
// sit above it anyway. The order is the 'z' key canvas/core/items.ts already saves.
import { command } from '../../lib/keys';
import { drawing } from '../ink/ink';
import { hidden, items, onCanvas, overlaps, rect, restack } from './items';
import { menuSection, openMenu } from './menu';
import { selected, selectionAction } from './select';
import { active } from './winkeys';

type Move = 'front' | 'forward' | 'backward' | 'back';
/** An item's place in the stack (its z-index; 0 when it has none). */
const zIndexOf = (el: HTMLElement) => +el.style.zIndex || 0;
/** Is this item in the layer stack (on the canvas, shown, its z-index not set by CSS)? */
// items whose CSS pins their layer (a group's frame, always under its windows) aren't in the stack
const stacked = (el: HTMLElement) => onCanvas(el) && !hidden(el) && getComputedStyle(el).zIndex === el.style.zIndex;

/** Move one item in the stack. Forward and backward step past the next item it overlaps (one it doesn't overlap
 *  changes nothing you can see), so inside a group that's the group's windows around it. */
function moveOne(all: HTMLElement[], el: HTMLElement, how: Move) {
  const i = all.indexOf(el);
  all.splice(i, 1);
  if (how === 'front') return all.push(el);
  if (how === 'back') return all.unshift(el);
  const r = rect(el),
    over = (o: HTMLElement) => o !== el && stacked(o) && overlaps(r, rect(o), 0);
  if (how === 'forward') {
    const j = all.findIndex((o, k) => k >= i && over(o));
    all.splice(j < 0 ? i : j + 1, 0, el);
  } else {
    const j = all.findLastIndex((o, k) => k < i && over(o));
    all.splice(j < 0 ? i : j, 0, el);
  }
}

/** Move items forward, backward, to the front or to the back of the stack. */
export function moveLayer(els: HTMLElement[], how: Move) {
  const all = items().sort((a, b) => zIndexOf(a) - zIndexOf(b));
  // a selection keeps its own order: the top one moves first going up, the bottom one going down
  const mine = els
    .filter(stacked)
    .sort((a, b) => (how === 'front' || how === 'forward' ? zIndexOf(b) - zIndexOf(a) : zIndexOf(a) - zIndexOf(b)));
  if (!mine.length) return;
  for (const el of how === 'front' || how === 'back' ? mine.reverse() : mine) moveOne(all, el, how);
  restack(all);
}

const MOVES: [Move, string, string][] = [
  ['front', 'Bring to front', 'Shift+BracketRight'],
  ['forward', 'Bring forward', 'BracketRight'],
  ['backward', 'Send backward', 'BracketLeft'],
  ['back', 'Send to back', 'Shift+BracketLeft'],
];
/** An icon for a layer action. */
// to front / to back: two sheets, the moving one filled; forward / backward: an arrow past a line
const sheet = (d: string) => `<svg viewBox="0 0 16 16">${d}</svg>`;
const ICONS: Record<Move, string> = {
  front: sheet(
    '<path d="M2.5 5.5h7v7h-7z" stroke-dasharray="1.5 1.5"/><path d="M6.5 2.5h7v7h-7z" fill="currentColor" fill-opacity=".25"/>',
  ),
  forward: sheet('<path d="M8 13V5M5 8l3-3 3 3M3 2.5h10"/>'),
  backward: sheet('<path d="M8 3v8M5 8l3 3 3-3M3 13.5h10"/>'),
  back: sheet(
    '<path d="M6.5 2.5h7v7h-7z" stroke-dasharray="1.5 1.5"/><path d="M2.5 5.5h7v7h-7z" fill="currentColor" fill-opacity=".25"/>',
  ),
};
/** What the layer actions act on: the selection, else the active window. */
const targets = () => {
  const s = selected();
  if (s.length) return s;
  const a = active();
  return a ? [a] : [];
};
// bare keys, like a drawing app's: with Cmd or Ctrl the browser keeps them (Cmd+Shift+[ / ] switch tabs on a Mac,
// Cmd+[ / ] go back and forward), so the page never sees them. By physical key: Shift turns them into { and }.
for (const [how, label, key] of MOVES)
  command({ label, group: 'Windows', keys: [key], when: () => !drawing, run: () => moveLayer(targets(), how) });
const barBtn = selectionAction(
  'Layer',
  'Bring forward or send back (] / [, with Shift: all the way)',
  () => {
    const r = barBtn.getBoundingClientRect();
    openMenu(selected(), r.left, r.bottom + 4, 'Layer');
  },
  els => els.some(stacked),
);

// the Layer section of the right-click menu (canvas/core/menu.ts)
menuSection('Layer', els =>
  els.some(stacked)
    ? MOVES.map(([how, label, key]) => ({ label, icon: ICONS[how], keys: key, run: () => moveLayer(els, how) }))
    : [],
);
