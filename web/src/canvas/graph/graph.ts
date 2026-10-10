// The work as a graph: session card --action--> its Files window, --run--> its commands window, --plan/ref--> other items.
// Files a session touches are rows in one Files window per session (grouped by folder), not one node each:
// a session that reads 100 files is still one window and one edge. A file becomes its own canvas node only when
// you open it from the file tree. The windows themselves are canvas/graph/sessionwins.ts's; this module draws the arrows.
import { make, ping, truncate } from '../../lib/dom';
import { each, persist } from '../../lib/store';
import type { Change } from '../../panels/diff';
import type { Session } from '../../types/session';
import { byIds, hidden, items, liveRect, onCanvas, place, rect } from '../core/items';
import { changed, onChange, view, world } from '../core/view';
import {
  addRow,
  dropWindows,
  type FileInfo,
  fileInfo,
  fileList,
  paintFile,
  refreshInspector,
  sortFileRow,
  termNode,
} from './sessionwins';

// what other modules have always imported from here
export { files, pinFile as pin, refreshSelection, savedPos } from './sessionwins';

export type Act = 'read' | 'edit' | 'write' | 'run' | 'plan' | 'made' | 'agent' | 'ref';
const RANK: Act[] = ['plan', 'write', 'edit', 'run', 'agent', 'made', 'read', 'ref']; // which action colors an edge that carries several
interface Edge {
  S: Session;
  target: HTMLElement;
  path: SVGPathElement;
  label: HTMLElement;
  counts: Partial<Record<Act, number>>;
  live: number;
}
interface Pending {
  edge: Edge;
  file?: FileInfo;
  row?: HTMLElement;
  cmd?: HTMLDetailsElement;
  act: Act;
}

const edges = new Map<Session, Map<HTMLElement, Edge>>();
const pending = new Map<string, Pending>(); // tool_use id -> what to settle when its result arrives
const svg = document.getElementById('edges') as unknown as SVGSVGElement;
const SVGNS = 'http://www.w3.org/2000/svg';

/* ---------- edges ---------- */
function edge(S: Session, target: HTMLElement): Edge {
  let m = edges.get(S);
  if (!m) edges.set(S, (m = new Map()));
  let e = m.get(target);
  if (!e) {
    const path = document.createElementNS(SVGNS, 'path');
    const label = make('div', 'elabel');
    svg.append(path);
    world.append(label);
    e = { S, target, path, label, counts: {}, live: 0 };
    m.set(target, e);
  }
  return e;
}

/** Color an edge by the strongest thing done along it (write over edit over read) and label it with the counts. */
function paintEdge(e: Edge) {
  const act = RANK.find(a => e.counts[a]) ?? 'read';
  e.path.setAttribute('class', `edge ${act}${e.live ? ' live' : ''}`);
  e.label.className = `elabel ${act}`;
  e.label.textContent = RANK.filter(a => e.counts[a])
    .map(a => (e.counts[a]! > 1 ? `${a} ×${e.counts[a]}` : a))
    .join(' · ');
}

/** Does this edge move when the view pans or zooms (one end pinned or floating)? */
// a pan or zoom moves only edges with a pinned or floating end (the rest are in world coordinates)
const loose = (e: Edge) => !onCanvas(e.S.card) || !onCanvas(e.target);
onChange(viewOnly => {
  if (viewOnly && [...edges.values()].some(m => [...m.values()].some(loose))) schedule(true);
});

let drawing = false,
  moved = false,
  only = true;
/** Recompute every edge's curve from the current card / node positions (next frame, batched). */
export const redraw = () => schedule(false); // no arguments: it's passed around as a callback
/** `viewOnly`: only the view changed, so only edges with a pinned or floating end move, and nothing else on the
 *  canvas is told: a view change already reached every listener (telling them again would loop, once a frame). */
