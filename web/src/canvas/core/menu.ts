// The canvas's right-click menu: titled sections of actions, each registered by the module that does them
// (menuSection), so a feature adds its entries without editing this file. A window's tab gets the sections that
// apply to that window (or the selection it's in); the empty canvas gets the ones that need no window.
import { keepOnScreen, make } from '../../lib/dom';
import { keysOf } from '../../lib/keys';
import { drawing } from '../ink/ink';
import { selected } from './select';
import { stage, world } from './view';

export interface MenuItem {
  label: string;
  icon?: string; // an svg (ICON from lib/dom.ts, or the toolbar's own)
  keys?: string; // one combo, drawn as key caps: "Shift+F"
  run: () => void;
}
/** `els` is what was right-clicked: a window (or the selection it's in), or [] for the empty canvas. Return no
 *  items to leave the section out. */
type Section = { title: string; items: (els: HTMLElement[]) => MenuItem[] };
const sections: Section[] = [];
/** Add a section. Sections show in registration order (main.ts's import order). */
export const menuSection = (title: string, items: Section['items']) => void sections.push({ title, items });

let menu: HTMLElement | null = null;
/** Close the right-click menu. */
const closeMenu = () => {
  menu?.remove();
  menu = null;
};
addEventListener(
  'pointerdown',
  e => {
    if (menu && !menu.contains(e.target as Node)) closeMenu();
  },
  true,
);
addEventListener('wheel', closeMenu, { passive: true });
addEventListener('blur', closeMenu);

/** One action's row in the right-click menu: its icon, label and keys. */
function menuRow(it: MenuItem) {
  const b = make('button', 'xsel-item ctx-item');
  b.setAttribute('role', 'menuitem');
  b.tabIndex = -1;
  const ic = b.appendChild(make('span', 'ctx-icon'));
  if (it.icon) ic.innerHTML = it.icon;
  b.append(make('span', 'xsel-text', it.label));
  if (it.keys) {
    const k = b.appendChild(make('span', 'ctx-keys'));
    for (const key of keysOf(it.keys)) k.append(make('kbd', '', key));
  }
  b.onclick = () => {
    closeMenu();
    it.run();
  };
  return b;
}

/** Open the menu at a screen point; `only` limits it to one section (the selection bar's Layer button). */
export function openMenu(els: HTMLElement[], x: number, y: number, only?: string) {
  closeMenu();
  const m = make('div', 'xsel-menu ctx-menu');
  m.setAttribute('role', 'menu');
  for (const s of sections) {
    if (only && s.title !== only) continue;
    const list = s.items(els);
    if (!list.length) continue;
    const id = `ctx-${s.title.toLowerCase().replace(/\W+/g, '-')}`;
    const group = m.appendChild(make('div', 'ctx-group'));
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', id);
    if (!only) group.append(Object.assign(make('div', 'ctx-head', s.title), { id }));
    group.append(...list.map(menuRow));
  }
  if (!m.childElementCount) return;
  menu = document.body.appendChild(m);
  m.addEventListener('keydown', keys);
  keepOnScreen(m, x, y);
  m.tabIndex = -1;
  m.focus(); // the menu, not its first row: nothing looks picked until the arrows or the pointer pick it
}

/** The right-click menu's keys. */
// arrows move through the rows (headers are skipped: they aren't buttons), Home/End jump, Esc closes
function keys(e: KeyboardEvent) {
  const rows = [...menu!.querySelectorAll<HTMLElement>('button')],
    i = rows.indexOf(document.activeElement as HTMLElement);
  const to =
    e.key === 'ArrowDown'
      ? (i + 1) % rows.length
      : e.key === 'ArrowUp'
        ? (i <= 0 ? rows.length : i) - 1
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? rows.length - 1
            : -1;
  if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault();
    closeMenu();
  } else if (to >= 0) {
    e.preventDefault();
    rows[to].focus();
  }
  e.stopPropagation(); // the menu has the keyboard: these aren't canvas shortcuts
}

document.addEventListener('contextmenu', e => {
  const t = e.target as Element;
  const tab = t.closest('.win-h'),
    el = tab?.parentElement;
  if (el?.classList.contains('item')) {
    e.preventDefault();
    return openMenu(selected().includes(el) ? selected() : [el], e.clientX, e.clientY); // a selected window brings the selection along
  }
  // the empty canvas (not a window's body, which keeps the browser's menu for copying text)
  if (drawing || !stage.contains(t) || (t !== stage && t !== world && t.closest('.item'))) return;
  e.preventDefault();
  openMenu([], e.clientX, e.clientY);
});
