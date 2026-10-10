// Permission mode, per session card: what that card's Claude may do without asking. Picked in the card's message
// bar; a change applies to its running Claude process right away (Claude reports the switch back as a status line).

import { modesOf } from '../../lib/agents';
import { post } from '../../lib/api';
import { make, toast } from '../../lib/dom';
import { saveSoon } from '../../lib/store';
import type { Session } from '../../types/session';

export const MODES: [string, string, string][] = [
  ['default', 'Ask first', 'Asks before editing files or running commands'],
  ['acceptEdits', 'Allow edits', 'Edits files without asking; still asks before other commands'],
  ['auto', 'Auto', 'Claude Code approves safe actions itself and asks only before risky ones'],
  ['plan', 'Plan only', 'Explores and writes a plan for you to review; changes nothing'],
  ['bypassPermissions', 'Allow everything', 'Never asks. Only for work you trust'],
];

const LAST = 'drawa:mode';
/** The mode you picked last: new cards start in it (this browser). */
export const lastMode = () => {
  try {
    const m = localStorage.getItem(LAST);
    return m && MODES.some(([v]) => v === m) ? m : 'default';
  } catch {
    return 'default';
  }
};

/** The mode picker for a card's message bar. */
export function modePicker(S: Session) {
  const sel = make('select', 'modesel');
  sel.setAttribute('aria-label', 'Permission mode for this session');
  const has = modesOf(S.backend); // an agent lists only the modes it supports (OpenCode has no Auto)
  sel.append(
    ...MODES.filter(([value]) => has?.includes(value) ?? true).map(([value, label, desc]) =>
      Object.assign(make('option', '', label), { value, title: desc }),
    ),
  );
  sel.value = S.mode;
  sel.dataset.mode = S.mode;
  sel.onchange = () => setMode(S, sel.value);
  S.modeSel = sel;
  return sel;
}

/** Change a card's mode. `tell`: also switch its running Claude process (false when Claude itself reported it). */
export function setMode(S: Session, mode: string, tell = true) {
  if (!MODES.some(([m]) => m === mode)) return;
  S.mode = mode;
  const sel = S.modeSel;
  if (sel) {
    sel.dataset.mode = mode; // before .value: the custom dropdown mirrors both when value changes
    if (sel.value !== mode) sel.value = mode;
  }
  // not running yet is fine (the next message starts it in this mode); a failed request means it didn't switch
  // remembered for new cards once the server takes it; never Allow everything (a new card shouldn't start unguarded)
  if (tell)
    post('mode', { cid: S.cid, mode, backend: S.backend }).then(
      () => {
        if (mode !== 'bypassPermissions')
          try {
            localStorage.setItem(LAST, mode);
          } catch {}
      },
      () => modeRefused(S),
    );
  else S.confirmedMode = mode;
  saveSoon();
}

/** Claude refused a switch: show the mode it's really in again, and say so (the dropdown alone flips back unnoticed). */
export function modeRefused(S: Session) {
  const want = modeLabel(S.mode),
    now = S.confirmedMode ?? 'default';
  setMode(S, now, false);
  toast(`Could not switch to ${want}: still in ${modeLabel(now)}.`);
}
/** A permission mode's label ("Ask first", "Allow edits"). */
const modeLabel = (m: string) => MODES.find(([v]) => v === m)?.[1] ?? m;
