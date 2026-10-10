// Your arrows between canvas items (Draw mode's Arrow tool, like Excalidraw's): press on one item, drag, release on
// another. Either end can be a window or a drawing on the canvas itself (a shape, text, a pen stroke). They stay
// attached as the items move, pin or float. Click one to label it or delete it. Claude sees
// them in canvas_list and can draw them too (canvas_link).
import { closestAt, ICON, iconButton, make, uuid } from '../../lib/dom';
import { command } from '../../lib/keys';
import { persist } from '../../lib/store';
import { minimalUI, onUIMode } from '../../lib/uimode';
import { track } from '../core/drag';
import { byIds, hidden, liveRect, onCanvas, type Rect, shortId } from '../core/items';
import { changed, onChange, toWorld, world } from '../core/view';
import '../ink/ink'; // Draw mode first: its keys (Esc, Ctrl+Z while drawing) are handled before an arrow's
import { strokeRect } from '../ink/inksel';
import { type Stroke, strokes } from '../ink/stroke';

const NS = 'http://www.w3.org/2000/svg';
// its own layer, big enough to contain every arrow: pointer hits only count inside an SVG's box (session arrows'
// layer is 1px and never needs them). The inner group puts world (0,0) at the layer's center.
const R = 50_000;
const layer = world.insertBefore(document.createElementNS(NS, 'svg'), world.children[1] ?? null) as SVGSVGElement;
layer.setAttribute('class', 'ulinks');
layer.setAttribute('aria-hidden', 'true');
const svg = layer.appendChild(document.createElementNS(NS, 'g'));
svg.setAttribute('transform', `translate(${R},${R})`);
/** An arrow's end: an item, or a canvas-level drawing (ink on a window ends at its window). */
type End = HTMLElement | Stroke;
/** Is this arrow end an item (not a drawing)? */
const isItem = (e: End): e is HTMLElement => e instanceof HTMLElement;
interface Link {
  id: string;
  from: End;
  to: End;
  label: string;
  color: string;
  g: SVGGElement;
  text: HTMLElement;
}
const links: Link[] = [];
let selected: Link | null = null;

/** In the minimal interface, a window's rect below its tab, which is hidden unless hovered. Items without a tab
 *  (notes, file chips) and a collapsed window (only its tab) stay whole. */
let tab = 0;
/** The rect an arrow attaches to: an item's (just its tab in the minimal interface, when the tab is hidden) or a
 *  drawing's. */
function endRect(el: End): Rect {
  if (!isItem(el)) {
    const r = strokeRect(el);
    return { ...r, x: r.x + (el.dx ?? 0), y: r.y + (el.dy ?? 0) };
  } // world units, like a canvas window's rect
  const r = liveRect(el);
  if (!minimalUI() || !el.classList.contains('win') || el.classList.contains('min')) return r;
  tab ||= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tab-h')) || 34;
  return { ...r, y: r.y + tab, h: r.h - tab };
}

