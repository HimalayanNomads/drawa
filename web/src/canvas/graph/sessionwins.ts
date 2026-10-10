// biome-ignore-all assist/source/organizeImports: import order here is evaluation order, which sets registration order (see CLAUDE.md)
// A session's own windows: its Files window (one row per file it touched, grouped by folder), its commands window
// (every shell command with its output), and files you put on the canvas by themselves from the file tree. The
// arrows from the session to them are canvas/graph/graph.ts's.
import { tipText } from '../../lib/tooltip';
import { make, ping, iconButton } from '../../lib/dom';
import { persist } from '../../lib/store';
import { addItem, place, rect, savedRect, type Rect } from '../core/items';
import { draggable } from '../core/drag';
import { spotBeside } from '../core/placement';
import { changed } from '../core/view';
import { makeWindow } from '../core/window';
import { referable } from '../core/refs';
import { redraw, forget, type Act } from './graph'; // used only inside functions (graph.ts imports this module)
import type { Session } from '../../types/session';
import type { Change } from '../../panels/diff';

/** Everything known about one file across sessions: its diffs (for the inspector) and where it's shown. */
export interface FileInfo {
  path: string;
  add: number;
  del: number;
  changes: Change[];
  kind: Act | 'fail';
  rows: Set<HTMLElement>;
  node?: HTMLElement;
}
export interface FileList {
  el: HTMLElement;
  list: HTMLElement;
  count: HTMLElement;
  rows: Map<string, HTMLElement>;
}
interface TermNode {
  el: HTMLElement;
  list: HTMLElement;
  count: HTMLElement;
  n: number;
}

/** The file inspector, registered by panels/files.ts: canvas code opens files in it without importing upward. */
let inspector = { open: (_path: string) => {}, current: (): string | null => null };
/** Hand over the file inspector (panels/files.ts): canvas can't import panels. */
export const setInspector = (i: typeof inspector) => {
  inspector = i;
};
/** A file changed: if it's the one open in the inspector, show the change. */
export const refreshInspector = (path: string) => {
  if (inspector.current() === path) inspector.open(path);
};

export const files = new Map<string, FileInfo>();
const lists = new Map<Session, FileList>();
const terms = new Map<Session, TermNode>();
/** Positions restored from the saved layout: "f:<path>" pinned files, "l:<sid>" Files windows, "t:<sid>" commands windows, "p:<id>" plans. */
export const savedPos: Record<string, Rect | { x: number; y: number }> = {};
persist('nodes', nodePositions, v => Object.assign(savedPos, v), 0);
referable('files', {
  icon: '≡',
  label: () => 'files a session touched',
  content: el => ({
    text:
      'Files a session on my canvas worked with (edit/write = changed, read = only read):\n' +
      [...el.querySelectorAll<HTMLElement>('.frow')]
        .map(r => `- ${tipText(r)} (${r.dataset.state ?? 'read'})`)
        .join('\n'),
  }),
});
referable('run', {
  icon: '$',
  name: 'commands',
  label: () => 'commands a session ran',
  content: el => {
    let budget = 20_000; // ponytail: long outputs are cut, newest commands first to keep
    const rows = [...el.querySelectorAll<HTMLElement>('.tcmd')]
      .reverse()
      .map(r => {
        const out = (r.querySelector('pre')?.textContent ?? '').slice(-Math.max(0, Math.min(3000, budget)));
        budget -= out.length;
        return `$ ${tipText(r) || r.querySelector('summary')?.textContent}\n${out}`;
      })
      .reverse();
    return { text: `Commands a session on my canvas ran, with their output:\n\n\`\`\`\n${rows.join('\n\n')}\n\`\`\`` };
  },
});
referable('file', {
  icon: '≡',
  label: el => tipText(el),
  content: (_, path) => ({ text: `File: ${path} (read it if you need its contents)` }),
});