function schedule(viewOnly: boolean) {
  moved ||= !viewOnly;
  only &&= viewOnly;
  if (drawing) return;
  drawing = true;
  requestAnimationFrame(() => {
    const all = !only,
      didMove = moved;
    drawing = false;
    moved = false;
    only = true;
    // every edge measured first, then all written: one layout, not one per edge
    const todo = [...edges.values()]
      .flatMap(m => [...m.values()])
      .filter(e => all || loose(e))
      .map(measure);
    todo.forEach(w => w());
    if (didMove) changed(); // cards or nodes moved: the minimap and the saved layout follow
  });
}

/** Where an edge's curve goes (layout reads only); returns the writes that put it there. */
function measure(e: Edge): () => void {
  // full view covers the canvas: its arrows would only draw over it. Pinned windows keep theirs.
  // (and arrows to windows gathered under their collapsed session: they sit right there)
  const hide =
    e.S.card.classList.contains('full') ||
    e.target.classList.contains('full') ||
    !!e.target.dataset.home ||
    hidden(e.S.card) ||
    hidden(e.target); // inside a collapsed group
  if (hide)
    return () => {
      e.path.style.display = e.label.style.display = 'none';
    };
  const a = liveRect(e.S.card),
    b = liveRect(e.target);
  const s = onCanvas(e.target) ? 1 : 1 / view.k; // a pinned window isn't scaled with the canvas: its offsets are screen px
  let sx: number, sy: number, tx: number, ty: number, c1x: number, c1y: number, c2x: number, c2y: number;
  // every edge aims at the target window's tab: it stays put as the window grows or collapses (then it's all there is)
  const head = e.target.querySelector<HTMLElement>(':scope > header');
  const hx = head ? b.x + head.offsetLeft * s : b.x,
    hw = head ? head.offsetWidth * s : b.w;
  const below = b.y > a.y + a.h + 20 && b.x + b.w > a.x && b.x < a.x + a.w;
  if (below) {
    // commands-style: leave from the card's bottom edge, down onto the tab
    tx = hx + hw / 2;
    ty = b.y;
    sx = Math.min(Math.max(tx, a.x + 40), a.x + a.w - 40);
    sy = a.y + a.h;
    const d = Math.max(40, (ty - sy) / 2);
    c1x = sx;
    c1y = sy + d;
    c2x = tx;
    c2y = ty - d;
  } else {
    // leave from the side facing the node, at the node's height when possible
    const right = b.x + b.w / 2 >= a.x + a.w / 2;
    sx = right ? a.x + a.w : a.x;
    tx = right ? hx - 4 : hx + hw + 4;
    ty = b.y + (head ? (head.offsetTop + head.offsetHeight / 2) * s : b.h / 2);
    sy = Math.min(Math.max(ty, a.y + Math.min(60, a.h / 2)), a.y + a.h - Math.min(40, a.h / 2)); // a collapsed card: its tab's middle
    const d = Math.max(60, Math.abs(tx - sx) / 2) * (right ? 1 : -1);
    c1x = sx + d;
    c1y = sy;
    c2x = tx - d;
    c2y = ty;
  }
  const d = `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`;
  const lx = (sx + 3 * c1x + 3 * c2x + tx) / 8,
    ly = (sy + 3 * c1y + 3 * c2y + ty) / 8; // label at the curve's midpoint
  return () => {
    e.path.style.display = e.label.style.display = '';
    e.path.setAttribute('d', d);
    e.label.style.left = `${lx}px`;
    e.label.style.top = `${ly}px`;
  };
}

/* ---------- what chat.ts calls ---------- */
/** Claude read / edited / wrote a file. */
export function touchedFile(S: Session, toolId: string, act: Act, path: string, chg?: Change) {
  const f = fileInfo(path),
    l = fileList(S),
    e = edge(S, l.el);
  const row = l.rows.get(path) ?? addRow(l, f);
  e.counts[act] = (e.counts[act] ?? 0) + 1;
  e.live++;
  if (chg) {
    f.changes.unshift(chg);
    f.add += chg.add;
    f.del += chg.del;
  }
  if (act !== 'read' && f.kind !== 'write') f.kind = act; // write outranks edit outranks read
  paintFile(f);
  row.classList.add('live');
  sortFileRow(l, row);
  paintEdge(e);
  pending.set(toolId, { edge: e, file: f, row, act });
  redraw();
  refreshInspector(path);
}

