// Selecting several canvas items at once: double-tap and drag on empty canvas (or Shift+drag) draws a selection
// box; Shift/Ctrl+click an item's tab adds or removes it. Dragging a selected item (or, in Select mode, empty canvas
// inside the selection box) moves them all; Delete (or the bar by the selection) removes them, each through its own
// remove path. Only items laid out on the canvas take part: pinned, floating and full-view windows don't.

import { asOneUndoStep } from '../../lib/actions';
import { button, confirmBox, EDITABLE, ICON, iconButton, keepOnScreen, make, toast } from '../../lib/dom';
import { command } from '../../lib/keys';
import { redraw } from '../graph/graph';
import { drawing } from '../ink/ink';
import { eraseStrokes } from '../ink/inkactions';
import { canvasStrokes, inkOf, inkWith, markStroke, objectAt, siblings, strokeMover, strokeRect } from '../ink/inksel';
import type { Stroke } from '../ink/stroke';
import { type Mover, movesWith, moveWith, setMoveAlong, swallowNext, track } from './drag';
import { anyFull } from './fullview';
import { recordItemMoves } from './itemactions';
import { hidden, onCanvas, overlaps, place, placed, type Rect, rect } from './items';
import { handDrag } from './mode';
import { changed, onChange, stage, toWorld, view } from './view';

const sel = new Set<HTMLElement>();
let picks = 0; // bumped on every selection change, windows or drawings (the bar's Group depends on both)
const removers = new Map<string, (el: HTMLElement) => void>(),
  notes = new Map<string, string>();
/** How items of this kind are removed when a selection is deleted, without asking again (the selection asks once).
 *  Kinds that don't register are removed by clicking their own × button; kinds with neither are left alone.
 *  `fn` null: its × still does it. `note`: a line the delete confirmation adds when the selection has this kind
 *  (what removing it really means, e.g. a session's conversation stays in History). */
export const removable = (kind: string, fn: ((el: HTMLElement) => void) | null, note?: string) => {
  if (fn) removers.set(kind, fn);
  if (note) notes.set(kind, note);
};

/** The item's own × (every kind's close/remove button carries .closebtn). */
const closeButton = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>(':scope > .win-h .closebtn, :scope > .closebtn');
/** Can a selection delete remove this item (its kind is removable, or it has a × button)? */
const canRemove = (el: HTMLElement) => removers.has(el.dataset.kind!) || !!closeButton(el);
/** Remove one item the way a selection delete does, without asking (items/group/group.ts deletes a group's windows). */
export function removeItem(el: HTMLElement) {
  setSelected(el, false);
  const fn = removers.get(el.dataset.kind!);
  if (fn) fn(el);
  else closeButton(el)?.click();
}

// drawings on the canvas itself (shapes, text, pen strokes) join the selection too; ink on a window moves with it
const inkSel = new Set<Stroke>();
// the frameless group double-clicked into (Excalidraw's way to pick one drawing of a group): until the selection
// is cleared, its drawings are picked one by one
let inside: string | undefined;
/** A drawing and, when it's in a frameless group we're not inside, the rest of that group. */
const withGroup = (s: Stroke) => (s.g && s.g !== inside ? siblings(s) : [s]); // a group comes whole, unless we're inside it
/** Add a drawing (with its group) to the selection or take it out. */
function setInk(s: Stroke, on: boolean) {
  for (const o of withGroup(s)) {
    if (on) inkSel.add(o);
    else inkSel.delete(o);
    markStroke(o, on);
  }
  picks++;
}
/** The selected items. */
export const selected = () => [...sel];
/** The selected drawings. */
export const selectedInk = () => [...inkSel];
/** Is this drawing in the selection? (canvas/ink/shapes.ts drags the whole selection when you drag one.) */
export const inkSelected = (s: Stroke) => inkSel.has(s);
/** Click on a drawing (shape or text): select just it, or with `add` (Shift) add it to the selection. */
export function selectInk(s: Stroke, add = false) {
  const stay = !!s.g && s.g === inside; // another drawing of the group we're in: still inside
  if (!add) clearSelection();
  if (stay) inside = s.g;
  setInk(s, true);
  syncSelection();
}
const watchers: (() => void)[] = [];
/** Called whenever the selection changes (canvas/ink/shapes.ts frames a single selected shape with its handles). */
export const onSelect = (f: () => void) => watchers.push(f);
/** Move everything selected together, windows and drawings, by a total offset in canvas units; `end()` when done.
 *  Whatever moves with a selected item comes too (a group's windows). */
