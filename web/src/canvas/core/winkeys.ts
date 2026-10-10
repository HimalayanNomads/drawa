// Window keys: W steps through the windows, and M, Shift+F, F2, Shift+P, Shift+S act on the active one (the single
// selected item, else the frontmost window), so every tab button has a key.
import { ICON, ping } from '../../lib/dom';
import { command } from '../../lib/keys';
import { drawing } from '../ink/ink';
import { docked, floating, toggleDock, toggleFloat } from './dock';
import { anyFull, exitFull, isFull, toggleFull } from './fullview';
import { bringToFront, hidden, items, onCanvas } from './items';
import { menuSection } from './menu';
import { centerOn } from './placement';
import { selected, selectOnly } from './select';
import { rename, toggleCollapse } from './window';

/** Every item that isn't hidden inside a collapsed group. */
const visibleItems = () => items().filter(el => !hidden(el));
/** The window the keys act on: the one selected item, else the frontmost. */
export function active(): HTMLElement | undefined {
  const s = selected();
  if (s.length === 1) return s[0];
  return visibleItems().reduce<HTMLElement | undefined>(
    (a, el) => (!a || +el.style.zIndex > +a.style.zIndex ? el : a),
    undefined,
  );
}
/** The active item, only if it's a real window (a tab to act through), not a bare note. */
const activeWin = () => {
  const el = active();
  return el?.querySelector(':scope > .win-h') ? el : undefined;
};

/** An item's top and left, from its styles. */
// reading order (top to bottom, then left to right), not z-order: stepping brings each one forward, which would
// reshuffle a z-order. Styles, not layout reads: this runs over every item.
const at = (el: HTMLElement) => [parseFloat(el.style.top) || 0, parseFloat(el.style.left) || 0];
/** Step to the next (or previous) window in reading order: brought to the front, into view, and selected. */
function step(dir: 1 | -1) {
  const list = visibleItems().sort((a, b) => at(a)[0] - at(b)[0] || at(a)[1] - at(b)[1]);
  if (!list.length) return;
  const i = list.indexOf(active()!);
  const el = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
  bringToFront(el);
  if (onCanvas(el)) centerOn(el);
  else el.scrollIntoView({ block: 'nearest' }); // pinned or floating: already on screen
  ping(el);
  selectOnly(el); // Delete, the arrows and Ctrl+G act on it
}

/** M: collapse or expand the active window. */
const collapseActive = () => {
  const el = activeWin();
  if (el) toggleCollapse(el);
};
/** Shift+F: put the active window in full view, or leave full view. */
const fullActive = () => {
  if (anyFull()) return exitFull(true);
  const el = activeWin();
  if (el) toggleFull(el);
};
/** F2: rename the active window. */
const renameActive = () => {
  const el = activeWin();
  if (el) rename(el);
};
/** Shift+P: pin the active window to the sidebar, or unpin it. */
const pinActive = () => {
  const el = activeWin();
  if (el) toggleDock(el);
};
/** Shift+S: float the active window over the canvas, or put it back. */
const floatActive = () => {
  const el = activeWin();
  if (el) toggleFloat(el);
};

// Draw mode keeps its own keys (Shift+S, Shift+F and the rest belong to its tools); in full view only its own toggle
// acts: the rest would act behind it
const free = () => !drawing && !anyFull();
command({
  label: 'Next window',
  group: 'Windows',
  keys: ['w'],
  when: free,
  run: () => step(1),
  tip: '`W` steps through your windows; `M` collapses the one it lands on',
});
command({ label: 'Previous window', group: 'Windows', keys: ['Shift+w'], when: free, key: () => step(-1) });
command({
  label: 'Collapse or expand the window',
  group: 'Windows',
  keys: ['m'],
  when: free,
  run: collapseActive,
  tip: '`M` collapses the active window to its tab, and opens it again',
});
command({
  label: 'Full view',
  group: 'Windows',
  keys: ['Shift+f'],
  when: () => !drawing,
  run: fullActive,
  tip: '`Shift+F` puts the active window in full view; `Esc` puts it back',
});
command({ label: 'Rename the window', group: 'Windows', keys: ['F2'], when: free, run: renameActive });
command({ label: 'Pin the window to the sidebar', group: 'Windows', keys: ['Shift+p'], when: free, run: pinActive });
command({ label: 'Stick the window to the screen', group: 'Windows', keys: ['Shift+s'], when: free, run: floatActive });

// the Window section of the right-click menu (canvas/core/menu.ts): the tab's buttons, for the one window clicked
menuSection('Window', els => {
  const el = els.length === 1 ? els[0] : undefined;
  if (!el?.querySelector(':scope > .win-h')) return [];
  const min = el.classList.contains('min');
  return [
    {
      label: min ? 'Expand' : 'Collapse',
      icon: min ? ICON.open : ICON.collapse,
      keys: 'M',
      run: () => toggleCollapse(el),
    },
    {
      label: isFull(el) ? 'Leave full view' : 'Full view',
      icon: ICON.full,
      keys: 'Shift+F',
      run: () => toggleFull(el),
    },
    { label: 'Rename', icon: ICON.pencil, keys: 'F2', run: () => rename(el) },
    {
      label: docked(el) ? 'Unpin from the sidebar' : 'Pin to the sidebar',
      icon: ICON.pin,
      keys: 'Shift+P',
      run: () => toggleDock(el),
    },
    {
      label: floating(el) ? 'Unstick from the screen' : 'Stick to the screen',
      icon: ICON.float,
      keys: 'Shift+S',
      run: () => toggleFloat(el),
    },
  ];
});
