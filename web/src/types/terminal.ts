// A terminal window: a shell on the server, drawn with xterm.js (items/terminal/).
import type { Rect } from '../canvas/core/items';

/** What a terminal window's shell is doing (its `data-state`). */
export enum TerminalState {
  Running = 'running',
  Exited = 'exited', // the shell ended by itself (exit, a crash)
  Gone = 'gone', // the server lost it (restarted): nothing to reattach to
}

/** A terminal window in the saved layout. */
export interface SavedTerminal {
  id: string; // the window's own id (data-id), the same across Restarts
  shell: string; // the server's id for its shell, which a Restart replaces
  title: string;
  rect: Rect;
}

/** A chunk of a shell's output on /api/events: bytes `from`..`to` of everything it printed, base64. */
export interface TerminalOutput {
  from: number;
  to: number;
  data: string;
}

/** The terminal cursor's shape (the terminalCursor setting); the values are xterm's and the settings file's. */
export enum TerminalCursor {
  Block = 'block',
  Bar = 'bar',
  Underline = 'underline',
}