export function selectionMover(): Mover {
  const els = [...new Set([...sel].filter(el => !el.dataset.locked).flatMap(movesWith))],
    starts = els.map(rect),
    ink = strokeMover([...new Set([...inkSel, ...inkOf(els)])]);
  /** Move the selection by an offset from where it started. */
  const move = (dx: number, dy: number) => {
    els.forEach((el, i) => place(el, starts[i].x + dx, starts[i].y + dy));
    ink(dx, dy);
    if (els.length) redraw();
  };
  // a move like a drag's: 'moved' on each, so what reacts to drags (groups pushing each other aside) reacts to this too
  return Object.assign(move, {
    end: () => {
      asOneUndoStep(() => {
        ink.end();
        recordItemMoves(els, starts);
      });
      changed();
      els.forEach(el => el.dispatchEvent(new CustomEvent('moved', { bubbles: true })));
    },
  });
}
/** Select every item laid out on the canvas (Ctrl/Cmd+A). */
function selectAll() {
  for (const el of placed()) setSelected(el, true);
  for (const s of canvasStrokes()) setInk(s, true);
  syncSelection();
}
/** Add an item to the selection or take it out. */
function setSelected(el: HTMLElement, on: boolean) {
  if (on) sel.add(el);
  else sel.delete(el);
  picks++;
  el.classList.toggle('selected', on);
}
/** Select nothing. */
export function clearSelection() {
  for (const el of [...sel]) setSelected(el, false);
  for (const s of [...inkSel]) setInk(s, false);
  inside = undefined;
  syncSelection();
}
/** Make `el` the whole selection (W steps through windows, so Delete, the arrows and Ctrl+G act on the one it lands on). */
export function selectOnly(el: HTMLElement) {
  clearSelection();
  setSelected(el, true);
  syncSelection();
}
// double-click a grouped drawing: into its group, with just that drawing selected
document.addEventListener(
  'dblclick',
  e => {
    const s = objectAt(e.target as Element);
    if (!s?.g) return;
    e.stopPropagation();
    clearSelection();
    inside = s.g;
    setInk(s, true);
    syncSelection();
  },
  true,
);

moveWith(el => (sel.has(el) ? [...sel] : []));
inkWith(el => (sel.has(el) ? [...inkSel] : []));
// drawings carried by a dragged window or group: no undo step of their own, or Ctrl+Z would move them out from under it
setMoveAlong(el => {
  const ink = inkOf(movesWith(el));
  return ink.length ? strokeMover(ink) : null;
});

/* ---------- the bar by the selection: how many, delete, clear ---------- */
const count = make('span', 'n');
const bar = document.body.appendChild(make('div', 'selbar float'));
bar.setAttribute('role', 'toolbar');
bar.setAttribute('aria-label', 'Selected items');
const del = button('Delete', '', () => {
  removeSelected();
});
bar.append(count, del, iconButton(ICON.x, 'Clear selection (Esc)', clearSelection));
bar.hidden = true;
const actions: { b: HTMLButtonElement; when: (els: HTMLElement[]) => boolean }[] = [];
let shownFor = -1; // the selection the actions were last shown for (its `picks`)
/** A button on the bar by the selection, before Delete (items/group/group.ts: Group, Ungroup). `when`: shown only for
 *  selections it applies to. */
export function selectionAction(
  label: string,
  tip: string,
  fn: () => void,
  when: (els: HTMLElement[]) => boolean = () => true,
) {
  const b = button(label, '', fn);
  b.title = tip;
  bar.insertBefore(b, del);
  actions.push({ b, when });
  return b;
}

// the box round a selection of two or more (like a drawing app's group selection): screen px, so its line stays
// crisp at any zoom; moved with the selection bar on every change
const selbox = stage.appendChild(make('div', 'selbox'));
selbox.hidden = true;
let boxAt = { x0: 0, y0: 0, x1: 0, y1: 0 }; // where selbox is on screen, so hit-testing it reads no layout

