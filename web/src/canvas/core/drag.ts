// Dragging: moving items (and what moves with them), resize grips, edge grips on side panels, dragging something
// out of a window onto the canvas, and `track()`, the one pointer-press follower they all use.

import { asOneUndoStep } from '../../lib/actions';
import { EDITABLE, make, perFrame } from '../../lib/dom';
import { positionAndSizeStyles, recordItemMoves, recordItemResize } from './itemactions';
import { bringToFront, onCanvas, place, rect } from './items';
import { changed, toWorld, view } from './view';

/** Asked while an item is dragged (final=false, to highlight a target) and when it's released (final=true).
 *  Return true if the pointer is over something that takes the item: on release it then snaps back to where it was. */
type DropHandler = (el: HTMLElement, x: number, y: number, final: boolean) => boolean;
let dropHandler: DropHandler | undefined;
/** Register the one drop handler (a session card's message box takes items dropped on it). */
export const onDrop = (f: DropHandler) => {
  dropHandler = f;
};

/** What else moves when an item is dragged. Each registered function answers for one item: canvas/core/select.ts (the
 *  selection it's in), items/group/group.ts (a group's windows). */
const withs: ((el: HTMLElement) => HTMLElement[])[] = [];
/** Register what else moves when an item is dragged: `f(el)` returns the items that come along with `el`. */
export const moveWith = (f: (el: HTMLElement) => HTMLElement[]) => {
  withs.push(f);
};
/** `el` and everything that moves with it, followed through: a selected group brings its windows along. */
export function movesWith(el: HTMLElement): HTMLElement[] {
  const all = new Set([el]);
  // a Set's loop also visits what's added; a locked item (data-locked: a pinned group) stays put
  for (const x of all) for (const f of withs) for (const y of f(x)) if (!y.dataset.locked) all.add(y);
  return [...all];
}
/** Moves things by a total offset in canvas units while a drag runs; `end()` settles them when it's over. */
export type Mover = ((dx: number, dy: number) => void) & { end: () => void };
/** Anything else that moves with `el`'s group (selected drawings): called when a drag starts, returns a mover or null. */
let moveAlong: (el: HTMLElement) => Mover | null = () => null;
/** Register what moves along with an item's group that isn't an item (the selected drawings). */
export const setMoveAlong = (f: typeof moveAlong) => {
  moveAlong = f;
};

/** Drag `el` by `handle` (with the rest of the selection, if it's selected). A press that doesn't move counts as a click.
 *  `when`: only presses it accepts drag (a group's empty space: not while Shift draws a selection box). */
export function draggable(
  el: HTMLElement,
  handle: HTMLElement,
  onMove: () => void,
  onClick?: () => void,
  when?: (e: PointerEvent) => boolean,
) {
  /** Is the press on a control of the window's own (a button, a link, the chat log, a text field)? Those don't drag
   *  it. */
  const own = (e: Event) => (e.target as Element).closest(`button, a, .log, .compose, ${EDITABLE}`);
  // pressing the handle leaves focus in a box marked data-keep-focus (a file or scratchpad being edited): typing carries on after a
  // drag. A message box still loses it, so a click on its card's tab makes the next key a shortcut again.
  handle.addEventListener('mousedown', e => {
    if (e.button === 0 && !own(e) && el.contains(document.activeElement?.closest('[data-keep-focus]') ?? null))
      e.preventDefault();
  });
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !onCanvas(el) || own(e) || (when && !when(e))) return;
    e.stopPropagation();
    bringToFront(el);
    const sx = e.clientX,
      sy = e.clientY,
      o = rect(el);
    // (off the canvas too: a pinned window's canvas spot, what it comes back to, moves with its group)
    const group = movesWith(el).filter(g => g !== el),
      starts = group.map(rect),
      along = moveAlong(el);
    const alone = !group.length && !along; // a group isn't dropped onto a card
    let moved = false,
      done = false;
    /** One pointer move during a drag: places the dragged items and asks the drop handler about the spot. */
    // the pointer is captured only once it really drags: capturing on press would re-target a double-click to the
    // handle, and the tab's title couldn't be double-clicked to rename it. Until then the window follows the pointer.
    const step = (ev: PointerEvent) => {
      if (done) return;
      const dx = ev.clientX - sx,
        dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        handle.setPointerCapture(ev.pointerId);
        getSelection()?.removeAllRanges();
      } // a drag, not a text selection
      moved = true;
      el.classList.add('dragging');
      place(el, o.x + dx / view.k, o.y + dy / view.k);
      group.forEach((g, i) => place(g, starts[i].x + dx / view.k, starts[i].y + dy / view.k));
      along?.(dx / view.k, dy / view.k);
      if (alone) dropHandler?.(el, ev.clientX, ev.clientY, false);
      onMove();
      if (!alone) changed(); // other items' arrows follow too
    };
    /** Place the dragged items once a frame. */
    const move = perFrame(step); // high-rate mice send several moves a frame: place and hit-test once
    /** The drag ends: settle the items, hand a lone item to the drop handler, or count a press that didn't move as a
     *  click. */
    const up = (ev: PointerEvent) => {
      if (ev.type === 'pointerup') step(ev); // where the pointer really ended (a pointercancel's coordinates are 0,0)
      done = true;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      if (moved && alone && dropHandler?.(el, ev.clientX, ev.clientY, true)) {
        place(el, o.x, o.y);
        onMove();
      }
      if (moved)
        asOneUndoStep(() => {
          along?.end();
          recordItemMoves([el, ...group], [o, ...starts]);
        });
      else along?.end();
      if (moved) {
        changed();
        el.dispatchEvent(new CustomEvent('moved', { bubbles: true }));
      } // e.g. taken out of a gathered pile
      else if (ev.type === 'pointerup') onClick?.(); // a cancelled touch isn't a click
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
}

