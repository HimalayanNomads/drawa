// The drawing's strokes: what one is, painting it (freehand ink, shapes, text) into the canvas-wide layer or into its
// window's own, taking strokes off, and saving them with the layout. Draw mode itself is canvas/ink/ink.ts.
// A stroke started over a window (plan, session card, sketch: anything with data-ink) belongs to it: stored in the
// window's own coordinates, it moves, scrolls and collapses with it. Strokes on empty canvas live in world coordinates
// (pan and zoom with the canvas). A host marked data-ink-fit shows something that scales with the window (an image, a
// diagram): its strokes are stored in units of its width (FIT across), so they stay on the same spot at any size,
// full view included.
import { getStroke } from 'perfect-freehand';
import { $ } from '../../lib/dom';
import { persist } from '../../lib/store';
import { changed, onChange } from '../core/view';
import { adopt, follow, onHost, unwatch, watchRows } from './inkrows';
import { fillPath, outlinePoints, type Shape } from './shapegeom';

// a stroke with `t` is text: p[0] is its top-left corner, s its font size (both in the same units as a stroke's)
// In a host marked data-ink-rows (a chat log), `a` is the row the stroke was drawn over and `o` that row's offsetTop
// then: rows off screen are laid out at an estimated height (content-visibility) until they render, so the stroke
// follows its row, not the top of the log.
// `rid` is the row's own id when it has one (tool rows): the surest way back to it after a reload.
// A stroke with `sh` is a shape (canvas/ink/shapes.ts): p holds its two corners (a line's two ends), `f` fills it.
// `row`, `bb` (bounding box) and `dx`/`dy` (how far a drag has shifted it so far, canvas units) are only kept in memory.
// `id`: given the first time a canvas-level stroke joins a group (items/group/groupink.ts), so the group can name it.
// `g`: the id of the frameless group it's in (Excalidraw's kind: selecting one selects all; canvas/ink/inksel.ts).
export interface Stroke {
  c: string;
  s: number;
  sim: boolean;
  p: number[][];
  t?: string;
  sh?: Shape;
  f?: boolean;
  a?: number;
  o?: number;
  k?: string;
  rid?: string;
  h?: string;
  id?: string;
  g?: string;
  host?: HTMLElement;
  el?: SVGPathElement | SVGTextElement | SVGGElement;
  row?: HTMLElement;
  bb?: [number, number, number, number];
  sel?: boolean;
  dx?: number;
  dy?: number;
}
const NS = 'http://www.w3.org/2000/svg';
const svg = $<SVGSVGElement>('#ink');
export const strokes: Stroke[] = [];
const placedFns: ((list: Stroke[]) => void)[] = [];
/** Called with strokes just drawn, written or dragged to a new spot (groups take in what lands in their frame). */
export const onInkPlaced = (f: (list: Stroke[]) => void) => {
  placedFns.push(f);
};
/** Tell the listeners these strokes were just drawn, written or moved. */
export const inkPlaced = (list: Stroke[]) => placedFns.forEach(f => f(list));
export const FIT = 1000;
/** Does this host scale its ink with its width (data-ink-fit: a picture, a diagram)? */
export const isFitHost = (host?: HTMLElement) => !!host && 'inkFit' in host.dataset;
/** Stored units per host px: FIT across a fitted host (a picture, a diagram), otherwise its own pixels. */
export const unitsPerHostPx = (host?: HTMLElement) => (isFitHost(host) ? FIT / host!.offsetWidth : 1);

/* ---------- rendering ---------- */
const pathOf = (o: number[][]) =>
  o.length ? `M${o.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z` : '';
/** A freehand stroke's outline as an SVG path (perfect-freehand, with pressure). */
const outline = (s: Stroke) =>
  pathOf(getStroke(s.p, { size: s.s, thinning: 0.5, smoothing: 0.5, streamline: 0.4, simulatePressure: s.sim }));
/** A shape's outline, drawn with the same pen (even weight, no pressure), so it sits with the freehand ink. */
const shapeOutline = (s: Stroke) =>
  pathOf(
    getStroke(outlinePoints(s.sh!, s.p[0], s.p[1], s.s * 1.5), {
      size: s.s,
      thinning: 0,
      smoothing: 0.3,
      streamline: 0.15,
      simulatePressure: false,
      last: true,
    }),
  );
