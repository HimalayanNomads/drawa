// biome-ignore-all assist/source/organizeImports: import order here is evaluation order, which sets registration order (see CLAUDE.md)
// Plan review. In plan mode Claude presents its plan through ExitPlanMode, which needs your approval: the plan
// becomes a document node on the canvas where you can comment on any block, draw on it (Draw mode), then approve
// or send the feedback back so Claude revises it (same node, next version).
import { make, ICON, iconButton, button, ping, confirmBox } from '../../lib/dom';
import { post } from '../../lib/api';
import { imageBlock } from '../../lib/blobs';
import { persist } from '../../lib/store';
import { md, enhance } from '../../lib/markdown';
import { markChanges } from './plandiff';
import { savedRect, type Rect } from '../../canvas/core/items';
import { spotBeside, centerOn } from '../../canvas/core/placement';
import { changed } from '../../canvas/core/view';
import { makeWindow } from '../../canvas/core/window';
import { link, savedPos, forget } from '../../canvas/graph/graph';
import { setDrawing } from '../../canvas/ink/ink';
import { clearInk } from '../../canvas/ink/stroke';
import { snapshot } from '../../canvas/core/snapshot';
import { referable } from '../../canvas/core/refs';
import { renderCard } from '../../session/card/render';
import type { Session } from '../../types/session';
import { send } from '../../session/card/live';
import { setMode } from '../../session/card/mode';
import { removable } from '../../canvas/core/select';
import { who } from '../../lib/agents';

interface Comment {
  excerpt: string;
  text: string;
  el: HTMLElement;
}
interface Plan {
  S: Session;
  key: string; // first ExitPlanMode tool id: stable id for the saved position
  ids: string[]; // every ExitPlanMode call shown in this node (all versions)
  el: HTMLElement;
  body: HTMLElement;
  general: HTMLTextAreaElement;
  state: HTMLElement;
  buttons: HTMLButtonElement[];
  version: number;
  comments: Comment[];
  md: string;
  prev: string; // the previous version's text, which this one is marked against
  req?: string; // open approval request, if Claude is waiting on us
  done: boolean;
}
const current = new Map<Session, Plan>();
// plans you removed (every version's tool id), so replaying history on reload doesn't bring them back
const dismissed = new Set<string>();
const all: Plan[] = [];
persist(
  'dismissed',
  () => [...dismissed],
  (ids: string[]) => ids.forEach(id => dismissed.add(id)),
  0,
);
// each plan's place, its name if you renamed it, and the review you're writing (older layouts saved the place alone)
interface Review {
  v: number;
  general?: string;
  comments: { i: string; excerpt: string; text: string }[];
}
/** The review in progress on a plan (comments, general feedback), saved so a reload keeps it. */
const reviewOf = (p: Plan): Review | undefined =>
  p.done || (!p.comments.length && !p.general.value.trim())
    ? undefined
    : {
        v: p.version,
        general: p.general.value || undefined,
        comments: p.comments.map(c => ({ i: c.el.dataset.for ?? '', excerpt: c.excerpt, text: c.text })),
      };
/** A plan window as saved: where it is, its name, and the review in progress. */
const savedPlan = (p: Plan) => ({
  ...savedRect(p.el),
  ...(p.el.dataset.name ? { name: p.el.dataset.name } : {}),
  review: reviewOf(p),
});
persist(
  'plans',
  () => Object.fromEntries(all.map(p => [`p:${p.key}`, savedPlan(p)])),
  v => Object.assign(savedPos, v),
  0,
);
referable('plan', {
  icon: '▤',
  copy: el => all.find(p => p.el === el)?.md ?? '',
  content: (el, label) => ({ text: `Plan "${label}":\n\n${all.find(p => p.el === el)?.md ?? ''}` }),
});