/** Claude ran a shell command. */
export function ranCommand(S: Session, toolId: string, cmd: string) {
  const t = termNode(S),
    e = edge(S, t.el);
  // one expandable row per command: summary = first line, body = full command + output (filled in by settle)
  const row = make('details', 'tcmd live'),
    sum = make('summary', '', cmd.split('\n')[0]),
    out = make('pre');
  out.textContent = `$ ${cmd}`;
  row.append(sum, out);
  row.title = cmd;
  t.list.prepend(row);
  while (t.list.children.length > 200) t.list.lastElementChild!.remove(); // ponytail: newest 200 kept
  t.n++;
  t.count.textContent = `${t.n} run${t.n === 1 ? '' : 's'}`;
  e.counts.run = (e.counts.run ?? 0) + 1;
  e.live++;
  paintEdge(e);
  ping(t.el);
  pending.set(toolId, { edge: e, cmd: row, act: 'run' });
  redraw();
}

/** A tool finished: stop the edge flowing, mark failures. */
const status = (d: HTMLDetailsElement, s: string) => {
  d.classList.remove('live', 'ok', 'bad', 'stopped');
  d.classList.add(s);
};
/** A tool call finished: its edge stops showing it as running, and a command's row gets its output and result. */
export function settle(toolId: string, ok: boolean, output?: string) {
  const p = pending.get(toolId);
  if (!p) return;
  pending.delete(toolId);
  p.edge.live = Math.max(0, p.edge.live - 1);
  paintEdge(p.edge);
  if (p.cmd) {
    status(p.cmd, ok ? 'ok' : 'bad');
    if (output) p.cmd.querySelector('pre')!.append(`\n\n${truncate(output, 20_000)}`);
  }
  p.row?.classList.remove('live');
  if (p.file && !ok && p.act !== 'read') {
    p.file.kind = 'fail';
    paintFile(p.file);
  }
}

/** The session's request ended (done, stopped or errored): nothing on its edges is running any more. */
export function requestEnded(S: Session) {
  for (const [id, p] of pending) {
    if (p.edge.S !== S) continue;
    pending.delete(id);
    p.edge.live = 0;
    paintEdge(p.edge);
    if (p.cmd) status(p.cmd, 'stopped');
    p.row?.classList.remove('live');
  }
}

/** Card closed: drop its edges, commands and Files windows, and files nothing shows any more. */
export function dropSession(S: Session) {
  requestEnded(S);
  for (const e of edges.get(S)?.values() ?? []) {
    e.path.remove();
    e.label.remove();
  }
  edges.delete(S);
  dropWindows(S);
  // (plan nodes are removed by plan.ts)
  redraw();
}

/** Wire any other node to its session (plan documents). */
export function link(S: Session, el: HTMLElement, act: Act) {
  const e = edge(S, el);
  e.counts[act] = Math.max(1, e.counts[act] ?? 0);
  paintEdge(e);
  redraw();
}

/* ---------- a session's own windows (Files, commands, plans, what its Claude made) fold with it ---------- */
const owned = (e: Edge) =>
  !!(e.counts.made || e.counts.plan || e.counts.agent) || ['files', 'run'].includes(e.target.dataset.kind ?? '');
