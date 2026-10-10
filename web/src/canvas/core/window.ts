// biome-ignore-all assist/source/organizeImports: import order here is evaluation order, which sets registration order (see CLAUDE.md)
// Windows on the canvas (session cards, terminals, diagrams, sketches, plans) share one shape: a folder.
// The header is a tab on the top-left that carries the title and the window's buttons; the body sits under it.
// Drag by the tab, double-click it (or its – button) to collapse the window down to the tab, resize from the corner.
import { make, ICON, iconButton, button, notice, copyButton } from '../../lib/dom';
import { addItem, place, bringToFront, park, drop, byIds, type Rect } from './items';
import { defineAction, recordActions } from '../../lib/actions';
import { draggable, resizable } from './drag';
import { changed, onChange, view } from './view';
import { redraw, forget } from '../graph/graph';
import { dropLinks } from '../graph/links';
import { toggleDock, toggleFloat, syncPin } from './dock';
import { toggleFull, syncFull } from './fullview';
import { refIcon, refOf, winTitle, copyOf } from './refs';
import { tipText } from '../../lib/tooltip';
import { type ItemCollapse, ItemActionType, type ItemRemove, type ItemRename } from '../../types/canvas';

interface WindowOpts {
  kind: string; // data-kind: minimap color, saved layout, references
  cls: string; // the window's own class, for its content styles
  title: string;
  rect: Rect;
  minW: number;
  minH: number;
  actions?: HTMLElement[]; // buttons at the tab's end (the collapse button goes before them)
  aspect?: () => number | undefined; // the content's width/height, when the window should keep that shape while resized
  onChange?: () => void; // after it moves, resizes or collapses (default: re-route the edges)
}
export { winTitle }; // its home is refs.ts
/** What to call any canvas item: its window title, else its reference label, else its title attribute. */
export const titleOf = (el: HTMLElement) => (winTitle(el) || refOf(el)?.label || tipText(el)).trim();
// each window's collapse toggle; `byUser`: the user did it (an action undo can take back), not something that
// follows from another change (a session folding its windows, full view, a restore)
const collapseToggles = new WeakMap<HTMLElement, (byUser: boolean) => void>();
/** Open a collapsed window. */
export const expand = (el: HTMLElement) => {
  if (el.classList.contains('min')) collapseToggles.get(el)?.(false);
};
/** Collapse an open window to its tab. */
export const collapse = (el: HTMLElement) => {
  if (!el.classList.contains('min')) collapseToggles.get(el)?.(false);
};
/** Collapse or expand a window as the user's own action (M, the menu): undo can take it back. */
export const toggleCollapse = (el: HTMLElement) => collapseToggles.get(el)?.(true);
defineAction<ItemCollapse>(ItemActionType.Collapse, {
  apply: action => {
    const item = byIds().get(action.id);
    if (!item || item.classList.contains('min') === action.min) return false;
    collapseToggles.get(item)?.(false);
    return true;
  },
  invert: action => ({ ...action, min: !action.min }),
});
/** Put the cursor in a window's message box, if it has one. */
export const focusInput = (el: HTMLElement) =>
  el.querySelector<HTMLTextAreaElement>('.compose textarea')?.focus({ preventScroll: true });
/** Rename a window: its tab, plus a `rename` event for kinds that keep their title elsewhere (a session's title, a
 *  plan's name, an image's alt text). Use this, not the tab's textContent, so they stay in step. */
export function setTitle(el: HTMLElement, name: string) {
  const t = el.querySelector(':scope > .win-h .t');
  if (!t || t.textContent === name) return;
  t.textContent = name;
  el.dispatchEvent(new CustomEvent('rename', { detail: name }));
  changed();
}

defineAction<ItemRename>(ItemActionType.Rename, {
  apply: action => {
    const item = byIds().get(action.id);
    if (!item) return false;
    setTitle(item, action.to);
    return true;
  },
  invert: action => ({ ...action, from: action.to, to: action.from }),
});

/** The × that takes an item off the canvas: its arrows go, it's removed, the layout is saved, and a toast offers
 *  Undo for a few seconds. `also`: the kind's own cleanup (stored data), run once Undo is no longer offered. Finds its
 *  item when clicked, so it can be made before the window exists. */
export function removeButton(label: string, also?: (el: HTMLElement) => void, cls = '') {
  const b: HTMLButtonElement = iconButton(
    ICON.x,
    label,
    () => {
      const el = b.closest<HTMLElement>('.item');
      if (el) removeUndoably(el, also);
    },
    `closebtn${cls ? ` ${cls}` : ''}`,
  ); // closebtn: how a multi-select delete finds each item's own way out
  return b;
}

// Resize grips are in world units, so at 15% zoom they're a pixel wide: widen them by 1/zoom (twice that for a
// finger), in half steps, through one rule of their own: a zoom restyles only the grips, and only now and then.
const grips = new CSSStyleSheet(),
  finger = matchMedia('(pointer: coarse)');