/** Where an arrow between two rects starts and ends: the sides facing each other, and a gentle curve. */
function curve(ab: Rect, bb: Rect) {
  const ca = { x: ab.x + ab.w / 2, y: ab.y + ab.h / 2 },
    cb = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  const across = Math.abs(cb.x - ca.x) / (ab.w + bb.w) >= Math.abs(cb.y - ca.y) / (ab.h + bb.h); // side by side, or stacked
  const s = across
    ? { x: cb.x > ca.x ? ab.x + ab.w : ab.x, y: ca.y }
    : { x: ca.x, y: cb.y > ca.y ? ab.y + ab.h : ab.y };
  const t = across
    ? { x: cb.x > ca.x ? bb.x - 6 : bb.x + bb.w + 6, y: cb.y }
    : { x: cb.x, y: cb.y > ca.y ? bb.y - 6 : bb.y + bb.h + 6 };
  const d = Math.max(40, (across ? Math.abs(t.x - s.x) : Math.abs(t.y - s.y)) / 2);
  const c1 = across ? { x: s.x + Math.sign(t.x - s.x) * d, y: s.y } : { x: s.x, y: s.y + Math.sign(t.y - s.y) * d };
  const c2 = across ? { x: t.x - Math.sign(t.x - s.x) * d, y: t.y } : { x: t.x, y: t.y - Math.sign(t.y - s.y) * d };
  return { s, c1, c2, t };
}
/** The path (and its arrowhead, aimed along the curve's end) for a curve. */
function shape(k: ReturnType<typeof curve>) {
  const { s, c1, c2, t } = k,
    ang = Math.atan2(t.y - c2.y, t.x - c2.x),
    L = 11,
    W = 0.45;
  const head = `M${t.x + Math.cos(ang) * 4},${t.y + Math.sin(ang) * 4} L${t.x - Math.cos(ang - W) * L},${t.y - Math.sin(ang - W) * L} L${t.x - Math.cos(ang + W) * L},${t.y - Math.sin(ang + W) * L}Z`;
  return {
    line: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`,
    head,
    mid: { x: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8, y: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 },
  };
}

/** Measure first (layout reads), then `write` (DOM writes): so a batch of arrows lays out once, not per arrow. */
function measure(l: Link) {
  const hide = [l.from, l.to].some(e =>
    isItem(e) ? e.classList.contains('full') || hidden(e) : !!e.el?.dataset.hiddenIn,
  );
  const k = hide ? null : shape(curve(endRect(l.from), endRect(l.to)));
  return () => writeLink(l, k);
}
/** Measure an arrow's ends, then draw it. */
const drawLink = (l: Link) => measure(l)();
/** Write an arrow's measured shape into its SVG paths and put its label at the middle; hidden when it has no shape. */
function writeLink(l: Link, k: ReturnType<typeof shape> | null) {
  l.g.style.display = l.text.style.display = k ? '' : 'none';
  if (!k) return;
  const { line, head, mid } = k;
  const [hit, path, tip] = l.g.children as unknown as SVGPathElement[];
  hit.setAttribute('d', line);
  path.setAttribute('d', line);
  tip.setAttribute('d', head);
  l.text.style.left = `${mid.x}px`;
  l.text.style.top = `${mid.y}px`;
  l.text.hidden = !l.label && selected !== l;
}

/** An arrow's SVG: a wide invisible hit path, the line, and its head. */
function group(cls: string) {
  const g = svg.appendChild(document.createElementNS(NS, 'g')) as SVGGElement;
  g.setAttribute('class', cls);
  for (const c of ['hit', 'line', 'tip']) g.appendChild(document.createElementNS(NS, 'path')).setAttribute('class', c);
  return g;
}

/** Draw an arrow from one item or drawing to another, with an optional label (saved with the layout). */
export function addLink(from: End, to: End, label = '', color = 'ink', id: string = uuid()): Link {
  const g = group(`ulink c-${color}`);
  const text = world.appendChild(make('div', 'ulabel'));
  const l: Link = { id, from, to, label, color, g, text };
  idOf(from);
  idOf(to); // a drawing gets its id now, before the ink is next saved
  text.textContent = label;
  // typing its label: Enter or Esc is done, and no key reaches the canvas shortcuts
  text.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      select(null);
    }
  });
  g.addEventListener('pointerdown', e => {
    if (e.button === 0) {
      e.stopPropagation();
      select(l);
    }
  });
  text.addEventListener('pointerdown', e => {
    e.stopPropagation();
    select(l);
  });
  links.push(l);
  drawLink(l);
  changed();
  return l;
}

/** Take an arrow off the canvas. */
function removeLink(l: Link) {
  if (selected === l) select(null);
  l.g.remove();
  l.text.remove();
  links.splice(links.indexOf(l), 1);
  changed();
}

/** An item is leaving (maybe for a moment: a delete that can be undone): its arrows go now. Returns what puts them
 *  back. */
export function dropLinks(el: End) {
  const mine = [
    ...links.filter(l => l.from === el || l.to === el),
    ...((!isItem(el) && lost.get(el)?.splice(0)) || []),
  ];
  mine.forEach(l => links.includes(l) && removeLink(l));
  return () =>
    mine.forEach(l => {
      if (endExists(l.from) && endExists(l.to)) addLink(l.from, l.to, l.label, l.color, l.id);
    });
}

/* ---------- selecting: the label becomes editable, with a delete button ---------- */
const del = iconButton(
  ICON.x,
  'Delete arrow (Delete)',
  () => {
    if (selected) removeLink(selected);
  },
  'udel',
);
del.addEventListener('pointerdown', e => e.stopPropagation()); // else the canvas pan captures the pointer and the click never lands here
/** Select an arrow (its label becomes editable, Delete removes it), or none. */
function select(l: Link | null) {
  if (selected === l) return;
  if (selected) {
    selected.g.classList.remove('on');
    selected.text.classList.remove('on');
    selected.text.contentEditable = 'false';
    selected.label = (selected.text.textContent ?? '').trim();
    selected.text.textContent = selected.label;
    drawLink(selected);
    changed();
  }
  selected = l;
  del.remove();
  if (!l) return;
  l.g.classList.add('on');
  l.text.classList.add('on');
  l.text.contentEditable = 'plaintext-only';
  l.text.dataset.placeholder = 'Label';
  l.text.after(del);
  del.style.left = l.text.style.left;
  del.style.top = l.text.style.top;
  drawLink(l);
}
addEventListener(
  'pointerdown',
  e => {
    if (selected && !(e.target as Element).closest('.ulabel.on, .udel')) select(null);
  },
  true,
);
command({
  label: 'Delete the selected arrow',
  group: 'Selection',
  keys: ['Delete', 'Backspace'],
  when: () => !!selected,
  key: () => removeLink(selected!),
});
command({
  label: 'Deselect the arrow',
  group: 'Selection',
  keys: ['Escape'],
  when: () => !!selected,
  key: () => select(null),
});

/* ---------- drawing one: press on an item, release on another (the Arrow tool in Draw mode) ---------- */
/** The item under a screen point, else a drawing on the canvas itself. */
function itemAt(x: number, y: number): End | null {
  const el = closestAt(x, y, '.item');
  if (el) return el;
  for (const t of document.elementsFromPoint(x, y)) {
    const s = strokes.find(s => !s.host && s.el && (s.el === t || s.el.contains(t))); // a shape's parts are inside its group
    if (s) return s;
  }
  return null;
}

/** Start an arrow from the item under this press; follows the pointer until release. */
export function startLink(e: PointerEvent, color: string, over: HTMLElement) {
  const from = itemAt(e.clientX, e.clientY);
  if (!from) return;
  const g = group(`ulink c-${color} drafting`);
  const [, line, tip] = g.children as unknown as SVGPathElement[];
  /** Follow the pointer with the arrow being drawn, snapping its end to the item under it. */
  const move = (ev: PointerEvent) => {
    const p = toWorld(ev.clientX, ev.clientY),
      to = itemAt(ev.clientX, ev.clientY);
    const k =
      to && to !== from ? curve(endRect(from), endRect(to)) : curve(endRect(from), { x: p.x, y: p.y, w: 0, h: 0 });
    const { line: d, head } = shape(k);
    line.setAttribute('d', d);
    tip.setAttribute('d', head);
  };
  track(
    over,
    e,
    (_x, _y, ev) => move(ev),
    ev => {
      g.remove();
      if (ev.type !== 'pointerup') return; // cancelled (a touch the browser took over): no arrow
      const to = itemAt(ev.clientX, ev.clientY);
      if (to && to !== from) {
        select(addLink(from, to, '', color));
        selected?.text.focus();
      } // type a label now, or just move on
    },
    { keep: true },
  );
  move(e);
}

/* ---------- keeping up, saving, and what Claude sees ---------- */
onUIMode(() => changed()); // tabs shown or hidden: arrows move to the windows' new edges
onChange(viewOnly => {
  if (!viewOnly && waiting.length && performance.now() - tried > 1000) attachWaiting(); // at most once a second: it queries every item
  const todo = [];
  for (const l of [...links]) {
    if (!endExists(l.from) || !endExists(l.to)) {
      waitForEnd(l);
      removeLink(l);
      continue;
    } // an end left the canvas
    if (viewOnly && [l.from, l.to].every(e => !isItem(e) || onCanvas(e))) continue; // world coordinates: a pan or zoom doesn't move it
    todo.push(measure(l));
  }
  todo.forEach(w => w());
});
// arrows whose drawing left before erase() could take them (the eraser removes strokes mid-swipe): dropLinks hands
// them over, so undoing the erase brings them back
const lost = new WeakMap<Stroke, Link[]>();
/** An arrow to a drawing that's gone (erased, maybe undone later) waits for it to come back. */
function waitForEnd(l: Link) {
  for (const e of [l.from, l.to]) if (!isItem(e) && !endExists(e)) lost.set(e, [...(lost.get(e) ?? []), l]);
}
/** Is this arrow end still there? */
const endExists = (e: End) => (isItem(e) ? e.isConnected : strokes.includes(e));
/** An arrow end's id; a drawing gets one the first time it's named. */
const idOf = (e: End) => (isItem(e) ? (e.dataset.id ?? '') : (e.id ??= uuid())); // a drawing gets an id the first time it's named
/** An arrow end by its saved id: an item, else a canvas-level drawing. */
export const endById = (id: string, ids = byIds()): End | undefined =>
  ids.get(id) ?? strokes.find(s => !s.host && s.id === id);
/** Your arrows as Claude reads them (canvas_list): the ids of their ends and their labels. */
export const userLinks = () =>
  links.map(l => ({ from: shortId(idOf(l.from)), to: shortId(idOf(l.to)), ...(l.label ? { label: l.label } : {}) }));
type Saved = { id: string; from: string; to: string; label: string; color: string };
// saved arrows whose ends aren't on the canvas (yet): kept and written back, so a window that comes late (or failed
// to load once) doesn't lose its arrows at the next save; attached when both ends show up
// ponytail: an arrow whose end was deleted in another tab waits forever (a few bytes); prune by age if that grows
let waiting: Saved[] = [],
  tried = 0;
/** Draw the saved arrows whose ends both exist now; the rest wait for their ends to show up. */
function attachWaiting() {
  tried = performance.now();
  const ids = byIds();
  waiting = waiting.filter(s => {
    const a = endById(s.from, ids),
      b = endById(s.to, ids);
    if (a && b) addLink(a, b, s.label, s.color, s.id);
    return !(a && b);
  });
}
persist(
  'links',
  () => [
    ...links.map(l => ({ id: l.id, from: idOf(l.from), to: idOf(l.to), label: l.label, color: l.color })),
    ...waiting,
  ],
  (list: Saved[]) => {
    waiting = list;
    attachWaiting();
  },
  2,
);