/** A window's collapse button. */
const minBtn = (el: HTMLElement) => el.querySelector<HTMLElement>(':scope > .win-h .minbtn');
document.addEventListener('collapse', ev => {
  const S = [...edges.keys()].find(s => s.card === ev.target),
    min = (ev as CustomEvent<boolean>).detail;
  if (!S) return;
  // collapse what's open, and on expand reopen only those: windows you collapsed yourself stay collapsed. On the
  // canvas they also gather as a stack of tabs under the session's tab, and go back to their places on expand
  // (saved: see 'gathered' below). Stacked by the tab's height: no layout reads in the loop.
  const a = rect(S.card),
    step = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tab-h')) || 34) + 6;
  let y = a.y + a.h + 10;
  for (const e of edges.get(S)!.values()) {
    const t = e.target;
    if (!owned(e) || t.classList.contains('full')) continue;
    if (min) {
      if (!t.classList.contains('min')) {
        t.dataset.folded = '1';
        minBtn(t)?.click();
      }
      if (onCanvas(t) && t.classList.contains('win') && !t.dataset.home) {
        // already collapsed ones come along too
        t.dataset.home = `${parseFloat(t.style.left) || 0},${parseFloat(t.style.top) || 0}`;
        place(t, a.x + 24, y);
        y += step;
      }
    } else {
      if (t.dataset.home && onCanvas(t)) {
        const [x, hy] = t.dataset.home.split(',').map(Number);
        place(t, x, hy);
      }
      delete t.dataset.home;
      if (t.dataset.folded) {
        delete t.dataset.folded;
        if (t.classList.contains('min')) minBtn(t)?.click();
      }
    }
  }
  redraw();
  changed();
});

// a window you drag out of the pile is yours again: it stays where you put it (and its arrow shows again)
document.addEventListener('moved', ev => {
  const t = ev.target as HTMLElement;
  if (!t.dataset.home) return;
  delete t.dataset.home;
  redraw();
});
// where gathered windows came from, and which ones the session folded, so expanding after a reload still undoes it
persist(
  'gathered',
  () =>
    Object.fromEntries(
      items()
        .filter(el => el.dataset.id && (el.dataset.home || el.dataset.folded))
        .map(el => [el.dataset.id!, { home: el.dataset.home, folded: !!el.dataset.folded }]),
    ),
  (v: Record<string, { home?: string; folded?: boolean }>) => {
    const found = byIds();
    each(Object.entries(v ?? {}), ([id, g]) => {
      const el = found.get(id);
      if (!el) return;
      if (g.home) el.dataset.home = g.home;
      if (g.folded) el.dataset.folded = '1';
    });
    redraw();
  },
  2,
);

/** Links to canvas items a session's Claude made or edited (canvas tools). Replaying the transcript rebuilds file
 *  links, not these, so they're saved with the layout (see session/card/saved.ts). */
export const itemLinks = () =>
  [...edges].flatMap(([S, m]) =>
    [...m.values()]
      .filter(
        e =>
          e.target.dataset.id &&
          (e.counts.made || (e.counts.edit && !['file', 'files', 'run'].includes(e.target.dataset.kind ?? ''))),
      )
      .map(e => ({ cid: S.cid, id: e.target.dataset.id!, acts: (['made', 'edit'] as const).filter(a => e.counts[a]) })),
  );

/** Take one kind of link off a session's edge to a node (e.g. a reference chip removed before sending);
 *  the edge goes away only when nothing else connects them. Without `act`, drop the whole edge. */
export function unlink(S: Session, el: HTMLElement, act?: Act) {
  const e = edges.get(S)?.get(el);
  if (!e) return;
  if (act) delete e.counts[act];
  if (act && Object.keys(e.counts).length) return paintEdge(e);
  e.path.remove();
  e.label.remove();
  edges.get(S)!.delete(el);
  changed();
}

const forgotten: ((el: HTMLElement) => void)[] = [];
/** Run `fn` for every node that leaves the canvas (a message box drops its reference to it). */
export const onForget = (fn: (el: HTMLElement) => void) => {
  forgotten.push(fn);
};

/** A node left the canvas: drop every edge pointing at it. Returns what brings them back (an undone delete). */
export function forget(el: HTMLElement) {
  const had = [...edges.values()].flatMap(m => m.get(el) ?? []).map(e => ({ S: e.S, counts: { ...e.counts } }));
  for (const S of edges.keys()) unlink(S, el);
  for (const fn of forgotten) fn(el);
  return () => {
    for (const h of had)
      if (h.S.card.isConnected) {
        const e = edge(h.S, el);
        Object.assign(e.counts, h.counts);
        paintEdge(e);
      }
    redraw();
  };
}