/* ---------- the node ---------- */
function create(S: Session, key: string): Plan {
  const body = make('div', 'pnode-b md'),
    foot = make('div', 'pnode-f');
  const state = make('span', 'pstate'),
    general = make('textarea'),
    row = make('div', 'row');
  const close = iconButton(
    ICON.x,
    `Remove plan from canvas (rejects it if ${who(S.backend)} is still waiting)`,
    async () => {
      if (
        p.req &&
        !(await confirmBox(
          'Reject this plan?',
          `${who(S.backend)} is waiting for your review. Removing the plan rejects it.`,
          'Reject and remove',
        ))
      )
        return;
      remove(p);
    },
    'closebtn',
  );
  const { el, head } = makeWindow({
    kind: 'plan',
    cls: 'pnode',
    title: 'Plan',
    minW: 320,
    minH: 280,
    actions: [close],
    rect: (savedPos[`p:${key}`] as Rect | undefined) ?? spotBeside(S.card, 560, 680, 150, -20), // beside the card (inside its group, if it's in one)
  });
  el.dataset.id = `p:${key}`; // stable across reloads, so arrows and pins come back
  head.querySelector('.t')!.after(state);
  const name = (savedPos[`p:${key}`] as { name?: string } | undefined)?.name;
  if (name) el.dataset.name = name;
  el.addEventListener('rename', e => {
    el.dataset.name = (e as CustomEvent<string>).detail;
    changed();
  });
  general.rows = 2;
  general.placeholder = 'General feedback (optional). Hover a paragraph and click + to comment on it.';
  general.setAttribute('aria-label', 'General feedback');
  general.addEventListener('input', () => changed()); // saved with the layout
  body.dataset.ink = `p:${key}`; // drawing over the plan belongs to (and scrolls with) its text
  const p: Plan = {
    S,
    key,
    ids: [],
    el,
    body,
    general,
    state,
    buttons: [],
    version: 0,
    comments: [],
    md: '',
    prev: '',
    done: false,
  };
  p.buttons = [
    button('Send feedback', '', () => feedback(p)),
    button('Reject', 'reject', () => reject(p)),
    button('Approve', '', () => approve(p)),
    button('Approve + allow edits', 'primary', () => approve(p, 'acceptEdits')),
  ];
  // drawing happens in the canvas-wide Draw mode; this puts the plan in view and picks up the pen
  const pen = button('Draw on plan', 'draw', () => {
    centerOn(el);
    setDrawing(true);
  });
  pen.title = 'Draw on the plan (then press Done, D or Esc). Your drawing is sent with the feedback.';
  row.append(pen, ...p.buttons);
  foot.append(general, row);
  el.querySelector('.win-b')!.append(body, foot);
  commentHover(p);
  link(S, el, 'plan');
  all.push(p);
  return p;
}

/** Set a plan's state line and data-state, and its tab's title. */
function setState(p: Plan, text: string, cls: string) {
  p.state.textContent = text;
  p.el.dataset.state = cls;
  for (const b of p.buttons) b.disabled = p.done;
  p.el.querySelector('.win-h .t')!.textContent = p.el.dataset.name ?? `Plan v${p.version} · ${p.S.title}`; // renamed: kept
}

/** Claude wrote a plan (ExitPlanMode call, live or replayed from history). */
export function showPlan(S: Session, toolId: string, markdown: string): Plan | null {
  if (dismissed.has(toolId)) return null;
  let p = current.get(S);
  // the same call again: the CLI may ask for approval (with the text) before the streamed call, which has none, ends
  if (p && !p.done && p.ids.includes(toolId)) {
    if (markdown.trim() && markdown !== p.md) renderPlan(p, markdown);
    return p;
  }
  if (!p || p.done) {
    p = create(S, toolId);
    current.set(S, p);
  }
  p.version++;
  p.prev = p.md;
  p.done = false;
  p.ids.push(toolId);
  p.comments = []; // a new version: the notes were about the last one
  p.general.value = '';
  renderPlan(p, markdown);
  restoreReview(p);
  setState(p, 'Drafted', 'draft');
  changed();
  return p;
}

