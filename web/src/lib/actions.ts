// Every change the user makes to the canvas as an action: a plain JSON object ({ type: 'items.move', moves: [...] })
// whose kind a module registers with `defineAction()`, saying how to apply it and how to invert it. Two things are
// built on them:
// - one undo/redo history for the whole canvas: a step is the actions one thing the user did made, undone by applying
//   their inverses (themselves actions) newest first;
// - an append-only log of every action applied, undo and redo included, which listeners (`onAction`) read:
//   replaying it (`replayActions`) does again what happened. The start of event sourcing: a server stream, a save
//   file, other users.
// The log is saved with the layout (its 'actions' key), the undo history isn't: after a reload there's nothing to
// undo.
// ponytail: only the newest actions that fit in KEEP_CHARACTERS are saved (localStorage's ~5 MB is shared by every
// project's layout); a server-side log (~/.drawa) comes next. An action that refers to something removed earlier in
// the session (item.restore) relies on it still being parked in this page.
import { command } from './keys';
import { persist } from './store';

/** One change, as data: `type` names its kind, the rest is the kind's own (JSON only, ids rather than elements). */
export interface Action {
  type: string;
  [field: string]: unknown;
}
interface ActionKind<SpecificAction extends Action> {
  /** Make the change. false: it couldn't (what it refers to is gone for good), so it's left out. */
  apply: (action: SpecificAction) => boolean;
  /** The action that takes it back. */
  invert: (action: SpecificAction) => Action;
}
const actionKinds = new Map<string, ActionKind<Action>>();
/** Register a kind of action: how to apply it and how to invert it. */
export function defineAction<SpecificAction extends Action>(type: string, kind: ActionKind<SpecificAction>) {
  actionKinds.set(type, kind as unknown as ActionKind<Action>);
}

const MAX_UNDO_STEPS = 200; // ponytail: the oldest fall off
const MAX_LOG_ACTIONS = 5000; // kept in the page's log
const undoSteps: Action[][] = [];
const redoSteps: Action[][] = [];
const log: Action[] = [];
const listeners: ((action: Action) => void)[] = [];
let stepBeingCollected: Action[] | null = null; // collecting what `asOneUndoStep()` records

/** Apply one action; false when it couldn't be. */
function applyAction(action: Action) {
  const kind = actionKinds.get(action.type);
  if (!kind) throw new Error(`unknown action ${action.type}`);
  return kind.apply(action);
}
/** Append applied actions to the log and tell the listeners. */
function appendToLog(actions: Action[]) {
  for (const action of actions) {
    log.push(action);
    listeners.forEach(listener => listener(action));
  }
  if (log.length > MAX_LOG_ACTIONS) log.splice(0, log.length - MAX_LOG_ACTIONS);
}
/** A new step: undo can take it back, and what was undone before it can't be redone any more. */
function addUndoStep(step: Action[]) {
  undoSteps.push(step);
  if (undoSteps.length > MAX_UNDO_STEPS) undoSteps.shift();
  redoSteps.length = 0;
}

/** Record actions whose change already happened (a drag that ended, a note left): one step undo can take back. */
export function recordActions(...actions: Action[]) {
  if (!actions.length) return;
  appendToLog(actions);
  if (stepBeingCollected) stepBeingCollected.push(...actions);
  else addUndoStep(actions);
}
/** Make changes as actions: applied, logged, and one step undo can take back. */
export const applyActions = (...actions: Action[]) => recordActions(...actions.filter(applyAction));
/** Everything recorded while `changes` runs is one undo step (deleting a selection takes windows and drawings at
 *  once). */
export function asOneUndoStep(changes: () => void) {
  if (stepBeingCollected) return changes();
  stepBeingCollected = [];
  try {
    changes();
  } finally {
    const step = stepBeingCollected;
    stepBeingCollected = null;
    if (step.length) addUndoStep(step);
  }
}
/** Apply actions from elsewhere (a log being replayed): logged, but not something to undo here. */
export const replayActions = (actions: readonly Action[]) => appendToLog(actions.filter(applyAction));

/** Take back the last step. A step whose things are gone for good (a deleted window after its Undo ran out) can't
 *  be, and is passed over for the one before it. */
export function undo() {
  while (undoSteps.length) {
    const step = undoSteps.pop()!;
    const applied = [...step]
      .reverse()
      .map(action => actionKinds.get(action.type)!.invert(action))
      .filter(applyAction);
    if (!applied.length) continue;
    appendToLog(applied);
    redoSteps.push(step);
    return true;
  }
  return false;
}
/** Do the last undone step again. */
export function redo() {
  while (redoSteps.length) {
    const step = redoSteps.pop()!;
    const applied = step.filter(applyAction);
    if (!applied.length) continue;
    appendToLog(applied);
    undoSteps.push(step);
    return true;
  }
  return false;
}

const KEEP_CHARACTERS = 500_000;
/** The newest actions whose JSON fits in KEEP_CHARACTERS: what's saved. */
function actionsToSave() {
  let characters = 0;
  let start = log.length;
  while (start > 0) {
    characters += JSON.stringify(log[start - 1]).length;
    if (characters > KEEP_CHARACTERS) break;
    start--;
  }
  return log.slice(start);
}
/** Take back the saved log. Not applied again: the state it led to comes back with the layout. */
function loadSavedLog(saved: Action[]) {
  if (!Array.isArray(saved)) return;
  log.splice(0, log.length, ...saved);
}
persist('actions', actionsToSave, loadSavedLog, 0); // phase 0: back before anything records new actions

/** Every action applied to this canvas, oldest first: the saved ones, then this page's (the last MAX_LOG_ACTIONS). */
export const actionLog = (): readonly Action[] => log;
/** Hear every action as it's applied: recorded, undone, redone or replayed. */
export function onAction(listener: (action: Action) => void) {
  listeners.push(listener);
}

command({ label: 'Undo', group: 'Canvas', keys: ['$mod+z'], run: () => void undo() });
command({ label: 'Redo', group: 'Canvas', keys: ['$mod+Shift+z', '$mod+y'], run: () => void redo() });
