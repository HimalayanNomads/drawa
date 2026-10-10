// Claude's canvas tools. the Go server serves them over MCP to each card's Claude process and relays every call to
// this page, which carries it out here and posts the answer back. Item kinds register what Claude may create
// (`creatable`); reading reuses what `referable` already knows about each kind.
import { post } from '../../lib/api';
import { ping, toast, uuid } from '../../lib/dom';
import type { Session } from '../../types/session';
import { link } from '../graph/graph';
import { addLink, endById, userLinks } from '../graph/links';
import { canvasStrokes, hasInkOver, shapesOn, strokeRect, textsOn } from '../ink/inksel';
import { SHAPE_NAME } from '../ink/shapegeom';
import type { Stroke } from '../ink/stroke';
import { bringToFront, items, onCanvas, type Rect, rect, shortId } from './items';
import { centerOn, spotBeside } from './placement';
import { readItem } from './refs';
import { snapshot } from './snapshot';
import { changed } from './view';
import { expand, setTitle, titleOf } from './window';

type Args = Record<string, any>;
interface Creatable {
  /** The argument it can't do without (default text). */
  needs?: string;
  size: (a: Args) => { w: number; h: number };
  create: (a: Args, r: Rect) => HTMLElement | Promise<HTMLElement>;
  /** canvas_update: change an existing item's content (`a.text`); may throw, the message goes back to Claude. */
  update?: (el: HTMLElement, a: Args) => void | Promise<void>;
}
const makers = new Map<string, Creatable>();
/** Let Claude create items of this kind (canvas_create). `create` may throw: the message goes back to Claude. */
export const creatable = (kind: string, c: Creatable) => {
  makers.set(kind, c);
};

