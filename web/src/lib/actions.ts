// Every change the user makes to the canvas as an action: a plain JSON object ({ t: 'items.move', moves: [...] })
// whose kind a module registers with `defineAction()`, saying how to apply it and how to invert it. Two things are
// built on them:
// - one undo/redo history for the whole canvas: a step is the actions one thing the user did made, undone by applying
//   their inverses (themselves actions) newest first;
// - an append-only log of every action applied, undo and redo included, which listeners (`onAction`) read: replaying
//   it (`replay`) does again what happened. The start of event sourcing: a server stream, a save file, other users.
// The log is saved with the layout (its 'actions' key), the undo history isn't: after a reload there's nothing to
// undo.
// ponytail: only the newest actions that fit in KEEP characters are saved (localStorage's ~5 MB is shared by every
// project's layout); a server-side log (~/.drawa) comes next. An action that refers to something removed earlier in
// the session (item.restore) relies on it still being parked in this page.
import { command } from './keys';
import { persist } from './store';

/** One change, as data: `t` names its kind, the rest is the kind's own (JSON only, ids rather than elements). */
export interface Action {
  t: string;
  [k: string]: unknown;
}
interface Kind<A extends Action> {
  /** Make the change. false: it couldn't (what it refers to is gone for good), so it's left out. */
  apply: (a: A) => boolean;
  /** The action that takes it back. */
  invert: (a: A) => Action;
}
const kinds = new Map<string, Kind<Action>>();
/** Register a kind of action: how to apply it and how to invert it. */
export function defineAction<A extends Action>(t: string, k: Kind<A>) {
  kinds.set(t, k as unknown as Kind<Action>);
}

const MAX = 200; // undo steps kept; ponytail: oldest fall off
const LOG = 5000; // actions kept in the page's log
const undos: Action[][] = [],
  redos: Action[][] = [],
  log: Action[] = [],
  listeners: ((a: Action) => void)[] = [];
let batch: Action[] | null = null;

/** Apply one action; false when it couldn't be. */
function run(a: Action) {
  const k = kinds.get(a.t);
  if (!k) throw new Error(`unknown action ${a.t}`);
  return k.apply(a);
}
/** Append applied actions to the log and tell the listeners. */
function emit(list: Action[]) {
  for (const a of list) {
    log.push(a);
    listeners.forEach(f => f(a));
  }
  if (log.length > LOG) log.splice(0, log.length - LOG);
}
/** A new step: undo can take it back, and what was undone before it can't be redone any more. */
function push(step: Action[]) {
  undos.push(step);
  if (undos.length > MAX) undos.shift();
  redos.length = 0;
}

/** Record actions whose change already happened (a drag that ended, a note left): one step undo can take back. */
export function recordActions(...list: Action[]) {
  if (!list.length) return;
  emit(list);
  if (batch) batch.push(...list);
  else push(list);
}
/** Make changes as actions: applied, logged, and one step undo can take back. */
export const doActions = (...list: Action[]) => recordActions(...list.filter(run));
/** Everything recorded while `fn` runs is one undo step (deleting a selection takes windows and drawings at once). */
export function together(fn: () => void) {
  if (batch) return fn();
  batch = [];
  try {
    fn();
  } finally {
    const step = batch;
    batch = null;
    if (step.length) push(step);
  }
}
/** Apply actions from elsewhere (a log being replayed): logged, but not something to undo here. */
export const replay = (list: readonly Action[]) => emit(list.filter(run));

/** Take back the last step. A step whose things are gone for good (a deleted window after its Undo ran out) can't
 *  be, and is passed over for the one before it. */
export function undo() {
  while (undos.length) {
    const step = undos.pop()!;
    const done = [...step]
      .reverse()
      .map(a => kinds.get(a.t)!.invert(a))
      .filter(run);
    if (!done.length) continue;
    emit(done);
    redos.push(step);
    return true;
  }
  return false;
}
/** Do the last undone step again. */
export function redo() {
  while (redos.length) {
    const step = redos.pop()!;
    const done = step.filter(run);
    if (!done.length) continue;
    emit(done);
    undos.push(step);
    return true;
  }
  return false;
}

const KEEP = 500_000;
/** The newest actions whose JSON fits in KEEP characters: what's saved. */
function newest() {
  let size = 0;
  let i = log.length;
  while (i > 0) {
    size += JSON.stringify(log[i - 1]).length;
    if (size > KEEP) break;
    i--;
  }
  return log.slice(i);
}
/** Take back the saved log. Not applied again: the state it led to comes back with the layout. */
function loadLog(list: Action[]) {
  if (!Array.isArray(list)) return;
  log.splice(0, log.length, ...list);
}
persist('actions', newest, loadLog, 0); // phase 0: back before anything records new actions

/** Every action applied to this canvas, oldest first: the saved ones, then this page's (the last LOG of them). */
export const actionLog = (): readonly Action[] => log;
/** Hear every action as it's applied: recorded, undone, redone or replayed. */
export function onAction(f: (a: Action) => void) {
  listeners.push(f);
}

command({ label: 'Undo', group: 'Canvas', keys: ['$mod+z'], run: () => void undo() });
command({ label: 'Redo', group: 'Canvas', keys: ['$mod+Shift+z', '$mod+y'], run: () => void redo() });
