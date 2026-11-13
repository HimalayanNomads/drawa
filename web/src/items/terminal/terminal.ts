// Terminal windows: a real shell per window (vim, htop, tmux, a dev server), on a pseudo-terminal the server opens
// (internal/term). Keys go out in one POST per frame; output comes back on the page's one /api/events stream as
// `_t` lines, from the offset the item has drawn up to, so a reload replays what the server kept. Ctrl+` or Ctrl+K's
// "New terminal" opens one; the modes (terminal and normal, as in Neovim) are in xterm.ts.

import { items, onGone, type Rect, savedRect } from '../../canvas/core/items';
import { centerOn, freeSpot } from '../../canvas/core/placement';
import { referable } from '../../canvas/core/refs';
import { removable } from '../../canvas/core/select';
import { changed, viewCenter } from '../../canvas/core/view';
import { makeWindow, removeButton, winTitle } from '../../canvas/core/window';
import { api, post } from '../../lib/api';
import { button, ICON, iconButton, make, perFrame, toast, uuid } from '../../lib/dom';
import { command } from '../../lib/keys';
import { onPrefs } from '../../lib/prefs';
import { each, persist } from '../../lib/store';
import { onTheme } from '../../lib/theme';
import { restream, streamWith } from '../../session/card/live';
import { newSession, nothingToWorkIn } from '../../session/card/session';
import { type SavedTerminal, type TerminalOutput, TerminalState } from '../../types/terminal';
import { type Emulator, emulator, looks, palette } from './xterm';
import './termprefs';

interface Shell {
  item: HTMLElement;
  id: string; // the server's id for the shell ('' until it opened)
  drawn: number; // the output offset drawn so far
  emulator?: Emulator;
  pending: string; // keys typed this frame
  size: string; // the cols x rows last sent
  banner: HTMLElement;
  fitNow?: () => void; // fit the emulator to the window now (before a shell starts at its size)
}
const shells = new Map<HTMLElement, Shell>();
let supported: boolean | undefined;
const SCROLLBACK_SENT = 200; // lines of scrollback an agent receives with the screen

referable('terminal', {
  icon: '❯',
  name: 'terminal',
  status: item => (item.dataset.state === TerminalState.Running ? undefined : 'ended'),
  copy: item => screenText(item),
  content: (item, label) => ({
    text: `Terminal "${label}" from my canvas (its screen and recent output):\n\n${screenText(item)}`,
  }),
});

/** The item's screen and the scrollback above it, as plain text. */
function screenText(item: HTMLElement) {
  const term = shells.get(item)?.emulator?.term;
  if (!term) return '';
  const buffer = term.buffer.active,
    lines: string[] = [];
  for (let index = Math.max(0, buffer.length - term.rows - SCROLLBACK_SENT); index < buffer.length; index++)
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  return lines.join('\n').trimEnd();
}

// every running item's output rides the page's one stream
streamWith({
  key: () =>
    live()
      .map(shell => shell.id)
      .sort()
      .join(),
  query: () => {
    const list = live().map(shell => `${shell.id}:${shell.drawn}`);
    return list.length ? `t=${list.join()}` : '';
  },
  take: message => {
    if (typeof message._t !== 'string') return;
    const shell = [...shells.values()].find(candidate => candidate.id === message._t);
    if (!shell) return;
    if (message.data !== undefined) return output(shell, message as TerminalOutput);
    if (message.exit !== undefined) ended(shell, TerminalState.Exited, `Shell exited (code ${message.exit})`);
    else if (message.gone) ended(shell, TerminalState.Gone, 'Shell ended (the server restarted)');
  },
});
/** The windows whose shell is running and on the canvas (one parked by a delete still has Undo: not read meanwhile). */
const live = () =>
  [...shells.values()].filter(
    shell => shell.id && shell.item.isConnected && shell.item.dataset.state === TerminalState.Running,
  );

function output(shell: Shell, message: TerminalOutput) {
  if (message.to <= shell.drawn) return; // a re-opened stream sending what's drawn already
  const bytes = Uint8Array.from(atob(message.data), char => char.charCodeAt(0));
  shell.emulator?.term.write(bytes.subarray(Math.max(0, shell.drawn - message.from)));
  shell.drawn = message.to;
}

function ended(shell: Shell, state: TerminalState, why: string) {
  shell.item.dataset.state = state;
  shell.banner.firstChild!.textContent = why;
  shell.banner.hidden = false;
  restream();
}

/** Start a shell for the item (a new one, or after Restart), sized to it. */
async function start(shell: Shell) {
  const term = shell.emulator!.term;
  shell.fitNow?.();
  try {
    const { id } = await post('term', { op: 'open', cols: term.cols, rows: term.rows });
    Object.assign(shell, { id, drawn: 0, size: `${term.cols}x${term.rows}` });
    shell.item.dataset.state = TerminalState.Running;
    shell.banner.hidden = true;
    changed();
    restream();
  } catch (error) {
    ended(shell, TerminalState.Gone, `Couldn't start a shell: ${(error as Error).message}`);
  }
}

