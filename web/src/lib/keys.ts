// Every keyboard shortcut and runnable action, registered by the module that handles it: the ? sheet lists them,
// Ctrl+K runs the ones with `run`, the launch tips are drawn from the ones with `tip`, and the one keydown listener
// here dispatches their keys. Modules don't listen for shortcut keys themselves; a field, menu or dialog that owns
// the keyboard while it has focus still handles its own keys (and they never reach this: see `shortcutOk`).
// Combos are tinykeys' (https://github.com/jamiebuilds/tinykeys): a key matches what it types (`e.key`, any case) or
// the physical key (`e.code`), and modifiers must match exactly unless written optional ("[Shift]").

import { type KeybindingPress, matchKeybindingPress, parseKeybinding } from 'tinykeys';
import { shortcutOk } from './dom';

export interface Command {
  label: string; // "New session"
  group: string; // the ? sheet's section: "Canvas", "Items", "Windows", "Selection", "Draw", "Message box"
  // tinykeys combos, also shown as key caps: "w", "Shift+w", "Digit1" (the number row's physical key), "$mod+k"
  // (Ctrl, ⌘ on a Mac), "[Shift]+ArrowLeft" (with or without Shift). Without `run` or `key` they're only described
  // (the message box's keys, handled by the box).
  keys?: string[];
  run?: () => void; // makes it a Ctrl+K command; its keys run it too, unless it has `key`
  // what its keys do, when that needs the event or isn't a Ctrl+K command; false: not this time, the key goes on to
  // the next command that has it
  key?: (e: KeyboardEvent) => unknown;
  when?: (e: KeyboardEvent) => boolean; // its keys only act while this holds
  anywhere?: boolean; // its keys work while typing in a field too: taken before the field sees them (Ctrl+K)
  tip?: string; // a launch tip about it, plain text; keys in backticks show as key caps: "`W` steps through your windows"
}

const cmds: Command[] = [];
const bound: { c: Command; presses: KeybindingPress[] }[] = [];
/** Register a shortcut or action. Call it at module top level: registration order is the order commands that share
 *  a key are tried in (Esc backs out of Draw mode before it clears the selection). */
export const command = (c: Command) => {
  cmds.push(c);
  if (c.keys?.length && (c.key || c.run)) bound.push({ c, presses: c.keys.map(k => parseKeybinding(k)[0]) });
};
/** Every registered shortcut and action, in registration order (the ? sheet and Ctrl+K list them). */
export const commands = (): readonly Command[] => cmds;

/** Run the first command whose key this is: in the capture phase only the `anywhere` ones, in the bubble phase the
 *  rest, once the focused element had its say (a menu's Esc closes the menu, not the selection behind it). */
function dispatch(e: KeyboardEvent, anywhere: boolean) {
  if (e.defaultPrevented || e.isComposing || (!anywhere && !shortcutOk(e))) return;
  for (const { c, presses } of bound) {
    if (!!c.anywhere !== anywhere || !presses.some(p => matchKeybindingPress(e, p)) || c.when?.(e) === false) continue;
    if ((c.key ? c.key(e) : c.run!()) === false) continue;
    e.preventDefault();
    return;
  }
}
addEventListener('keydown', e => dispatch(e, true), true);
addEventListener('keydown', e => dispatch(e, false));

/** Ctrl on Windows and Linux, ⌘ on a Mac: what to show for a "Ctrl" or "$mod" key. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
const NAMES: Record<string, string> = {
  $mod: MOD,
  Ctrl: MOD,
  Control: 'Ctrl',
  Meta: '⌘',
  Escape: 'Esc',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  ' ': 'Space',
};
/** A combo's key caps, for showing it: "Shift+w" -> ["Shift", "W"], "Shift+Digit1" -> ["Shift", "1"],
 *  "$mod+k" -> ["⌘", "K"] on a Mac; optional modifiers ("[Shift]") aren't shown. Plain "Shift+F" works too. */
export const keysOf = (combo: string) =>
  combo
    .split(/(?<=\w|\])\+/)
    .filter(k => !/^\[.*\]$/.test(k))
    .map(k => NAMES[k] ?? k.replace(/^(Digit|Key)(?=.)/, '').replace(/^[a-z]$/, c => c.toUpperCase()));