/* ---------- files ---------- */
export function fileInfo(path: string): FileInfo {
  let f = files.get(path);
  if (!f) files.set(path, (f = { path, add: 0, del: 0, changes: [], kind: 'read', rows: new Set() }));
  return f;
}
const RANK_FILE = { write: 0, edit: 1, fail: 2, read: 3 } as Record<string, number>;
/** "+3 −1": a file's added and removed line counts, when it has any. */
const diffStat = (f: FileInfo) =>
  f.add || f.del ? [make('span', 'a', `+${f.add}`), ' ', make('span', 'r', `−${f.del}`)] : [];

/** Every place a file shows (rows in Files windows, its pinned node) reflects its state. */
export function paintFile(f: FileInfo) {
  for (const el of [...f.rows, ...(f.node ? [f.node] : [])]) {
    el.dataset.state = f.kind;
    el.classList.toggle('sel', inspector.current() === f.path);
    el.querySelector('.s')!.replaceChildren(...diffStat(f));
  }
}

/** The session's Files window: right of its card, one row per file, grouped by folder, changed files first. */
export function fileList(S: Session): FileList {
  const have = lists.get(S);
  if (have) return have;
  const saved = S.sid ? (savedPos[`l:${S.sid}`] as Rect | undefined) : undefined;
  const count = make('span', 'm'),
    list = make('div', 'flist');
  const reads = iconButton(
    '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
    'Hide files that were only read',
    () => {
      const hide = l.el.classList.toggle('hide-reads');
      reads.classList.toggle('on', hide);
      reads.title = hide ? 'Show files that were only read' : 'Hide files that were only read';
    },
  );
  // collapsed to its tab by default, like commands: the count says enough until you want the list (your choice is saved)
  const { el, head, body } = makeWindow({
    kind: 'files',
    cls: 'lnode',
    title: 'files',
    rect: { min: true, ...spotBeside(S.card, 300, 380, 150, 0), ...saved },
    minW: 220,
    minH: 120,
    actions: [reads],
  });
  el.dataset.id = `l:${S.cid}`; // stable across reloads (the card's id is saved), so arrows and pins come back
  head.querySelector('.t')!.after(count);
  body.append(list);
  const l: FileList = { el, list, count, rows: new Map() };
  lists.set(S, l);
  return l;
}

/** A file's row in a session's Files window, under its folder. */
export function addRow(l: FileList, f: FileInfo) {
  const slash = f.path.lastIndexOf('/'),
    dir = slash > 0 ? f.path.slice(0, slash + 1) : './';
  const row = make('button', 'frow');
  row.title = f.path;
  row.dataset.dir = dir;
  row.append(make('span', 'g'), make('span', 'n', f.path.slice(slash + 1)), make('span', 's'));
  row.onclick = () => inspector.open(f.path);
  l.rows.set(f.path, row);
  f.rows.add(row);
  let group = [...l.list.children].find(g => (g as HTMLElement).dataset.dir === dir) as HTMLElement | undefined;
  if (!group) {
    group = make('div', 'fgroup');
    group.dataset.dir = dir;
    group.append(make('div', 'fdir', dir));
    l.list.append(group); // sortFileRow() puts it in place
  }
  group.append(row);
  return row;
}

/** Keep changed files at the top of their folder, and the header count current. */
export function sortFileRow(l: FileList, row: HTMLElement) {
  const group = row.parentElement!,
    rank = (r: Element) => RANK_FILE[(r as HTMLElement).dataset.state ?? 'read'];
  const before = [...group.querySelectorAll(':scope > .frow')].find(r => r !== row && rank(r) > rank(row));
  if (before && before !== row.nextSibling) group.insertBefore(row, before);
  const all = [...l.rows.values()],
    changed = all.filter(r => r.dataset.state !== 'read').length;
  l.count.textContent = changed ? `${changed} changed · ${all.length - changed} read` : `${all.length} read`;
  group.classList.toggle(
    'reads-only',
    ![...group.querySelectorAll(':scope > .frow')].some(r => (r as HTMLElement).dataset.state !== 'read'),
  );
  /** A folder group's sort key. */
  // folders with changes first, then folders that were only read; each in path order
  const key = (g: Element) => (g.classList.contains('reads-only') ? '1' : '0') + (g as HTMLElement).dataset.dir;
  const groups = [...l.list.children].sort((a, b) => key(a).localeCompare(key(b)));
  if (groups.some((g, i) => g !== l.list.children[i])) l.list.append(...groups);
}