/** A terminal item. A new one (no `shell`) starts a shell and takes the keyboard; a restored one reattaches. */
export function terminalWindow(saved: Partial<SavedTerminal> = {}) {
  const center = viewCenter();
  const { el: item, body } = makeWindow({
    kind: 'terminal',
    cls: 'tnode',
    title: saved.title ?? 'Terminal',
    minW: 240,
    minH: 140,
    rect: saved.rect ?? freeSpot({ x: center.x - 320, y: center.y - 200, w: 640, h: 400 }),
    actions: [
      iconButton(
        ICON.expand,
        'Fullscreen: Ctrl+W, Ctrl+T and Ctrl+N go to the shell (Chrome, Edge); hold Esc to leave',
        () => void fullscreen(shell),
      ),
      removeButton('Close terminal (its shell is stopped once Undo is gone)', closeShell),
    ],
  });
  item.dataset.id = saved.id ?? uuid();
  item.dataset.state = TerminalState.Running;
  const frame = body.appendChild(make('div', 'tframe')),
    screen = frame.appendChild(make('div', 'tscreen'));
  const banner = body.appendChild(make('div', 'tbanner'));
  banner.append(
    make('span'),
    button('Restart', 'btn', () => void start(shell)),
  );
  banner.hidden = true;
  const shell: Shell = { item, id: saved.shell ?? '', drawn: 0, pending: '', size: '', banner };
  shells.set(item, shell);
  const flush = perFrame(() => {
    const data = shell.pending;
    shell.pending = '';
    if (data && shell.id) post('term', { op: 'keys', id: shell.id, data }).catch(() => {});
  });
  void emulator(screen, frame, data => {
    shell.pending += data;
    flush();
  }).then(made => {
    if (!shells.has(item)) return made.term.dispose(); // closed while it loaded
    shell.emulator = made;
    const fit = () => {
      if (!frame.clientWidth || !frame.clientHeight) return; // collapsed
      made.fit.fit();
      const size = `${made.term.cols}x${made.term.rows}`;
      if (size === shell.size || !shell.id) return;
      shell.size = size;
      post('term', { op: 'resize', id: shell.id, cols: made.term.cols, rows: made.term.rows }).catch(() => {});
    };
    shell.fitNow = fit;
    new ResizeObserver(perFrame(fit)).observe(frame);
    if (shell.id) return restream(); // reattach: the stream replays what the server kept, then the resize makes full-screen programs redraw
    void start(shell);
    if (saved.rect) return; // restored before its shell ever started: no keyboard grab on reload
    centerOn(item);
    made.term.focus();
  });
  return item;
}

/** Browsers keep Ctrl+W, Ctrl+T and Ctrl+N from every page, except in fullscreen with the keyboard locked
 *  (Chromium's Keyboard Lock): there they reach the shell, and holding Esc leaves. */
async function fullscreen(shell: Shell) {
  const frame = shell.item.querySelector<HTMLElement>('.tframe')!;
  try {
    await frame.requestFullscreen();
    await (navigator as NavigatorWithKeyboard).keyboard?.lock();
  } catch {
    /* refused (no user gesture, or Firefox has no lock): plain fullscreen, or none */
  }
  shell.emulator?.term.focus();
}
interface NavigatorWithKeyboard {
  keyboard?: {
    lock: () => Promise<void>;
    unlock: () => void;
  };
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) (navigator as NavigatorWithKeyboard).keyboard?.unlock();
});
// Ctrl+W in terminal mode (deleting a word, to the shell) closes the tab in every browser: ask first instead. The shells
// themselves would survive (the server keeps them), but the page and what you were doing wouldn't.
addEventListener('beforeunload', event => {
  if (document.activeElement?.closest('.tnode [data-own-keys]')) event.preventDefault();
});

/** The item is gone for good (Undo expired): stop its shell. */
function closeShell(item: HTMLElement) {
  const shell = shells.get(item);
  shells.delete(item);
  if (shell?.id) post('term', { op: 'close', id: shell.id }).catch(() => {});
  shell?.emulator?.term.dispose();
  restream();
  if (nothingToWorkIn()) newSession(); // the last terminal of a canvas without sessions: start one, as closing the last card does
}
onGone(item => {
  if (item.dataset.kind === 'terminal' && shells.has(item)) closeShell(item);
});

removable('terminal', null); // a deleted selection clicks its ×: Undo, then the shell stops

onPrefs(() => {
  for (const shell of shells.values()) {
    if (!shell.emulator) continue;
    Object.assign(shell.emulator.term.options, looks());
    shell.fitNow?.(); // a new font size: more or fewer rows and columns
  }
});

onTheme(() => {
  for (const shell of shells.values()) if (shell.emulator) shell.emulator.term.options.theme = palette();
});

/** Open a new terminal, if the server can run one here. */
export async function newTerminal() {
  supported ??= await api<{ supported: boolean }>('term')
    .then(answer => answer.supported)
    .catch(() => undefined);
  if (supported === false) return toast("Terminals aren't supported on this system.");
  terminalWindow();
}

command({
  label: 'New terminal',
  group: 'Items',
  keys: ['$mod+Backquote'],
  run: () => void newTerminal(),
  anywhere: true, // a Ctrl combo types nothing: works from a message box too, as Ctrl+K does
});

// described on the ? sheet (xterm.ts handles them)
command({
  label: 'Terminal: to normal mode (canvas keys work again)',
  group: 'Windows',
  keys: ['Control+Backslash'],
});
command({ label: 'Terminal: back to terminal mode', group: 'Windows', keys: ['i'] });

persist(
  'terminals',
  () =>
    items('terminal').map(
      (item): SavedTerminal => ({
        id: item.dataset.id!,
        shell: shells.get(item)?.id ?? '',
        title: winTitle(item),
        rect: savedRect(item) as Rect,
      }),
    ),
  (list: SavedTerminal[]) => each(list, saved => void terminalWindow(saved)),
);