document.adoptedStyleSheets = [...document.adoptedStyleSheets, grips];
let gs = 0;
onChange(() => {
  const f = finger.matches ? 2 : 1,
    g = Math.max(1, Math.round(2 / view.k) / 2) * f;
  if (g !== gs) grips.replaceSync(`.grip{--gs:${f}} #world .grip{--gs:${(gs = g)}}`); // floating windows aren't zoomed
});

/** Take an item off the canvas for good, with no Undo: one the app put there for the moment (a find references peek). */
export function removeQuietly(el: HTMLElement) {
  forget(el);
  dropLinks(el);
  park(el);
  drop(el);
  changed();
}

// what the Undo toast would bring back: everything removed while it shows (a deleted selection is one undo)
let undo: {
  toast: HTMLElement;
  timer: number;
  items: { el: HTMLElement; back: () => void; also?: (el: HTMLElement) => void }[];
} | null = null;
/** Take an item off the canvas with an Undo toast (removeButton's ×; a group's frame deleted with a selection), as an
 *  action: Ctrl+Z brings it back too, while the toast's Undo still could. */
export function removeUndoably(item: HTMLElement, cleanup?: (el: HTMLElement) => void) {
  takeOff(item, cleanup);
  recordActions({ type: ItemActionType.Remove, id: item.dataset.id! });
}
const cleanups = new WeakMap<HTMLElement, (el: HTMLElement) => void>(); // a removed item's own cleanup, for a redo
/** Take an item off the canvas, parked: the Undo toast can put it back until it times out. */
function takeOff(item: HTMLElement, cleanup?: (el: HTMLElement) => void) {
  const putArrowsBack = forget(item);
  const putLinksBack = dropLinks(item);
  const putItemBack = park(item);
  if (cleanup) cleanups.set(item, cleanup);
  changed();
  if (!undo) {
    const toast = notice(''); // stacks with the other notices (lib/dom.ts)
    toast.classList.add('undo');
    undo = { toast, timer: 0, items: [] };
  }
  undo.items.push({
    el: item,
    also: cleanup,
    back: () => {
      putItemBack();
      putArrowsBack();
      putLinksBack();
    },
  });
  sayDeleted();
  clearTimeout(undo.timer);
  undo.timer = setTimeout(() => settle(false), 8000);
}
/** The Undo toast's text: how many items it would bring back. */
function sayDeleted() {
  const deleted = undo!.items.length;
  undo!.toast.replaceChildren(
    make('span', '', deleted === 1 ? 'Deleted' : `Deleted ${deleted} items`),
    button('Undo', '', () => settle(true)),
  );
}
defineAction<ItemRemove>(ItemActionType.Remove, {
  apply: action => {
    const item = byIds().get(action.id);
    if (!item) return false;
    takeOff(item, cleanups.get(item));
    return true;
  },
  invert: action => ({ ...action, type: ItemActionType.Restore }),
});
// only while the Undo toast still holds it: once that times out, its stored data is gone and it can't come back
defineAction<ItemRemove>(ItemActionType.Restore, {
  apply: action => {
    const index = undo?.items.findIndex(entry => entry.el.dataset.id === action.id) ?? -1;
    if (index < 0) return false;
    undo!.items.splice(index, 1)[0].back();
    if (undo!.items.length) sayDeleted();
    else {
      clearTimeout(undo!.timer);
      undo!.toast.remove();
      undo = null;
    }
    changed();
    return true;
  },
  invert: action => ({ ...action, type: ItemActionType.Remove }),
});
/** Whether `el` was deleted and Undo can still bring it back. */
export const undoable = (el: HTMLElement) => !!undo?.items.some(it => it.el === el);
/** End the delete Undo: put the windows back (`back`) or let them go for good. */
function settle(back: boolean) {
  if (!undo) return;
  const { toast, timer, items } = undo;
  undo = null;
  clearTimeout(timer);
  toast.remove();
  for (const it of items) {
    if (back) it.back();
    else {
      drop(it.el);
      it.also?.(it.el);
    }
  }
  changed(); // either way: a group dropping a gone member (onGone) saves too
}
addEventListener('pagehide', () => settle(false)); // leaving: the deletes stand, so their stored data goes too

interface Win {
  el: HTMLElement;
  head: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
}
let titles = 0;

