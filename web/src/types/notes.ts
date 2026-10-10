// A note as it's made and saved, and the notes' actions (lib/actions.ts, items/notes.ts). Moving, resizing and
// removing with × are every item's actions (types/canvas.ts).

/** What makes a note: saved with the layout, or given when one is made. */
export interface Note {
  id?: string;
  text?: string;
  x: number;
  y: number;
  w?: number; // a width the user set; without it the note is as wide as its text
  edit?: boolean; // start typing in it
}

/** A note as data, with the text it had then. */
export type NoteData = {
  id: string;
  text: string;
  x: number;
  y: number;
  w?: number;
};

/** A note added (once it has text), or taken away by emptying it. */
export type NoteAdd = { t: 'note.add' | 'note.remove' } & NoteData;

/** A note's text edited. */
export type NoteEdit = {
  t: 'note.edit';
  id: string;
  from: string;
  to: string;
};