/** A file on the canvas by itself, opened from the file tree. */
function fileNode(f: FileInfo): HTMLElement {
  if (f.node) return f.node;
  const el = make('div', 'fnode'),
    n = make('span', 'n'),
    slash = f.path.lastIndexOf('/');
  const ext = f.path.includes('.') ? f.path.split('.').pop()!.slice(0, 4) : 'file';
  n.append(make('b', '', f.path.slice(slash + 1)), make('small', '', slash > 0 ? f.path.slice(0, slash + 1) : './'));
  el.append(make('span', 'g', ext), n, make('span', 's'));
  el.title = f.path;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Open ${f.path}`);
  el.dataset.id = `f:${f.path}`;
  addItem(el, 'file');
  const p = savedPos[`f:${f.path}`] ?? spotBeside(null, 220, 44);
  place(el, p.x, p.y);
  f.node = el;
  draggable(el, el, redraw, () => inspector.open(f.path));
  el.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inspector.open(f.path);
    }
  };
  el.append(
    iconButton(
      '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
      'Remove from canvas',
      () => {
        forget(el);
        el.remove();
        f.node = undefined;
        changed();
      },
      'fdel',
    ),
  );
  paintFile(f);
  return el;
}

/** A session's commands window, made once (below its card, or where it was saved). */
export function termNode(S: Session): TermNode {
  const have = terms.get(S);
  if (have) return have;
  const r = rect(S.card),
    saved = S.sid ? (savedPos[`t:${S.sid}`] as Rect | undefined) : undefined;
  const at = saved ?? spotBeside(S.card, 420, 240, 40 - r.w, r.h + 90); // below the card (inside its group, if it's in one)
  const count = make('span', 'm'),
    list = make('div', 'cmds-list');
  // collapsed to its tab by default: the run count says enough until you want the output (your choice is saved)
  const { el, head, body } = makeWindow({
    kind: 'run',
    cls: 'tnode',
    title: 'commands',
    rect: { min: true, ...at, ...saved },
    minW: 240,
    minH: 120,
  });
  el.dataset.id = `t:${S.cid}`;
  head.querySelector('.t')!.after(count);
  body.append(list);
  const t = { el, list, count, n: 0 };
  terms.set(S, t);
  return t;
}

/** Card closed: drop its commands and Files windows, and files nothing shows any more. */
export function dropWindows(S: Session) {
  // a rebuild (reload() after a gap) makes them again from savedPos: keep where they are now, not where the page
  // loaded them, or a window you moved jumps back
  if (S.sid) Object.assign(savedPos, nodePositions());
  terms.get(S)?.el.remove();
  terms.delete(S);
  const l = lists.get(S);
  if (l) {
    l.el.remove();
    lists.delete(S);
    for (const [path, row] of l.rows) files.get(path)?.rows.delete(row);
  }
  for (const [path, f] of files) if (!f.rows.size && !f.node) files.delete(path);
}

/** Put a file on the canvas by itself (opened from the file tree). */
export function pinFile(path: string) {
  const el = fileNode(fileInfo(path));
  ping(el);
  redraw();
  return el;
}

/** Repaint every file's rows, so the one open in the inspector shows as selected. */
export function refreshSelection() {
  for (const f of files.values()) paintFile(f);
}

/** Where the pinned file nodes and commands windows are, for the saved layout. */
function nodePositions() {
  const pos: typeof savedPos = {};
  for (const [path, f] of files)
    if (f.node) {
      const r = rect(f.node);
      pos[`f:${path}`] = { x: r.x, y: r.y };
    }
  for (const [S, l] of lists) if (S.sid) pos[`l:${S.sid}`] = savedRect(l.el);
  for (const [S, t] of terms) if (S.sid) pos[`t:${S.sid}`] = savedRect(t.el);
  return pos;
}