/** Show the bar's actions again for the same selection whose meaning changed (its drawings were just grouped). */
export function refreshActions() {
  picks++;
  syncSelection();
}
/** Drop what can't stay selected (removed, pinned, hidden), then update the selection bar, box and watchers. */
function syncSelection() {
  for (const el of [...sel]) if (!el.isConnected || !onCanvas(el) || hidden(el)) setSelected(el, false); // removed, pinned, in full view, in a collapsed group
  for (const s of [...inkSel]) if (!s.el?.isConnected) setInk(s, false); // erased or undone
  watchers.forEach(f => f());
  const n = sel.size + inkSel.size;
  bar.hidden = !n;
  selbox.hidden = n < 2;
  if (!n) return;
  count.textContent = `${n} selected`;
  if (picks !== shownFor) {
    shownFor = picks;
    for (const a of actions) a.b.hidden = !a.when([...sel]);
  } // not on every pan frame
  /** A rect in canvas units, in screen pixels. */
  // above the selection's top-left (on screen), kept on screen; a drawing on a window is measured where it shows
  const screen = (r: Rect) => ({
    x: r.x * view.k + view.x,
    y: r.y * view.k + view.y,
    w: r.w * view.k,
    h: r.h * view.k,
  });
  const rs = [
    ...[...sel].map(el => screen(rect(el))),
    ...[...inkSel].map(s => {
      if (!s.host) return screen(strokeRect(s));
      const b = s.el!.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }),
  ];
  const x0 = Math.min(...rs.map(r => r.x)),
    y0 = Math.min(...rs.map(r => r.y));
  if (n > 1) {
    const x1 = Math.max(...rs.map(r => r.x + r.w)),
      y1 = Math.max(...rs.map(r => r.y + r.h)),
      m = 6;
    boxAt = { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
    selbox.style.cssText = `left:${x0 - m}px;top:${y0 - m}px;width:${x1 - x0 + 2 * m}px;height:${y1 - y0 + 2 * m}px`;
  }
  keepOnScreen(bar, x0, y0 - bar.offsetHeight - 10, 64); // not over the toolbar
}
onChange(syncSelection);

let hinted = -1e9;
/** Why a locked item didn't move (a nudge, a drag on a locked group's tab): once per toast, not per key repeat. */
export function lockedHint() {
  if (performance.now() - hinted < 6000) return;
  hinted = performance.now();
  toast('Locked in place: unlock it (its pin button) to move it');
}

/** "1 item", "3 items". */
const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

/** Delete the selection: asks first when it holds more than one thing, and says what stays (locked items, ones with
 *  no ×). */
async function removeSelected() {
  const all = [...sel],
    gone = all.filter(el => canRemove(el) && !el.dataset.locked),
    kept = all.length - gone.length,
    ink = [...inkSel];
  if (!gone.length && !ink.length) return;
  /** Take the selected drawings off (one action Undo can bring back). */
  const drop = () => {
    ink.forEach(s => setInk(s, false));
    eraseStrokes(...ink);
  };
  if (!gone.length) {
    // drawings only: one goes like the eraser; more ask first
    if (ink.length === 1 || (await confirmBox(`Delete ${ink.length} drawings?`, 'Ctrl+Z brings them back.', 'Delete')))
      drop();
    syncSelection();
    return;
  }
  const said = [...new Set(gone.map(el => notes.get(el.dataset.kind!)).filter(Boolean))].join(' ');
  const left = kept ? `${plural(kept)} stay${kept === 1 ? 's' : ''}: locked, or not removable this way.` : '';
  if (
    !(await confirmBox(
      `Delete ${plural(gone.length + ink.length)}?`,
      `${said} ${left}`.trim() || 'They are removed from the canvas.',
      'Delete',
    ))
  )
    return;
  asOneUndoStep(() => {
    drop();
    for (const el of gone) removeItem(el);
  }); // one Ctrl+Z brings the whole selection back
  syncSelection();
  changed();
}

/* ---------- picking: Shift/Ctrl+click an item's tab (or a bare node like a note) ---------- */
document.addEventListener(
  'pointerdown',
  e => {
    if (e.button !== 0 || !(e.shiftKey || e.ctrlKey || e.metaKey) || drawing) return;
    const t = e.target as Element,
      el = t.closest<HTMLElement>('#world > .item');
    if (!el || t.closest(`button, a, ${EDITABLE}`)) return;
    if (el.classList.contains('win') && !t.closest('.win-h')) return; // inside a window's body: its own clicks
    e.preventDefault();
    e.stopPropagation(); // not a drag
    setSelected(el, !sel.has(el));
    syncSelection();
  },
  true,
);

/* ---------- the selection box: drag on empty canvas in Select mode; in Hand mode double-tap and drag (or Shift+drag) ---------- */
const box = stage.appendChild(make('div', 'marquee'));
box.hidden = true;
/** Is this the empty canvas (not an item)? */
const isEmptyCanvas = (t: Element) => t === stage || t.matches('#world, #edges, #inkworld');
/** Does a press here start a selection box? */
// a group's empty space (.frame) drags the group; Shift+drag there draws a selection box
const boxFrom = (t: Element, e: PointerEvent) => isEmptyCanvas(t) || (e.shiftKey && t.classList.contains('frame'));
/** Is rect `a` entirely inside rect `b`? */
const isWithin = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
let last = { t: 0, x: 0, y: 0 };

/** Is the pointer inside the selection's box? */
const inSelbox = (e: PointerEvent) =>
  !selbox.hidden && e.clientX >= boxAt.x0 && e.clientX <= boxAt.x1 && e.clientY >= boxAt.y0 && e.clientY <= boxAt.y1;
// the box itself lets clicks through to the windows in it, so the stage shows the move cursor over its empty canvas
stage.addEventListener('pointermove', e => {
  if (e.buttons) return;
  stage.classList.toggle('movesel', !drawing && !handDrag() && isEmptyCanvas(e.target as Element) && inSelbox(e));
});
/** A press on empty canvas inside the selection box drags the whole selection, like a drawing app; a click clears it. */
function dragSelection(e: PointerEvent) {
  const move = selectionMover();
  let moved = false;
  track(
    stage,
    e,
    (dx, dy) => {
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      move(dx / view.k, dy / view.k);
      changed(); // the box, the bar and other items' arrows follow
    },
    () => {
      if (moved) move.end();
      else clearSelection();
    },
  );
}

stage.addEventListener(
  'pointerdown',
  e => {
    const t = e.target as Element;
    if (e.button !== 0 || drawing || !boxFrom(t, e)) return;
    const again = e.timeStamp - last.t < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 24;
    last = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    if (!again && !e.shiftKey && handDrag()) {
      /** The press ends: a click (no drag) clears the selection. */
      // Hand mode (or Space held): a plain press pans; if it's a click (no drag), it clears the selection
      const up = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) clearSelection();
      };
      addEventListener('pointerup', up, { once: true });
      return;
    }
    e.stopImmediatePropagation(); // not a pan
    e.preventDefault(); // and not a text selection: selected note text would turn the next drag into the browser's own
    // which also cancels the browser's own blur, so a message box would keep focus and take the next shortcut key
    if (document.activeElement instanceof HTMLElement && document.activeElement.matches(EDITABLE))
      document.activeElement.blur();
    getSelection()?.removeAllRanges();
    if (!again && !e.shiftKey && inSelbox(e)) {
      dragSelection(e);
      return;
    }
    const start = toWorld(e.clientX, e.clientY),
      before = e.shiftKey ? new Set(sel) : new Set<HTMLElement>();
    const inkBefore = e.shiftKey ? new Set(inkSel) : new Set<Stroke>();
    const candidates = placed().map(el => ({ el, r: rect(el) })),
      drawings = canvasStrokes();
    let moved = false;
    track(
      stage,
      e,
      (_x, _y, ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        moved = true;
        const x0 = Math.min(e.clientX, ev.clientX),
          y0 = Math.min(e.clientY, ev.clientY);
        box.hidden = false;
        box.style.cssText = `left:${x0}px;top:${y0}px;width:${Math.abs(ev.clientX - e.clientX)}px;height:${Math.abs(ev.clientY - e.clientY)}px`;
        const p = toWorld(ev.clientX, ev.clientY);
        const m: Rect = {
          x: Math.min(start.x, p.x),
          y: Math.min(start.y, p.y),
          w: Math.abs(p.x - start.x),
          h: Math.abs(p.y - start.y),
        };
        let changes = 0;
        for (const { el, r } of candidates) {
          const on = before.has(el) || (el.classList.contains('frame') ? isWithin(r, m) : overlaps(r, m, 0)); // a frame: only when it's all in the box
          if (on !== sel.has(el)) {
            setSelected(el, on);
            changes++;
          } // only what crossed the box's edge
        }
        const inBox = new Set(canvasStrokes(m, drawings).flatMap(withGroup)); // one drawing of a group in the box: all of it
        for (const s of new Set([...inkSel, ...inBox])) {
          const on = inkBefore.has(s) || inBox.has(s);
          if (on !== inkSel.has(s)) {
            setInk(s, on);
            changes++;
          }
        }
        if (changes) syncSelection();
      },
      () => {
        box.hidden = true;
        if (!moved) {
          if (!again && !e.shiftKey) clearSelection();
          return;
        } // a click clears; a double-click still makes a note
        swallowNext('dblclick', 400); // a double-tap-drag's own dblclick mustn't make a note
      },
    );
  },
  true,
);

const notDrawing = () => !drawing;
/** Is anything selected (outside Draw mode, whose keys these are not)? */
const any = () => !drawing && (!!sel.size || !!inkSel.size);
command({ label: 'Select all', group: 'Selection', keys: ['$mod+a'], when: notDrawing, key: selectAll });
// arrow keys nudge the selection (Shift: 10px), like Excalidraw
const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
command({
  label: 'Nudge the selection (Shift: 10px)',
  group: 'Selection',
  keys: Object.keys(NUDGE).map(k => `[Shift]+${k}`),
  when: any,
  key: e => {
    if ([...sel].some(el => el.dataset.locked)) lockedHint();
    const [dx, dy] = NUDGE[e.key],
      step = e.shiftKey ? 10 : 1;
    const m = selectionMover();
    m(dx * step, dy * step);
    m.end();
  },
});
command({
  label: 'Delete the selection',
  group: 'Selection',
  keys: ['Delete', 'Backspace'],
  when: any,
  key: () => void removeSelected(),
});
// full view backs out first
command({
  label: 'Clear the selection',
  group: 'Selection',
  keys: ['Escape'],
  when: () => any() && !anyFull(),
  key: clearSelection,
});