/** The layer a stroke draws into: the canvas-wide one, or an overlay inside its window (scrolls with its content). */
function layer(host?: HTMLElement): SVGSVGElement {
  if (!host) return svg;
  let l = host.querySelector<SVGSVGElement>(':scope > svg.ink-local');
  if (!l) {
    l = document.createElementNS(NS, 'svg') as SVGSVGElement;
    l.setAttribute('class', 'ink-local');
    l.setAttribute('aria-hidden', 'true');
    // viewBox FIT wide and 1 tall, "meet": scales by the host's width (its height is always over 1px)
    if (isFitHost(host)) {
      l.classList.add('ink-fit');
      l.setAttribute('viewBox', `0 0 ${FIT} 1`);
      l.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    }
    host.append(l);
    if ('inkRows' in host.dataset) watchRows(host);
  }
  return l;
}
/** Draw a stroke (or redraw it after a change) as ink, a shape or text, in its window's layer or the canvas's. */
export function paint(s: Stroke) {
  s.bb = undefined; // measured again when asked
  if (s.host && s.a != null) requestAnimationFrame(() => follow(s.host!));
  if (s.t != null) paintText(s);
  else if (s.sh) paintShape(s);
  else {
    s.el ??= layer(s.host).appendChild(document.createElementNS(NS, 'path'));
    s.el.setAttribute('d', outline(s));
    s.el.setAttribute('class', `ink-${s.c}`);
  }
  if (s.sel) s.el?.classList.add('ink-sel'); // painting resets the class: keep the selection's mark
}
/** Draw a shape: its outline, over its fill when it has one. */
function paintShape(s: Stroke) {
  const g = (s.el ??= layer(s.host).appendChild(document.createElementNS(NS, 'g'))) as SVGGElement;
  g.setAttribute('class', `ink-${s.c} ink-shape`);
  /** One path of the shape, with its class. */
  const part = (cls: string, d: string) => {
    const e = document.createElementNS(NS, 'path');
    e.setAttribute('class', cls);
    e.setAttribute('d', d);
    return e;
  };
  const area = s.f ? fillPath(s.sh!, s.p[0], s.p[1]) : '';
  g.replaceChildren(...(area ? [part('ink-fill', area)] : []), part('ink-line', shapeOutline(s)));
}
/** Draw text: one tspan per line, the first baseline one line below its corner. */
function paintText(s: Stroke) {
  const el = (s.el ??= layer(s.host).appendChild(document.createElementNS(NS, 'text'))) as SVGTextElement;
  const [x, y] = s.p[0];
  el.setAttribute('class', `ink-${s.c} ink-text`);
  el.setAttribute('font-size', String(s.s));
  el.replaceChildren(
    ...s.t!.split('\n').map((line, i) => {
      const span = document.createElementNS(NS, 'tspan');
      span.setAttribute('x', String(x));
      span.setAttribute('y', String(y + s.s * (0.95 + i * 1.25))); // first baseline one line below the corner
      span.textContent = line || ' ';
      return span;
    }),
  );
}
/** Take strokes off the drawing (any number at once: one pass over the list). */
export function remove(...gone: Stroke[]) {
  if (!gone.length) return;
  const out = new Set(gone);
  for (const s of gone) s.el?.remove();
  const keep = strokes.filter(s => !out.has(s));
  strokes.length = 0;
  strokes.push(...keep);
  changed();
}

/** Does this window (or anything inside it) carry ink of its own? */
export const hasInk = (el: HTMLElement) => strokes.some(s => s.host && el.contains(s.host));

/** Drop a window's own ink (e.g. a plan's marks when a new version replaces the text they were about, or a session
 *  being closed) and stop watching its rows. */
export function clearInk(host: HTMLElement) {
  remove(...onHost(host));
  unwatch(host);
}

/* ---------- persistence (saved with the canvas layout) ---------- */
/** A stroke as data: what's saved with the layout, and what actions carry (canvas/ink/inkactions.ts). */
export type Saved = Omit<Stroke, 'el' | 'host' | 'row' | 'bb' | 'sel' | 'dx' | 'dy'>;
/** A stroke as data, rounded. */
export const strokeData = ({ c, s, sim, p, h, t, sh, f, a, o, k, rid, id, g }: Stroke): Saved => ({
  c,
  s: +s.toFixed(2),
  sim,
  h,
  ...(id ? { id } : {}),
  ...(g ? { g } : {}),
  p: p.map(q => q.map(n => +n.toFixed(1))),
  ...(t != null ? { t } : {}),
  ...(sh ? { sh, ...(f ? { f } : {}) } : {}),
  ...(a != null ? { a, o: Math.round(o!), k, ...(rid ? { rid } : {}) } : {}),
});
/** The window a stroke's data belongs to, if it names one: undefined when it's on the canvas, null when its window
 *  isn't there. */
export const hostOf = (d: Saved) =>
  d.h ? (document.querySelector<HTMLElement>(`[data-ink="${CSS.escape(d.h)}"]`) ?? null) : undefined;
/** The drawing as saved: strokes whose windows are still there, rounded, plus the ones still waiting for their
 *  window. */
const savedInk = () => [
  ...strokes
    .filter(s => !s.host || s.host.isConnected) // a closed window's ink goes with it
    .map(strokeData),
  ...waiting,
];
// strokes whose window isn't on the canvas (yet): kept and written back, so a window that loads late (or failed to
// load once) doesn't lose its ink at the next save; attached when it shows up. ponytail: kept forever if it never does.
let waiting: Saved[] = [],
  tried = 0;
persist(
  'ink',
  savedInk,
  (list: Saved[]) => {
    waiting = list;
    attachWaiting();
  },
  2,
); // after the windows it can belong to
/** Attach saved strokes whose windows exist now; the rest keep waiting. */
function attachWaiting() {
  tried = performance.now();
  waiting = waiting.filter(s => {
    const host = hostOf(s);
    if (host === null) return true;
    const st: Stroke = { ...s, host };
    strokes.push(st);
    paint(st);
    if (host && 'inkRows' in host.dataset && st.a == null) adopt(st); // drawn before strokes followed their rows
    return false;
  });
}
onChange(viewOnly => {
  if (!viewOnly && waiting.length && performance.now() - tried > 1000) attachWaiting();
});

/** A drawing area for content that scales with its window (see data-ink-fit): the content's own shape (w/h), as big
 *  as its parent allows (the parent needs container-type: size). Put the content inside; call again to reshape. */
export function inkBox(key: string, box?: HTMLElement, w = 1, h = 1) {
  box ??= Object.assign(document.createElement('div'), { className: 'ink-box' });
  box.dataset.ink = key;
  box.dataset.inkFit = '';
  box.style.setProperty('--ar', String(w / h || 1));
  return box;
}
/** Show a (re)drawn SVG in its drawing box, shaped by its viewBox, keeping the ink drawn on it. */
export function fitInk(box: HTMLElement, svg: SVGSVGElement) {
  const vb = svg.viewBox.baseVal;
  inkBox(box.dataset.ink!, box, vb?.width || 1, vb?.height || 1);
  box.querySelector(':scope > svg:not(.ink-local)')?.remove();
  box.prepend(svg);
}