/** Draw the plan's Markdown, marking what changed since the previous version. */
function renderPlan(p: Plan, markdown: string) {
  if (p.md && p.md !== markdown) clearInk(p.body); // marks were about the previous text
  p.md = markdown;
  const overlay = p.body.querySelector(':scope > svg.ink-local'); // keep the ink layer across re-renders
  p.body.innerHTML = markdown.trim() ? md(markdown) : '<p class="none">Waiting for the plan text…</p>';
  if (p.prev && markdown.trim()) changes(p);
  if (overlay) p.body.append(overlay);
  enhance(p.body);
  for (const [i, blk] of [...p.body.children].filter(c => !c.matches('svg.ink-local, .pgone, .pchanges')).entries()) {
    (blk as HTMLElement).dataset.i = String(i);
    blk.classList.add('pblk');
  }
  for (const c of p.comments) placeNote(p, c); // the same version drawn again (its text arrived with the request): notes stay
}
/** A comment's note, after the block it's about (at the end if that block is gone). */
function placeNote(p: Plan, c: Comment) {
  const blk = p.body.querySelector<HTMLElement>(`:scope > .pblk[data-i="${c.el.dataset.for}"]`);
  if (blk) lastNoteAfter(blk).after(c.el);
  else p.body.append(c.el);
}
/** The review you were writing on this version before a reload. */
function restoreReview(p: Plan) {
  const r = (savedPos[`p:${p.key}`] as { review?: Review } | undefined)?.review;
  if (r?.v !== p.version) return;
  p.general.value = r.general ?? '';
  for (const c of r.comments) addComment(p, c.i, c.excerpt, c.text);
}

/** A revision: a line on top says how much changed since the version before, with a switch to hide the marks. */
function changes(p: Plan) {
  const n = markChanges(p.body, p.prev),
    line = make('div', 'pchanges');
  const parts = [
    n.added && `${n.added} added`,
    n.edited && `${n.edited} edited`,
    n.removed && `${n.removed} removed`,
  ].filter(Boolean);
  line.append(make('span', '', `Since v${p.version - 1}: ${parts.join(' · ') || 'no changes'}`));
  const hide = button('Hide changes', '', () => {
    const off = p.body.dataset.changes !== 'off';
    p.body.dataset.changes = off ? 'off' : 'on';
    hide.textContent = off ? 'Show changes' : 'Hide changes';
  });
  if (parts.length) line.append(hide);
  p.body.prepend(line);
}

/** Claude is waiting for approval of the plan. */
export function reviewPlan(S: Session, req: string, toolId: string, markdown?: string): Plan | null {
  if (dismissed.has(toolId)) {
    // you removed this plan: decline it quietly
    post('respond', {
      cid: S.cid,
      request_id: req,
      allow: false,
      message: 'The user removed this plan. Do not implement it; wait for their next instruction.',
    }).catch(() => {});
    return null;
  }
  let p: Plan | null | undefined = current.get(S);
  // a new call is a new version, even if its request comes before the streamed call ends (that one has no text)
  if (!p || p.done || (toolId && !p.ids.includes(toolId))) p = showPlan(S, toolId, markdown ?? '');
  if (!p) return null;
  // the streamed tool call may not carry the plan text (the CLI adds it when asking): use the request's copy
  if (markdown && markdown !== p.md) renderPlan(p, markdown);
  p.req = req;
  setState(p, 'Waiting for your review', 'review');
  ping(p.el);
  return p;
}

/** The ExitPlanMode call finished: approved, or sent back with feedback. */
export function planResult(S: Session, approved: boolean) {
  const p = current.get(S);
  if (!p || p.done) return; // already decided here (approved or rejected): keep that state
  p.req = undefined;
  if (approved) {
    p.done = true;
    setState(p, 'Approved', 'approved');
  } else setState(p, 'Revising…', 'revising');
}

/** Bring a session's current plan into view. */
export const focusPlan = (S: Session) => {
  const p = current.get(S);
  if (p) centerOn(p.el);
};

/* ---------- comments on any block ---------- */
function commentHover(p: Plan) {
  const add = iconButton(
    ICON.plus,
    'Comment on this part of the plan',
    () => {
      if (target) commentEditor(p, target);
    },
    'padd',
  );
  add.hidden = true;
  p.el.append(add);
  let target: HTMLElement | null = null;
  p.body.addEventListener('mousemove', e => {
    const blk = (e.target as Element).closest<HTMLElement>('.pblk');
    if (!blk || p.done) return;
    target = blk;
    const b = blk.getBoundingClientRect(),
      n = p.el.getBoundingClientRect(),
      k = n.width / p.el.offsetWidth; // canvas zoom
    add.style.top = `${(b.top - n.top) / k}px`;
    add.hidden = false;
  });
  p.el.addEventListener('mouseleave', () => (add.hidden = true));
}

