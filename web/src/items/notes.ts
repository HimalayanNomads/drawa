// Text on the canvas: double-click empty space (or press T) and type. Click a note to edit it; empty notes vanish.

import { draggable, resizable } from '../canvas/core/drag';
import { addItem, bringToFront, items, place, rect } from '../canvas/core/items';
import { referable } from '../canvas/core/refs';
import { creatable } from '../canvas/core/tools';
import { changed, stage, toWorld, viewCenter } from '../canvas/core/view';
import { removeButton } from '../canvas/core/window';
import { forget } from '../canvas/graph/graph';
import { defineAction, recordActions } from '../lib/actions';
import { make, uuid } from '../lib/dom';
import { each, persist } from '../lib/store';
import { type Note, NoteActionType, type NoteAdd, type NoteData, type NoteEdit } from '../types/notes';

// each note's text as last recorded as an action: a new note is recorded once it has some, an edit from this
const recordedText = new WeakMap<HTMLElement, string>();

/** A text note on the canvas, edited in place; an empty one goes away when you leave it. */
export function makeNote(opts: Note) {
  const el = make('div', 'nnode'),
    text = make('div', 'ntext');
  el.dataset.id = opts.id ?? uuid();
  text.textContent = opts.text ?? '';
  text.setAttribute('role', 'textbox');
  text.setAttribute('aria-label', 'Canvas note');
  const del = removeButton('Delete note', undefined, 'ndel');
  el.append(text, del);
  addItem(el, 'note');
  place(el, opts.x, opts.y);
  if (opts.w) el.style.width = `${opts.w}px`;
  bringToFront(el);
  recordedText.set(el, opts.text ?? '');

  /** Start editing the note, with the caret at the end. */
  const edit = () => {
    text.contentEditable = 'plaintext-only';
    el.dataset.state = 'editing';
    text.focus();
    const range = document.createRange(); // caret at the end
    range.selectNodeContents(text);
    range.collapse(false);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  };
  /** Stop editing; a note left empty is removed. */
  const done = () => {
    text.contentEditable = 'false';
    delete el.dataset.state;
    const currentText = text.textContent ?? '';
    const textBefore = recordedText.get(el) ?? '';
    if (!currentText.trim()) {
      if (textBefore.trim()) recordActions({ type: NoteActionType.Remove, ...noteData(el, textBefore) });
      forget(el);
      el.remove();
    } else if (!textBefore.trim()) recordActions({ type: NoteActionType.Add, ...noteData(el, currentText) });
    else if (currentText !== textBefore)
      recordActions({ type: NoteActionType.Edit, id: el.dataset.id!, from: textBefore, to: currentText });
    recordedText.set(el, currentText);
    changed();
  };
  text.addEventListener('blur', done);
  text.addEventListener('keydown', e => {
    e.stopPropagation(); // typing isn't a canvas shortcut
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      text.blur();
    }
  });
  text.addEventListener('input', () => changed());
  draggable(el, el, changed, () => {
    if (el.dataset.state !== 'editing') edit();
  });
  resizable(el, 80, 0, changed, true); // drag the corner to set the width; text wraps to fit
  if (opts.edit) edit();
  return el;
}

/** A note's text. */
const noteText = (el: HTMLElement) => el.querySelector('.ntext')?.textContent ?? '';
/** Set a note's text from outside its editing (an action, Claude's canvas_update): the next edit is recorded from
 *  it. */
const setText = (note: HTMLElement, newText: string) => {
  note.querySelector('.ntext')!.textContent = newText;
  recordedText.set(note, newText);
};

/* ---------- notes' changes as actions (lib/actions.ts); moving, resizing and × are every item's ---------- */
/** A note as data, with this text. */
const noteData = (note: HTMLElement, text: string): NoteData => {
  const box = rect(note);
  return { id: note.dataset.id!, text, x: box.x, y: box.y, ...(note.style.width ? { width: box.w } : {}) };
};
/** The note on the canvas with this id. */
const noteWithId = (id: string) => items('note').find(note => note.dataset.id === id);
defineAction<NoteAdd>(NoteActionType.Add, {
  apply: action => {
    if (noteWithId(action.id)) return false;
    makeNote({ id: action.id, text: action.text, x: action.x, y: action.y, w: action.width });
    changed();
    return true;
  },
  invert: action => ({ ...action, type: NoteActionType.Remove }),
});
defineAction<NoteAdd>(NoteActionType.Remove, {
  apply: action => {
    const note = noteWithId(action.id);
    if (!note) return false;
    forget(note);
    note.remove();
    changed();
    return true;
  },
  invert: action => ({ ...action, type: NoteActionType.Add }),
});
defineAction<NoteEdit>(NoteActionType.Edit, {
  apply: action => {
    const note = noteWithId(action.id);
    if (!note) return false;
    setText(note, action.to);
    changed();
    return true;
  },
  invert: action => ({ ...action, from: action.to, to: action.from }),
});

persist(
  'notes',
  () =>
    items('note')
      .filter(n => noteText(n).trim())
      .map(n => {
        const r = rect(n);
        return { id: n.dataset.id!, text: noteText(n), x: r.x, y: r.y, w: n.style.width ? r.w : undefined };
      }),
  (list: Note[]) => each(list, makeNote),
);
creatable('note', {
  size: a => ({ w: Math.min(360, Math.max(120, String(a.text).length * 8)), h: 60 }),
  create: (a, r) => makeNote({ x: r.x, y: r.y, text: String(a.text), w: String(a.text).length > 45 ? 360 : undefined }),
  update: (el, a) => setText(el, String(a.text)),
});
referable('note', {
  icon: '¶',
  label: el => noteText(el).slice(0, 40),
  content: el => ({ text: `Note from my canvas:\n${noteText(el).trim()}` }),
});

/** A new note at the view's center (T key). */
export const noteHere = () => {
  const c = viewCenter();
  makeNote({ x: c.x - 40, y: c.y - 12, edit: true });
};

// Double-click empty canvas: a note right where you clicked.
stage.addEventListener('dblclick', e => {
  const t = e.target as Element;
  if (t !== stage && !t.matches('#world, #edges, #inkworld')) return;
  const w = toWorld(e.clientX, e.clientY);
  makeNote({ x: w.x, y: w.y - 12, edit: true });
});
