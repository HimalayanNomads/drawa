// The drawer: one side panel showing one pane at a time (History, Files), each pane toggled by its own toolbar button.
// Panes register with drawerPane(), so the drawer knows nothing about what they hold.

import { $, spinWhile } from '../lib/dom';
import { keysOf } from '../lib/keys';
import type { DrawerPane, DrawerPaneSpec } from '../types/drawer';

const drawer = $('#drawer'),
  panes = new Map<DrawerPane, DrawerPaneSpec>();
let shownPane: DrawerPane | undefined;
let returnFocus: HTMLElement | null = null; // what had focus before the drawer opened, given back when it closes

/** Add a pane to the drawer, and label its toolbar button with its keys as the ? sheet does (⌘ on a Mac, Ctrl
 *  elsewhere). */
export function drawerPane(pane: DrawerPane, spec: DrawerPaneSpec) {
  panes.set(pane, spec);
  shownPane ??= pane;
  const button = $(spec.button),
    caps = keysOf(spec.keys);
  button.dataset.key = caps.map(cap => (cap === 'Shift' ? '⇧' : cap)).join('');
  button.title = `${button.title} (${caps.join('+')})`;
  button.onclick = () => toggleDrawer(pane);
}

/** Show a pane in the drawer, or close the drawer when that pane is already showing (its button toggles it).
 *  Opening a pane reloads it and puts you in its search box. */
export function toggleDrawer(pane: DrawerPane) {
  const open = drawer.hidden || shownPane !== pane;
  if (open && drawer.hidden) returnFocus = document.activeElement as HTMLElement | null;
  const hadFocus = drawer.contains(document.activeElement);
  shownPane = pane;
  drawer.hidden = !open;
  const spec = panes.get(pane)!;
  $('#dtitle').textContent = spec.title;
  for (const [each, other] of panes) {
    $(`#${each}`).hidden = each !== pane;
    $(other.button).setAttribute('aria-expanded', String(open && each === pane));
  }
  if (!open) return giveFocusBack(hadFocus);
  spec.opening?.();
  reloadPane();
  $(spec.search).focus();
}

/** Closing hands focus back to where it was, unless you've since moved it somewhere else. */
function giveFocusBack(hadFocus: boolean) {
  const back = returnFocus;
  returnFocus = null;
  if ((hadFocus || document.activeElement === document.body) && back?.isConnected) back.focus({ preventScroll: true });
}

/** Reload the pane that's showing, its refresh icon spinning until it's done. */
const reloadPane = () => shownPane && spinWhile($('#refresh'), panes.get(shownPane)!.load());

/** Is this pane on screen? */
export const paneShown = (pane: DrawerPane) => !drawer.hidden && shownPane === pane;

/** Is the drawer showing? */
export const drawerOpen = () => !drawer.hidden;

/** Close the drawer, whichever pane it shows. */
export function closeDrawer() {
  if (!drawer.hidden && shownPane) toggleDrawer(shownPane);
}

$('#dclose').onclick = closeDrawer;
$('#refresh').onclick = reloadPane;