/** A call relayed from the server: run it, answer with an MCP tool result. */
export async function canvasCall(S: Session, m: { id: string; tool: string; args?: Args }) {
  let result: object;
  try {
    result = { content: await runTool(S, m.tool, m.args ?? {}) };
  } catch (e) {
    result = { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
  /** Send the tool call's result back to the server. */
  // lost, Claude would wait out the server's timeout: try once more, then say which call it was
  const answer = () => post('canvas', { cid: S.cid, id: m.id, result });
  answer()
    .catch(() => answer())
    .catch(e => console.error(`canvas tool ${m.tool}: couldn't answer the agent:`, e));
}

/** An item's id as Claude sees it (UUIDs cut to 8 characters). */
const shortIdOf = (el: HTMLElement) => shortId(el.dataset.id ?? '');
/** The id of an arrow's end: an item's, or a drawing's. */
const endId = (e: HTMLElement | Stroke) => (e instanceof HTMLElement ? shortIdOf(e) : shortId(e.id ?? ''));
/** The item Claude means: its exact id first (readable ids like "git" are prefixes of others), then a UUID prefix,
 *  only when just one item has it: a guess could change the wrong item. */
function find(id: unknown): HTMLElement {
  const want = String(id ?? '').trim(),
    all = items();
  const exact = want && all.find(e => e.dataset.id === want);
  if (exact) return exact;
  const some = want ? all.filter(e => e.dataset.id?.startsWith(want)) : [];
  if (some.length > 1)
    throw new Error(
      `Id "${want}" matches ${some.length} items: ${some
        .slice(0, 10)
        .map(e => e.dataset.id)
        .join(', ')}. Use a longer id.`,
    );
  if (!some.length) throw new Error(`No canvas item with id "${want}". Call canvas_list for the current ids.`);
  return some[0];
}

/** Shapes and text drawn on the canvas itself, which arrows can join too (pen strokes are left out: there can be
 *  hundreds). Naming one gives it an id, saved with the drawing. */
function drawings() {
  const list = canvasStrokes().filter(s => s.sh || s.t != null);
  if (list.some(s => !s.id)) {
    list.forEach(s => (s.id ??= uuid()));
    changed();
  }
  return list.map(s => {
    const r = strokeRect(s);
    return {
      id: shortId(s.id!),
      kind: s.sh ? SHAPE_NAME[s.sh] : 'text',
      ...(s.t ? { text: s.t.slice(0, 80) } : {}),
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.w),
      h: Math.round(r.h),
    };
  });
}
/** An arrow end: an item, else a drawing from canvas_list (exact id or a unique prefix). */
function findEnd(id: unknown): HTMLElement | Stroke {
  try {
    return find(id);
  } catch (e) {
    const want = String(id ?? '').trim(),
      exact = want && endById(want);
    if (exact) return exact;
    const some = want ? canvasStrokes().filter(s => s.id?.startsWith(want)) : [];
    if (some.length === 1) return some[0];
    throw e;
  }
}

/** Someone is typing in it (a note, a doc's or a diagram's source box, its title), or it holds a draft that isn't
 *  saved yet (data-state="editing"): Claude's text would replace theirs, and Ctrl+Z can't bring it back. */
function editing(el: HTMLElement) {
  const f = document.activeElement;
  return (
    el.dataset.state === 'editing' ||
    (f instanceof HTMLElement && f !== el && el.contains(f) && (f.isContentEditable || f.matches('textarea, input')))
  );
}

/** Bring an item the agent made or changed into view (the chat's Canvas row): `id` as the tool answered it. */
export function showItem(id: string) {
  let el: HTMLElement;
  try {
    el = find(id);
  } catch {
    return toast("That item isn't on the canvas any more.");
  }
  expand(el);
  if (onCanvas(el)) {
    bringToFront(el);
    centerOn(el);
  } else el.scrollIntoView({ block: 'nearest' }); // pinned to the sidebar
  ping(el);
}

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
/** A tool result holding one text block. */
const textBlocks = (t: string): Block[] => [{ type: 'text', text: t }];

/** Run one canvas tool call from a card's agent and return its result blocks; throws with a message the agent sees. */
async function runTool(S: Session, tool: string, a: Args): Promise<Block[]> {
  if (tool === 'canvas_list') {
    return textBlocks(
      JSON.stringify({
        items: items().map(el => {
          const r = rect(el);
          return {
            id: shortIdOf(el),
            kind: el.dataset.kind,
            title: titleOf(el).slice(0, 80),
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: r.w,
            h: r.h,
            ...(el.classList.contains('min') ? { collapsed: true } : {}),
            ...(el === S.card ? { you: true } : {}),
            ...(hasInkOver(el, r) ? { drawnOn: true } : {}),
          };
        }),
        drawings: drawings(),
        arrows: userLinks(),
      }),
    ); // arrows the user (or you) drew between items and drawings
  }
  if (tool === 'canvas_read') {
    // its content as text, and a picture when someone drew on it (or when asked): ink never shows up in the text
    const el = find(a.id),
      c = await readItem(el);
    const drawn = await snapshot(el); // null unless there's ink on or over it
    const pic = drawn ?? c?.image ?? (a.image ? await snapshot(el, { always: true }) : null);
    const type = (!drawn && c?.image && c.imageType) || 'image/png';
    const written = textsOn(el, rect(el)),
      shapes = shapesOn(el, rect(el));
    const out: Block[] = [
      ...textBlocks(
        (c?.text ?? `${el.dataset.kind} "${titleOf(el)}"`) +
          (written.length ? `\n\nThe user wrote on it: ${written.map(t => JSON.stringify(t)).join(', ')}` : '') +
          (shapes.length ? `\n\nThe user drew on it: ${shapes.join('; ')}.` : ''),
      ),
    ];
    if (pic)
      out.push(
        {
          type: 'text',
          text: drawn ? 'How it looks on the canvas, including what the user drew on it:' : 'How it looks:',
        },
        { type: 'image', data: pic, mimeType: type },
      );
    return out;
  }
  if (tool === 'canvas_create') {
    const m = makers.get(a.kind);
    if (!m) throw new Error(`Can't create "${a.kind}". Kinds: ${[...makers.keys()].join(', ')}.`);
    const need = m.needs ?? 'text';
    if (typeof a[need] !== 'string' || !a[need].trim()) throw new Error(`${need} is required for ${a.kind}.`);
    const size = m.size(a);
    const el = await m.create(a, spotBeside(a.near ? find(a.near) : S.card, size.w, size.h, 80));
    link(S, el, 'made'); // an arrow from the session that made it
    ping(el);
    changed(); // saved with the layout
    return textBlocks(JSON.stringify({ id: shortIdOf(el), kind: a.kind }));
  }
  if (tool === 'canvas_update') {
    const el = find(a.id),
      m = makers.get(el.dataset.kind ?? '');
    if (!m?.update)
      throw new Error(
        `Can't edit ${el.dataset.kind} items. Editable kinds: ${[...makers]
          .filter(([, v]) => v.update)
          .map(([k]) => k)
          .join(', ')}.`,
      );
    if (a.text == null && a.title == null) throw new Error('Nothing to change: pass text and/or title.');
    if (a.text != null && !String(a.text).trim())
      throw new Error("text can't be empty. To take an item off the canvas, ask the user.");
    if (a.title != null && !el.querySelector(':scope > .win-h .t'))
      throw new Error(`A ${el.dataset.kind} has no title; change its text instead.`);
    if (editing(el))
      throw new Error(
        `The user is editing this ${el.dataset.kind} right now, and your change would replace what they're typing. ` +
          "Don't retry right away: tell them what you'd change, or put it in a new item with canvas_create.",
      );
    if (a.text != null) await m.update(el, a);
    if (a.title != null) setTitle(el, String(a.title));
    link(S, el, 'edit'); // an edit arrow from the session, like a file it changed
    ping(el);
    changed();
    return textBlocks(
      JSON.stringify({
        id: shortIdOf(el),
        updated: [a.text != null && 'text', a.title != null && 'title'].filter(Boolean),
      }),
    );
  }
  if (tool === 'canvas_link') {
    const from = findEnd(a.from),
      to = findEnd(a.to);
    if (from === to) throw new Error('An arrow needs two different items.');
    addLink(from, to, String(a.label ?? '').trim(), 'write');
    return textBlocks(JSON.stringify({ from: endId(from), to: endId(to) }));
  }
  throw new Error(`Unknown canvas tool ${tool}.`);
}