/** A comment box under a block of the plan. */
function commentEditor(p: Plan, blk: HTMLElement) {
  const box = make('div', 'pedit'),
    ta = make('textarea'),
    row = make('div', 'row');
  ta.rows = 2;
  ta.placeholder = 'What should change here?';
  const ok = button('Add comment', 'primary', () => {}),
    cancel = button('Cancel', '', () => box.remove());
  row.append(cancel, ok);
  box.append(ta, row);
  lastNoteAfter(blk).after(box);
  ta.focus();
  ta.onkeydown = e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ok.click();
    if (e.key === 'Escape') box.remove();
  };
  ok.onclick = () => {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    box.remove();
    addComment(p, blk.dataset.i ?? '', plain(blk).replace(/\s+/g, ' ').trim().slice(0, 140), text);
  };
}
/** Add a comment under block `i` of the plan. */
function addComment(p: Plan, i: string, excerpt: string, text: string) {
  const note = make('div', 'pnote');
  const c: Comment = { excerpt, text, el: note };
  note.append(
    make('span', '', text),
    iconButton(ICON.x, 'Remove comment', () => {
      note.remove();
      p.comments.splice(p.comments.indexOf(c), 1);
      countComments(p);
      changed();
    }),
  );
  note.dataset.for = i;
  p.comments.push(c);
  placeNote(p, c);
  countComments(p);
  changed();
}
/** A block's current text, without the words marked as removed. */
function plain(blk: HTMLElement) {
  const c = blk.cloneNode(true) as HTMLElement;
  c.querySelectorAll('del, .pgone').forEach(d => d.remove());
  return c.textContent ?? '';
}
/** New notes go after the block's existing notes, so they read in order. */
function lastNoteAfter(blk: HTMLElement) {
  let at: Element = blk;
  while (at.nextElementSibling?.matches(`.pnote[data-for="${blk.dataset.i}"], .pedit`)) at = at.nextElementSibling;
  return at;
}
/** Show the number of comments on the Send feedback button. */
const countComments = (p: Plan) => {
  p.buttons[0].textContent = p.comments.length ? `Send feedback (${p.comments.length})` : 'Send feedback';
};

/* ---------- answering Claude ---------- */

/** Tell Claude the plan is off: no implementation, wait for the next instruction. */
async function reject(p: Plan) {
  if (p.done) return;
  const req = p.req;
  p.req = undefined;
  p.done = true;
  setState(p, 'Rejected', 'rejected');
  const message =
    'The user rejected this plan. Do not implement it or make any changes; stop and wait for their next instruction.';
  if (req) await respond(p, req, { allow: false, message });
  else if (!(await send(p.S, 'Rejected the plan: don\u2019t implement it. Wait for my next instruction.')))
    unanswered(p);
}

/** Answer Claude's waiting request. Resolves to whether it got there (if not, the plan waits for you again). */
function respond(p: Plan, req: string, body: object) {
  return post('respond', { cid: p.S.cid, request_id: req, ...body }).then(
    () => {
      p.S.asks.delete(req); // the card stops showing it as waiting on you
      renderCard(p.S);
      return true;
    },
    (e: { status?: number }) => {
      unanswered(p, e.status === 409 ? undefined : req);
      return false;
    },
  ); // 409: its process is gone, so trying again sends a message
}

/** Claude didn't get the answer: back to waiting for your review, to try again. */
function unanswered(p: Plan, req?: string) {
  p.req = req;
  p.done = false;
  setState(p, `Could not reach ${who(p.S.backend)}, try again`, 'review');
}

/** Take the plan off the canvas (rejecting it first if Claude is still waiting on it). */
function remove(p: Plan) {
  if (p.req) reject(p);
  p.ids.forEach(id => dismissed.add(id));
  forget(p.el);
  p.el.remove();
  all.splice(all.indexOf(p), 1);
  if (current.get(p.S) === p) current.delete(p.S);
  changed();
}

