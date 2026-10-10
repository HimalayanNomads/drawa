// Grouping from the selection (items/group/group.ts holds the groups themselves): Ctrl+G and the bar's Group, Ctrl+Shift+G
// and its Ungroup. Windows (with any drawings) go into a frame; drawings alone are grouped without one, like
// Excalidraw's (canvas/ink/inksel.ts).

import { clearSelection, refreshActions, selected, selectedInk, selectionAction } from '../../canvas/core/select';
import { changed } from '../../canvas/core/view';
import { expand } from '../../canvas/core/window';
import { groupStrokes, oneGroup, ungroupStrokes } from '../../canvas/ink/inksel';
import { command } from '../../lib/keys';
import { flash, group, groupable, groupOf, groups, isGroup, join, members, settleFrom, ungroup } from './group';
import { groupableInk, groupInk, inkGroupOf, joinInk } from './groupink';

/** What grouping these would involve: the windows, and the groups they touch (selected, or holding one of them). */
function touched(els: HTMLElement[]) {
  const wins = els.filter(groupable),
    ink = selectedInk().filter(groupableInk),
    all = groups();
  const held = [...wins.map(groupOf), ...ink.map(s => inkGroupOf(s, all))].filter((g): g is HTMLElement => !!g);
  return { wins, ink, gs: [...new Set([...els.filter(isGroup), ...held])] };
}
/** Would grouping these change anything (not all in one group already)? */
const changes = ({ wins, ink, gs }: ReturnType<typeof touched>) => {
  if (gs.length > 1) return true;
  if (!gs.length) return wins.length > 0 || (ink.length > 1 && !oneGroup(ink)); // (drawings alone: a frameless group)
  const all = groups();
  return wins.some(el => groupOf(el) !== gs[0]) || ink.some(s => inkGroupOf(s, all) !== gs[0]);
};
/** Group the selection (Ctrl+G): drawings alone without a frame; nothing selected, an empty group to drop windows
 *  into. A selection that touches groups (a selected group, or windows already in one) merges into the first of them:
 *  never a second group. */
function groupSelection() {
  const picked = selected();
  if (!picked.length && !selectedInk().length) {
    settleFrom([group()]);
    changed();
    return;
  }
  const t = touched(picked),
    { wins } = t,
    touchedGs = t.gs;
  if (!changes(t)) return;
  if (!wins.length && !touchedGs.length) {
    // drawings alone: grouped like Excalidraw's, no frame
    groupStrokes(t.ink);
    return refreshActions();
  }
  const g = touchedGs[0] ?? group();
  expand(g); // a collapsed target opens: what joins it stays in sight
  for (const other of touchedGs.slice(1)) {
    const ms = members(other),
      ink = groupInk(other);
    ungroup(other);
    ms.forEach(m => join(m, g));
    joinInk(ink, g, groups());
  }
  for (const el of wins) join(el, g);
  joinInk(t.ink, g, groups());
  clearSelection(); // the group holds them together now (and the selection bar would sit on the group's tab)
  flash(g);
  changed(); // the next frame fits it around them, then settles
}
/** Ctrl+Shift+G (and the bar's Ungroup): selected groups lose their frame, their windows stay. A single window
 *  leaves its group by being dragged out, or through its own tab's button. */
function ungroupSelection() {
  ungroupStrokes(selectedInk().filter(s => s.g));
  for (const el of selected()) if (isGroup(el)) ungroup(el);
  refreshActions();
  changed();
}
// taken from the browser, whose Ctrl+G is "find next"
command({
  label: 'Group the selection (drawings alone: without a frame)',
  group: 'Selection',
  keys: ['$mod+g'],
  key: groupSelection,
});
command({
  label: 'Ungroup the selected groups and drawings',
  group: 'Selection',
  keys: ['$mod+Shift+g'],
  key: ungroupSelection,
});
selectionAction(
  'Group',
  'Group the selection (Ctrl+G): drawings alone without a frame; groups in it merge',
  groupSelection,
  els => changes(touched(els)),
);
selectionAction(
  'Ungroup',
  'Remove the selected groups, keep what they held (Ctrl+Shift+G)',
  ungroupSelection,
  els => els.some(isGroup) || selectedInk().some(s => !!s.g),
);