/** A window on the canvas: the folder tab with its title and buttons, a body, dragging, collapsing and resizing. */
export function makeWindow(o: WindowOpts): Win {
  const el = make('div', `win ${o.cls}`),
    head = make('header', 'win-h'),
    title = make('span', 't', o.title),
    body = make('div', 'win-b');
  title.dataset.glyph = refIcon(o.kind); // the tab's glyph is the kind's icon (see referable)
  // a landmark named by its tab, so a screen reader hears "Scratchpad, region" before its Collapse and Close buttons;
  // labelledby, not a label: kinds rename the tab directly too (a session's title)
  title.id = `win-t${++titles}`;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-labelledby', title.id);
  head.append(title, ...(o.actions ?? []));
  el.append(head, body);
  addItem(el, o.kind);
  place(el, o.rect.x, o.rect.y);
  el.style.width = `${o.rect.w}px`;
  el.style.height = `${o.rect.h}px`;
  bringToFront(el);
  const onChange = o.onChange ?? redraw;
  draggable(el, head, onChange);
  minimizable(el, head, onChange, !!o.rect.min);
  head.insertBefore(make('span', 'spacer'), head.querySelector(':scope > .minbtn'));
  // stick to screen, pin and full view: in a strip just outside the tab, so showing them on hover never moves
  // minimize and close (a narrow tab would otherwise shrink its title and shift them)
  const extra = head.appendChild(make('span', 'win-x')).appendChild(make('span'));
  const moves = [
    iconButton(ICON.float, '', () => toggleFloat(el), 'floatbtn'),
    iconButton(ICON.pin, '', () => toggleDock(el), 'pinbtn'),
    iconButton(ICON.full, '', () => toggleFull(el), 'fullbtn'),
  ];
  // a mouse click leaves focus where it was: typing in the window (a file being edited) carries on wherever it goes
  for (const b of moves) b.onmousedown = e => e.preventDefault();
  extra.append(...moves);
  const copy = copyOf(o.kind);
  if (copy) extra.prepend(copyButton(() => copy(el)));
  syncPin(el);
  syncFull(el);
  resizable(el, o.minW, o.minH, onChange, false, o.aspect);
  renamable(el, title);
  return { el, head, title, body };
}

/** Double-click the title to rename the window (Enter saves, Esc cancels). The new name goes out as a `rename`
 *  event, for kinds that keep their title elsewhere (a session's title, a plan's name across versions). */
function renamable(el: HTMLElement, t: HTMLElement) {
  t.title = 'Double-click or F2 to rename';
  t.addEventListener('dblclick', e => {
    e.stopPropagation();
    rename(el);
  });
}
/** Edit a window's title in place (its tab's double-click, or F2). */
export function rename(el: HTMLElement) {
  const t = el.querySelector<HTMLElement>(':scope > .win-h .t');
  if (!t || t.isContentEditable) return;
  const before = t.textContent ?? '';
  t.contentEditable = 'plaintext-only';
  t.classList.add('renaming');
  t.focus();
  getSelection()?.selectAllChildren(t);
  /** Finish renaming: keep the new title (`keep`, when it isn't empty) or put the old one back. */
  const done = (keep: boolean) => {
    t.removeEventListener('keydown', key);
    t.contentEditable = 'false';
    t.classList.remove('renaming');
    const name = (t.textContent ?? '').replace(/\s+/g, ' ').trim();
    t.textContent = before;
    if (!keep || !name || name === before) return;
    setTitle(el, name);
    recordActions({ type: ItemActionType.Rename, id: el.dataset.id!, from: before, to: name });
  };
  /** Keys while renaming: Enter keeps the title, Esc puts the old one back. */
  const key = (k: KeyboardEvent) => {
    k.stopPropagation(); // typing isn't a canvas shortcut
    if (k.key === 'Enter') {
      k.preventDefault();
      t.blur();
    } else if (k.key === 'Escape') {
      k.preventDefault();
      done(false);
    }
  };
  t.addEventListener('keydown', key);
  t.addEventListener(
    'blur',
    () => {
      if (t.isContentEditable) done(true);
    },
    { once: true },
  );
}

/** Collapse a window to its tab. `start` restores a saved collapse. */
function minimizable(el: HTMLElement, head: HTMLElement, onToggle: () => void, start: boolean) {
  const b = make('button', 'icon minbtn');
  /** Make the collapse button say what it does now. */
  const sync = () => {
    const min = el.classList.contains('min');
    b.innerHTML = min ? ICON.open : ICON.collapse;
    b.title = min ? 'Expand (M)' : 'Collapse (M)';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-expanded', String(!min));
  };
  /** Collapse the window to its tab, or expand it again (it remembers its full height). */
  const toggle = (byUser: boolean) => {
    if (!el.classList.contains('min')) el.dataset.fullH = String(el.offsetHeight);
    const min = el.classList.toggle('min');
    sync();
    onToggle();
    changed();
    el.dispatchEvent(new CustomEvent('collapse', { detail: min, bubbles: true })); // e.g. a session takes its windows along
    if (byUser) recordActions({ type: ItemActionType.Collapse, id: el.dataset.id!, min });
  };
  collapseToggles.set(el, toggle);
  // a click from code (a session folding its windows along) follows from another change: not one to undo
  b.onclick = event => {
    event.stopPropagation();
    toggle(event.isTrusted);
  };
  head.addEventListener('dblclick', e => {
    if (!(e.target as Element).closest('button, input, .t')) toggle(true);
  }); // the title renames instead
  head.insertBefore(b, head.querySelector(':scope > button'));
  if (start) {
    el.dataset.fullH = String(parseFloat(el.style.height) || el.offsetHeight);
    el.classList.add('min');
  }
  sync();
}
