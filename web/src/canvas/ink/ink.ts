// biome-ignore-all assist/source/organizeImports: import order here is evaluation order, which sets registration order (see CLAUDE.md)
// Draw mode: freehand ink, shapes, text and the eraser, from the drawing toolbar or Excalidraw's keys. The strokes
// themselves (painting, saving) are canvas/ink/stroke.ts; where a press lands, canvas/ink/inkplace.ts; writing text,
// canvas/ink/inktext.ts.
import { $, confirmBox, perFrame } from '../../lib/dom';
import { view, changed } from '../core/view';
import { track } from '../core/drag';
import { pictureZoomed } from '../core/fullview';
import { command } from '../../lib/keys';
import { rowAt } from './inkrows';
import { startLink } from '../graph/links';
import { SHAPES, constrain, type Shape } from './shapegeom';
import { recordAdded, erase, undo, redo } from './inkundo';
import { strokes, paint, remove, inkPlaced, type Stroke } from './stroke';
import { placeAt, toCanvas, type Place } from './inkplace';
import { writeAt, finishText } from './inktext';

const capture = $('#ink-capture'),
  bar = $('#inkbar'),
  btn = $('#btn-draw');
let color = 'ink',
  size = 4,
  fill = false;
export let drawing = false;

/* ---------- mode ---------- */
export function setDrawing(on: boolean) {
  drawing = on;
  capture.hidden = bar.hidden = !on;
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('on', on);
  document.body.classList.toggle('drawing', on); // lifts the drawing surface over pinned windows (canvas.css)
  if (!on) {
    setTool('pen');
    finishText();
  }
}
/** Draw mode's tool: the pen, the Arrow tool (connect two items), the eraser, Text (click to write), or a shape. */
export type Tool = 'pen' | 'arrow' | 'eraser' | 'text' | Shape;
let tool: Tool = 'pen';
/** The toolbar button's data-ink name for a tool ('' for the pen, which has none). */
const buttonOf = (t: Tool) => (t === 'eraser' ? 'erase' : t === 'pen' ? '' : t);
/** Is this tool a shape? */
const isShape = (t: Tool): t is Shape => (SHAPES as string[]).includes(t);
/** Switch the drawing tool, and show which one is on. */
function setTool(t: Tool) {
  tool = t;
  document.body.classList.toggle('erasing', t === 'eraser');
  document.body.classList.toggle('texting', t === 'text');
  for (const b of bar.querySelectorAll(['arrow', 'erase', 'text', ...SHAPES].map(k => `[data-ink=${k}]`).join()))
    pressed(b, b.getAttribute('data-ink') === buttonOf(t));
}
/** Pick a tool; picking the one that's on goes back to the pen. */
const pickTool = (t: Tool) => setTool(tool === t ? 'pen' : t); // picking the tool that's on goes back to the pen
// Excalidraw's keys for the tools (D toggles Draw here, so the diamond is 3 alone): letters by what they type, digits
// by the number row's physical key
const TOOLS: [string, Tool, string[]][] = [
  ['Pen', 'pen', ['p', 'Digit7']],
  ['Arrow between items', 'arrow', ['a', 'Digit5']],
  ['Eraser', 'eraser', ['e', 'Digit0']],
  ['Text', 'text', ['t', 'Digit8']],
  ['Rectangle', 'rect', ['r', 'Digit2']],
  ['Diamond', 'diamond', ['Digit3']],
  ['Ellipse', 'ellipse', ['o', 'Digit4']],
  ['Line', 'line', ['l', 'Digit6']],
];
for (const [label, t, keys] of TOOLS)
  command({
    label,
    group: 'Draw',
    keys,
    // outside Draw mode a tool's key switches it on with that tool, except T (a sticky note, main.ts) and 0 while a
    // picture in full view zooms (it resets the zoom, fullview.ts)
    key: e => {
      if (drawing) return pickTool(t);
      if (e.key.toLowerCase() === 't' || (e.code === 'Digit0' && pictureZoomed())) return false;
      useTool(t);
    },
  });
const whileDrawing = () => drawing;
command({ label: 'Undo', group: 'Draw', keys: ['$mod+z'], when: whileDrawing, key: () => void undo() });
command({ label: 'Redo', group: 'Draw', keys: ['$mod+Shift+z', '$mod+y'], when: whileDrawing, key: () => void redo() });
command({ label: 'Stop drawing', group: 'Draw', keys: ['Escape'], when: whileDrawing, key: () => setDrawing(false) });

