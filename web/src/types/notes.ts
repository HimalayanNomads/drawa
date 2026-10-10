// A note as it's made and saved, and the notes' actions (lib/actions.ts, items/notes.ts). Moving, resizing and
// removing with × are every item's actions (types/canvas.ts).

/** The kinds of note action. The values are what the action log holds: don't change them. */
export enum NoteActionType {
  Add = 'note.add',
  Remove = 'note.remove',
  Edit = 'note.edit',
}

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
  width?: number; // a width the user set
};

/** A note added (once it has text), or taken away by emptying it. */
export type NoteAdd = { type: NoteActionType.Add | NoteActionType.Remove } & NoteData;

/** A note's text edited. */
export type NoteEdit = {
  type: NoteActionType.Edit;
  id: string;
  from: string;
  to: string;
};