/** Approve the plan: answer Claude's request, and switch the card to the mode picked (or back to asking). */
async function approve(p: Plan, mode?: string) {
  const req = p.req;
  p.req = undefined;
  p.done = true;
  setState(p, 'Approved', 'approved');
  // leaving plan mode: the chosen mode, or back to asking for each action
  if (mode || p.S.mode === 'plan') setMode(p.S, mode ?? 'default');
  if (req) {
    await respond(p, req, { allow: true, mode });
  } else {
    // Claude isn't waiting any more (its process ended, e.g. a server restart): say it as a message, which resumes the session
    if (!(await send(p.S, 'Approved the plan. Go ahead and implement it.'))) unanswered(p);
  }
}

/** Send the comments and general feedback (with a picture of the plan as drawn on) and ask for a new version. */
async function feedback(p: Plan) {
  const lines = p.comments.map((c, i) => `${i + 1}. On "${c.excerpt}": ${c.text}`);
  const general = p.general.value.trim();
  if (general) lines.push(`General: ${general}`);
  const image = await snapshot(p.el, { skip: ['pnode-f', 'padd', 'pgone', 'pdel', 'pchanges'] }); // the plan as drawn on, without its buttons
  if (!lines.length && !image) {
    p.general.focus();
    p.general.placeholder = 'Nothing to send yet: comment on a paragraph (+), write feedback here, or use Draw on plan';
    return;
  }
  const message = [
    'The user reviewed your plan and wants changes:',
    '',
    ...lines,
    ...(image ? ['', 'They also drew on the plan: the annotated image follows in their next message.'] : []),
    '',
    'Revise the plan accordingly and present it again with ExitPlanMode.',
  ].join('\n');
  const req = p.req;
  p.req = undefined;
  setState(p, 'Sending feedback…', 'revising');
  if (!req) {
    // not waiting any more: send the feedback as a message, and stay in plan mode for the revision
    setMode(p.S, 'plan');
    if (
      !(await send(p.S, 'Feedback on the plan', [
        {
          type: 'text',
          text: message.replace(
            'They also drew on the plan: the annotated image follows in their next message.',
            'They also drew on the plan: see the annotated image below.',
          ),
        },
        ...(image ? [imageBlock('image/png', image)] : []),
      ]))
    )
      unanswered(p);
    else sent(p);
    return;
  }
  if (!(await respond(p, req, { allow: false, message }))) return;
  sent(p);
  if (image)
    send(p.S, 'Annotated plan (my drawing on it)', [
      { type: 'text', text: 'My drawing on your plan, as an annotated screenshot:' },
      imageBlock('image/png', image),
    ]);
}

/** The feedback got there: empty the box and the comments (only now, so a failed send keeps them to try again) and say so. */
function sent(p: Plan) {
  p.general.value = '';
  for (const c of p.comments) c.el.remove();
  p.comments = [];
  countComments(p);
  setState(p, `Feedback sent · waiting for the revised plan`, 'revising');
  changed();
}

/** The card's process ended: its plans' requests are gone, so answering one says it as a message instead. */
export function plansExpired(S: Session) {
  for (const p of all) if (p.S === S) p.req = undefined;
}

/** The agent took back the plan's request (control_cancel_request): like plansExpired, for that one plan. */
export function planWithdrawn(S: Session, req: string) {
  const p = all.find(p => p.S === S && p.req === req);
  if (!p) return;
  p.req = undefined;
  setState(p, `Withdrawn: ${who(S.backend)} no longer needs an answer`, 'draft');
}

/* ---------- canvas bookkeeping ---------- */
export function dropPlans(S: Session) {
  for (const p of all.filter(p => p.S === S)) {
    savedPos[`p:${p.key}`] = savedPlan(p); // a rebuild puts it back where it is now
    p.el.remove();
    all.splice(all.indexOf(p), 1);
  }
  current.delete(S);
}
// a deleted selection has asked already (its confirm says what that means for a waiting plan)
removable(
  'plan',
  el => {
    const p = all.find(p => p.el === el);
    if (p) remove(p);
  },
  'A plan still waiting for your review is rejected.',
);
