// Your own settings, the same in every project and browser: ~/.drawa/config.json. The server writes it with the
// defaults on first run and reads it for every page (a hand edit applies on the next reload); the page changes it
// with setPrefs(). This browser keeps the last copy seen (drawa:prefs) for the inline script in index.html, which
// paints the theme and interface from it before the server answers. Keep DEFAULTS in sync with internal/prefs.

import { CompletionMode } from '../types/prefs';
import { api, post } from './api';
import { toast } from './dom';

export interface Prefs {
  ui: 'full' | 'minimal'; // lib/uimode.ts
  theme: 'system' | 'light' | 'dark'; // lib/theme.ts, with a scheme for each mode
  lightScheme: string;
  darkScheme: string;
  symbols: 'auto' | 'off'; // lib/symbols.ts: code symbols from universal-ctags when it's installed, or never
  vim: 'off' | 'on'; // items/preview/fileedit.ts, items/doc.ts: Vim motions in the file editor and scratchpads
  completion: CompletionMode;
}
const DEFAULTS: Prefs = {
  ui: 'full',
  theme: 'system',
  lightScheme: 'claude-light',
  darkScheme: 'claude-dark',
  symbols: 'auto',
  vim: 'off',
  completion: CompletionMode.Toast,
};
const KEY = 'drawa:prefs';
/** A JSON value from localStorage, or null when it's missing or doesn't parse. */
const read = (key: string) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};

const seen = read(KEY) as Partial<Prefs> | null;
/** Legacy browser-only and invalid cached choices use the combined alert default, as on the server. */
const completionMode = (value: unknown) =>
  Object.values(CompletionMode).includes(value as CompletionMode) ? (value as CompletionMode) : DEFAULTS.completion;
let cur: Prefs = { ...DEFAULTS, ...seen, completion: completionMode(seen?.completion) };
const listeners: ((p: Prefs) => void)[] = [];
/** Your settings as last read from (or written to) ~/.drawa/config.json. */
export const prefs = () => cur;
/** `f(prefs)` runs whenever the settings change: picked in this tab or another, or read from the file at boot. */
export const onPrefs = (f: (p: Prefs) => void) => void listeners.push(f);

/** Adopt new settings: keep a copy for the next boot's first paint and tell everyone who listens. */
function take(p: Partial<Prefs>) {
  cur = { ...DEFAULTS, ...p, completion: completionMode(p.completion) };
  try {
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {}
  listeners.forEach(f => f(cur));
}

/** Save changes to the file; false (after saying why) when the server couldn't. */
async function save(changes: Partial<Prefs>) {
  try {
    take((await post('prefs', changes)).prefs);
    return true;
  } catch (e) {
    toast(`Couldn't save the setting: ${(e as Error).message}`);
    return false;
  }
}

/** Change settings: shown right away, put back if the file couldn't be saved. */
export async function setPrefs(changes: Partial<Prefs>) {
  const was = cur;
  take({ ...cur, ...changes });
  if (!(await save(changes))) take(was);
}

addEventListener('storage', e => {
  if (e.key === KEY) take({ ...read(KEY) });
}); // another tab changed them

// Before the file, each browser kept its theme itself (drawa:theme). The first time this browser meets the file, its
// theme moves in, so nobody's colors change with the upgrade.
// ponytail: a second browser that had its own theme moves that in too (the last one wins); fine for one person.
const old = seen ? null : (read('drawa:theme') as { mode?: string; light?: string; dark?: string } | null);
const carried: Partial<Prefs> | null =
  old?.mode === 'light' || old?.mode === 'dark'
    ? {
        theme: old.mode,
        ...(old.light ? { lightScheme: old.light } : {}),
        ...(old.dark ? { darkScheme: old.dark } : {}),
      }
    : null;

api<{ prefs: Prefs; error?: string }>('prefs').then(
  r => {
    if (r.error) toast(`Settings: ${r.error}`);
    take({ ...r.prefs, ...carried });
    if (carried) save(carried);
  },
  () => {},
); // server away: the last copy seen stands