/** A grip on a right-docked panel's left edge: drag to widen it (min `minW`, and never past the screen). */
export function edgeGrip(panel: HTMLElement, minW: number, onMove?: () => void, onEnd?: () => void) {
  const grip = panel.appendChild(make('div', 'edge-grip'));
  grip.title = 'Drag to resize';
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const w = panel.offsetWidth;
    panel.classList.add('resizing');
    track(
      grip,
      e,
      dx => {
        panel.style.width = `${Math.min(innerWidth - 24, Math.max(minW, w - dx))}px`;
        onMove?.();
      },
      () => {
        panel.classList.remove('resizing');
        onEnd?.();
      },
    );
  });
}

/** Follow one pointer press on `handle`: move(dx, dy, ev) in screen px, end(ev) on release or cancel (check
 *  `ev.type`: a cancelled press's coordinates are 0,0). Options: `keep` leaves the press's default and propagation
 *  alone (a canvas press should still blur what's focused); `every` sees every move, not one per frame (pen ink);
 *  `late` captures the pointer only once it really drags (a title under the handle can still be double-clicked:
 *  capturing on press sends the double-click to the handle). */
export function track(
  handle: Element,
  e: PointerEvent,
  move: (dx: number, dy: number, ev: PointerEvent) => void,
  end?: (ev: PointerEvent) => void,
  o: { keep?: boolean; every?: boolean; late?: boolean } = {},
) {
  if (!o.keep) {
    e.preventDefault();
    e.stopPropagation();
  }
  const sx = e.clientX,
    sy = e.clientY,
    id = e.pointerId,
    on: EventTarget = o.late ? window : handle; // uncaptured: moves go elsewhere
  let done = false,
    held = !o.late;
  if (held) handle.setPointerCapture(id);
  /** One pointer move: ignored until it has really moved (late capture), then passed on as an offset from the press. */
  const step = (ev: PointerEvent) => {
    if (done || ev.pointerId !== id) return;
    if (!held && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    if (!held) {
      handle.setPointerCapture(id);
      held = true;
    }
    move(ev.clientX - sx, ev.clientY - sy, ev);
  };
  // once a frame (high-rate mice send several moves per frame); nothing after the end, which applies the last one
  const mv = (o.every ? step : perFrame(step)) as (ev: Event) => void;
  /** The press ends (released or cancelled): apply the last move and stop listening. */
  const up = (ev: Event) => {
    const p = ev as PointerEvent;
    if (done || p.pointerId !== id) return;
    if (ev.type === 'pointerup' && held) move(p.clientX - sx, p.clientY - sy, p); // where it really ended
    done = true;
    on.removeEventListener('pointermove', mv);
    on.removeEventListener('pointerup', up);
    on.removeEventListener('pointercancel', up);
    end?.(p);
  };
  on.addEventListener('pointermove', mv);
  on.addEventListener('pointerup', up);
  on.addEventListener('pointercancel', up);
}

/** Drag something out of a window onto the canvas. Past a few px, `create(x, y)` makes the new item at the
 *  pointer (held at `grab`, e.g. by its tab), and it follows the pointer. The click ending a drag is swallowed,
 *  so a row that toggles on click doesn't toggle too. Returns nothing: a press that doesn't move stays a click. */
export function dragOut(
  handle: HTMLElement,
  e: PointerEvent,
  create: (x: number, y: number) => HTMLElement,
  grab = { x: 60, y: 17 },
) {
  let node: HTMLElement | undefined;
  track(
    handle,
    e,
    (dx, dy) => {
      if (!node && Math.hypot(dx, dy) < 8) return;
      const p = toWorld(e.clientX + dx, e.clientY + dy);
      if (!node) {
        node = create(p.x - grab.x, p.y - grab.y);
        node.classList.add('dragging');
      }
      place(node, p.x - grab.x, p.y - grab.y);
    },
    () => {
      if (!node) return;
      node.classList.remove('dragging');
      changed();
      swallowNext('click', 0); // the drag's closing click; none came: don't eat the next one
    },
  );
}

/** Eat the next `type` event page-wide (the one a gesture ends with), unless none comes within `ms`. */
export function swallowNext(type: string, ms: number) {
  /** Swallow the event: nothing else on the page sees it. */
  const eat = (ev: Event) => {
    ev.stopImmediatePropagation();
    ev.preventDefault();
  };
  addEventListener(type, eat, { capture: true, once: true });
  setTimeout(() => removeEventListener(type, eat, { capture: true }), ms);
}

/** Resize grips on the left, right and bottom edges and all four corners (the top edge is the tab, which drags), in
 *  world units so they track the pointer at any zoom. The left and top sides move the window too, so the opposite
 *  edge stays put. `widthOnly`: the height follows the content (text notes): only the sides and the bottom corners,
 *  for width. `aspect`: the content's width/height while it has one (a picture): the window keeps its shape, the
 *  width deciding on corners and side edges, the height on the bottom edge. */
export function resizable(
  el: HTMLElement,
  minW: number,
  minH: number,
  onResize: () => void,
  widthOnly = false,
  aspect?: () => number | undefined,
) {
  const edges = widthOnly ? ['e', 'w', 'se', 'sw'] : ['e', 'w', 's', 'se', 'sw', 'ne', 'nw'];
  for (const edge of edges) {
    const grip = el.appendChild(make('div', 'grip'));
    grip.dataset.edge = edge;
    grip.title = 'Drag to resize';
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      bringToFront(el);
      const w = el.offsetWidth,
        h = el.offsetHeight,
        k = onCanvas(el) ? view.k : 1; // floating: not scaled
      const x = parseFloat(el.style.left) || 0,
        fx = parseFloat(el.style.getPropertyValue('--fx')) || 0;
      const y = parseFloat(el.style.top) || 0,
        fy = parseFloat(el.style.getPropertyValue('--fy')) || 0;
      const left = edge.includes('w'),
        right = edge.includes('e'),
        down = edge.includes('s') && !widthOnly,
        up = edge.includes('n') && !widthOnly;
      const ar = widthOnly ? undefined : aspect?.(),
        body = el.querySelector<HTMLElement>(':scope > .win-b');
      const bw = body ? w - body.clientWidth : 0,
        ex = body ? h - body.clientHeight : 0; // the window around the content
      el.style.setProperty('--resize-cursor', getComputedStyle(grip).cursor); // before .resizing overrides it: a side edge stays ew/ns
      el.classList.add('resizing');
      const from = positionAndSizeStyles(el);
      track(
        grip,
        e,
        (dx, dy) => {
          let nw = Math.max(minW, Math.round(w + (right ? dx : left ? -dx : 0) / k));
          let nh = Math.max(minH, Math.round(h + (down ? dy : up ? -dy : 0) / k));
          if (ar) {
            if (!left && !right) nw = Math.max(minW, Math.round((nh - ex) * ar + bw)); // the bottom edge: the width follows
            nh = Math.round((nw - bw) / ar + ex);
            if (nh < minH) {
              nh = minH;
              nw = Math.round((nh - ex) * ar + bw);
            }
          }
          const floating = el.classList.contains('floating');
          if (left || right || ar) el.style.width = `${nw}px`;
          if (left) {
            if (floating) el.style.setProperty('--fx', `${Math.round(fx + w - nw)}px`);
            else el.style.left = `${Math.round(x + w - nw)}px`;
          }
          if (down || up || ar) el.style.height = `${nh}px`;
          if (up) {
            if (floating) el.style.setProperty('--fy', `${Math.round(fy + h - nh)}px`);
            else el.style.top = `${Math.round(y + h - nh)}px`;
          }
          onResize();
        },
        () => {
          el.classList.remove('resizing');
          el.style.removeProperty('--resize-cursor');
          recordItemResize(el, from);
          changed();
        },
      );
    });
  }
}