/* ---------- input: left button draws (or erases); middle button and wheel still pan the canvas ---------- */
capture.addEventListener('pointerdown', e => {
  if (e.button !== 0) return; // falls through to the canvas pan handler
  e.stopPropagation();
  if (tool !== 'text') finishText(); // finish text being written before anything else
  if (tool === 'arrow') return startLink(e, color, capture);
  if (tool === 'text') {
    e.preventDefault();
    return writeAt(e, color, size);
  }
  if (tool === 'eraser') {
    const gone: Stroke[] = [];
    eraseAt(e, gone);
    return listen(
      e,
      ev => eraseAt(ev, gone),
      () => erase(...gone),
    );
  }
  const at = placeAt(e),
    { host, scale } = at;
  if (isShape(tool)) return drawShape(e, tool, at);
  // size is in screen px at the moment of drawing, so a stroke looks the same weight at any zoom (or in full view)
  const s: Stroke = {
    c: color,
    s: size * scale,
    sim: e.pointerType !== 'pen',
    p: [at.pt(e)],
    host,
    h: host?.dataset.ink,
    ...rowAt(host, e),
  };
  strokes.push(s);
  paint(s);
  /** Repaint the stroke once a frame while it's drawn. */
  const repaint = perFrame(() => paint(s));
  let pt = at.pt;
  listen(
    e,
    ev => {
      if (at.off(ev)) pt = toCanvas(s, at);
      for (const c of ev.getCoalescedEvents?.() ?? [ev]) s.p.push(pt(c));
      repaint();
    },
    () => {
      thin(s);
      paint(s);
      recordAdded(s);
      inkPlaced([s]);
      changed();
    },
  );
});

/** Follow a press on the capture layer until it ends, released or cancelled (a touch the browser takes over):
 *  without the cancel, the next press would drive two strokes at once. Every move counts (pen points). */
const listen = (e: PointerEvent, mv: (ev: PointerEvent) => void, up: () => void) =>
  track(
    capture,
    e,
    (_x, _y, ev) => mv(ev),
    () => up(),
    { keep: true, every: true },
  );

/** Drag out a shape from the press; Shift makes it a square / circle, or snaps a line to 45°. Too small: dropped. */
function drawShape(e: PointerEvent, sh: Shape, at: Place) {
  const { host } = at;
  let { pt, scale } = at,
    a = pt(e).slice(0, 2);
  const s: Stroke = {
    c: color,
    s: size * scale,
    sim: false,
    p: [a, a],
    sh,
    ...(fill && sh !== 'line' ? { f: true } : {}),
    host,
    h: host?.dataset.ink,
    ...rowAt(host, e),
  };
  strokes.push(s);
  /** Repaint the shape once a frame while it's dragged out. */
  const redraw = perFrame(() => paint(s));
  listen(
    e,
    ev => {
      if (at.off(ev)) {
        pt = toCanvas(s, at);
        a = s.p[0];
        scale = 1 / view.k;
      }
      const b = pt(ev).slice(0, 2);
      s.p = [a, ev.shiftKey ? constrain(sh, a, b) : b];
      redraw();
    },
    () => {
      const [[x0, y0], [x1, y1]] = s.p;
      if (Math.hypot(x1 - x0, y1 - y0) / scale < 4) return remove(s); // a click, not a drag
      paint(s);
      recordAdded(s);
      inkPlaced([s]);
      changed();
    },
  );
}

/** Drop points closer than a fraction of the pen's width to the last one kept: the outline looks the same, and
 *  saved layouts stay far smaller (a fast mouse sends hundreds of points per stroke). */
function thin(s: Stroke) {
  const tol = s.s * 0.35,
    out = [s.p[0]];
  for (const q of s.p.slice(1, -1)) {
    const l = out[out.length - 1];
    if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= tol) out.push(q);
  }
  if (s.p.length > 1) out.push(s.p[s.p.length - 1]);
  s.p = out;
}

/** Rub out what's under the pointer at once; `gone` collects it, so the whole rub undoes as one action. */
function eraseAt(e: PointerEvent, gone: Stroke[]) {
  for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
    const s = strokes.find(s => s.el === el || s.el?.contains(el)); // a shape's parts are inside its group
    if (s) {
      remove(s);
      gone.push(s);
    }
  }
}

/** Draw mode with one tool picked. */
export function useTool(t: Tool) {
  if (!drawing) setDrawing(true);
  setTool(t);
}

for (const b of bar.querySelectorAll<HTMLButtonElement>('[data-ink]')) {
  b.onclick = () => {
    const [kind, val] = b.dataset.ink!.split(':');
    if (kind === 'color') {
      color = val;
      if (tool === 'eraser') setTool('pen');
    } else if (kind === 'size') {
      size = Number(val);
      if (tool === 'eraser') setTool('pen');
    } else if (kind === 'erase') return pickTool('eraser');
    else if (kind === 'arrow') return pickTool('arrow');
    else if (kind === 'text') return pickTool('text');
    else if (isShape(kind as Tool)) return pickTool(kind as Shape);
    else if (kind === 'fill') {
      fill = !fill;
      b.classList.toggle('on', fill);
      b.setAttribute('aria-pressed', String(fill));
      return;
    } else if (kind === 'undo') return undo();
    else if (kind === 'redo') return redo();
    else if (kind === 'clear') {
      if (strokes.length)
        confirmBox(
          'Erase all drawing?',
          'Every stroke on the canvas is removed. Undo (Ctrl+Z) brings them back.',
          'Erase all',
        ).then(ok => {
          if (ok) erase(...strokes);
        });
      return;
    } else if (kind === 'done') return setDrawing(false);
    for (const o of bar.querySelectorAll(`[data-ink^="${kind}:"]`)) pressed(o, o === b);
  };
}
/** Options (colors, sizes, tools) say which is picked, to screen readers too. */
function pressed(b: Element, on: boolean) {
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}
for (const o of bar.querySelectorAll('[data-ink^="color:"], [data-ink^="size:"]'))
  pressed(o, o.classList.contains('on'));
btn.onclick = () => setDrawing(!drawing);
