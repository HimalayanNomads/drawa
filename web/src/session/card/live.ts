// biome-ignore-all assist/source/organizeImports: import order here is evaluation order, which sets registration order (see CLAUDE.md)
// The live connection to a card's Claude process: send messages, and read its output stream (re-attaching
// after network drops or a reload) until the process exits.
import { make, uuid, iconButton, ICON, toast } from '../../lib/dom';
import { post } from '../../lib/api';
import { requestEnded } from '../../canvas/graph/graph';
import { toContent, type Ref } from '../../canvas/core/refs';
import { cards } from './session';
import { appendToLog, renderCard } from './render';
import type { Session } from '../../types/session';
import { refChip, putBack } from '../composer/composer';
import { handleMessage, type Msg } from '../stream/stream';
import { thumbnail, imageBlock, type Pasted } from '../composer/images';
import { askPermission } from './notify';
import { canvasCall } from '../../canvas/core/tools';
import { takeShell } from '../composer/shell';
import { agentsStopped } from '../../items/agent';
import { expireAsks } from '../stream/asks';
import { reload } from './history';
import { canUnsend, who } from '../../lib/agents';
import { onOwner, ownsServer } from '../../lib/tabs';

/** Send a message (text, or content blocks like images with a short label for the bubble). Resolves to whether
 *  the server took it. */
export async function send(
  S: Session,
  prompt: string,
  content?: object[],
  refs: Ref[] = [],
  images: Pasted[] = [],
): Promise<boolean> {
  askPermission(); // first message: a good moment to ask (it's a user action) whether you want notifications
  S.log.querySelector('.empty')?.remove();
  const bubble = appendToLog(S, make('div', 'me queued', prompt)),
    id = uuid();
  bubble.dataset.uuid = id; // Claude's echo carries it too (shown() goes by it)
  if (refs.length || images.length) {
    const row = make('div', 'refs sent');
    row.append(...images.map(img => thumbnail(img)), ...refs.map(r => refChip(r)));
    bubble.append(row);
    refs.forEach(r => S.sentRefs.add(r.el));
  }
  S.log.scrollTop = S.log.scrollHeight;
  S.atEnd = true; // you sent something: follow its answer
  S.queued.push(bubble);
  if (!content) unsent.set(bubble, { prompt, refs, images });
  if (S.title === 'New session') S.title = prompt.slice(0, 48);
  S.done = false;
  const waits = S.pending > 0; // behind a running turn; otherwise Claude starts on it at once, with nothing to take back
  S.pending++;
  renderCard(S);
  try {
    let p: string | object[] = content ?? (await toContent(prompt, refs));
    const shell = takeShell(S); // shell runs since the last message go first, like the terminal's bash mode
    if (shell) p = typeof p === 'string' ? shell + p : [{ type: 'text', text: shell }, ...p];
    if (images.length) p = [...(typeof p === 'string' ? [{ type: 'text', text: p }] : p), ...images.map(imageBlock)];
    if (!bubble.isConnected) return false; // the card was cleared (/clear) while this was being prepared
    bubble.dataset.state = 'sending';
    await post('send', {
      cid: S.cid,
      sid: S.sid,
      p,
      mode: S.mode,
      model: S.model,
      effort: S.effort,
      backend: S.backend,
      uuid: id,
    });
    delete bubble.dataset.state;
    attach(S);
    if (waits && canUnsend(S.backend)) takeBackButtons(S, bubble);
    return true;
  } catch (e) {
    delete bubble.dataset.state;
    const i = S.queued.indexOf(bubble);
    if (i >= 0) S.queued.splice(i, 1);
    bubble.classList.replace('queued', 'failed');
    appendToLog(S, make('div', 'err', `Could not send: ${(e as Error).message}`));
    S.pending = Math.max(0, S.pending - 1);
    renderCard(S);
    return false;
  }
}

/* ---------- taking back a queued message ---------- */
// What a bubble was sent with, to put back in the box: when it's taken back to edit, or its process died before
// reading it. (Commands the page sends itself have none.)
const unsent = new WeakMap<HTMLElement, { prompt: string; refs: Ref[]; images: Pasted[] }>();

/** Delete and edit buttons on a queued message, while the agent hasn't read it. */
// Until Claude reads a queued message (between tool calls, or when its turn ends) the CLI can drop it from its queue:
// delete it, or edit it (back into the message box, to fix and send again). CSS hides the buttons once it's read.
function takeBackButtons(S: Session, bubble: HTMLElement) {
  const row = make('span', 'unsend'),
    again = unsent.get(bubble);
  if (again)
    row.append(
      iconButton(
        ICON.pencil,
        'Edit (take it back to fix)',
        () =>
          unsend(S, bubble).then(ok => {
            if (ok) putBack(S, again.prompt, again.refs, again.images);
          }),
        'edit',
      ),
    );
  row.append(iconButton(ICON.x, 'Delete (take it back)', () => unsend(S, bubble)));
  bubble.append(row);
}

/** After a reload: the messages the server says are still queued (oldest first) are waiting again, with their
 *  take-back buttons. Bubbles are found by uuid (the transcript's), else they're the newest ones. */
function requeue(S: Session, ids: string[]) {
  const mine = [...S.log.querySelectorAll<HTMLElement>(':scope > .me')];
  const byId = new Map(mine.map(b => [b.dataset.uuid, b]));
  let from = mine.length - ids.length;
  for (const id of ids) {
    const b = byId.get(id) ?? mine[from];
    from++;
    if (!b || S.queued.includes(b)) continue;
    b.dataset.uuid = id;
    b.classList.add('queued');
    S.queued.push(b);
    const text = b.firstChild?.nodeType === Node.TEXT_NODE ? (b.firstChild.textContent ?? '') : '';
    // its references and pictures can't be rebuilt from the transcript: such a message can only be deleted, not edited
    if (text && !b.querySelector('.refdump, .refs.sent')) unsent.set(b, { prompt: text, refs: [], images: [] });
    if (canUnsend(S.backend)) takeBackButtons(S, b);
  }
}

/** Take back a queued message the agent hasn't read yet; false when it already has. */
// ponytail: shell runs sent with the message go with it; give them back to takeShell if that's ever missed.
// ponytail: an error answer (no reply in 5s) leaves the bubble queued, and the card counted busy, if the CLI did drop
// it; its answers have come back at once so far
async function unsend(S: Session, bubble: HTMLElement): Promise<boolean> {
  /** Is the bubble still on the page, still waiting to be read? */
  const live = () => bubble.isConnected && bubble.classList.contains('queued');
  if (!live() || bubble.dataset.state === 'unsending') return false; // one take-back at a time (double click, edit then delete)
  bubble.dataset.state = 'unsending';
  const r = await post('unsend', { cid: S.cid, uuid: bubble.dataset.uuid, backend: S.backend }).catch(() => null);
  delete bubble.dataset.state;
  if (!r?.cancelled) {
    if (live()) toast(r ? `${who(S.backend)} has already read it.` : 'Could not take it back.');
    return false;
  }
  const i = S.queued.indexOf(bubble);
  if (i >= 0) S.queued.splice(i, 1); // (gone already if the card was cleared meanwhile)
  bubble.remove();
  S.pending = Math.max(0, S.pending - 1);
  renderCard(S);
  return true;
}

/* ---------- reading: one stream per page for all its cards ---------- */
// Browsers allow ~6 connections per host over HTTP/1.1: a stream per card would stall every other request once a few
// cards are open. So the page reads every card's output over one /api/events stream (lines tagged with the card).
// It's re-opened (from each card's next line) when cards come or go, and after a drop.
const page = uuid().replace(/-/g, '').slice(0, 16); // names this page for canvas tool calls
let conn: AbortController | null = null,
  subscribed = '',
  soon = 0;

// One stream per server across tabs, too (lib/tabs.ts): only the tab that owns this server reads it.
onOwner(on => {
  if (on) return listenToCards();
  conn?.abort();
  conn = null;
  subscribed = '';
});

/** Make sure this card's output is being read (it's a no-op when the stream already covers it). */
export function attach(_S?: Session) {
  clearTimeout(soon);
  soon = setTimeout(listenToCards, 30); // cards restored or opened together share one re-open
}

/** (Re)open the page's one event stream when the set of cards it reads changed. Only the tab that owns the server
 *  reads. */
function listenToCards() {
  if (!ownsServer()) return;
  // re-open when cards come or go, or when a card not attached yet got a different start (a restore sets it after the
  // card exists: e.g. line 0 for one whose transcript isn't written yet)
  const want = cards
    .map(S => (S.gen ? S.cid : `${S.cid}:${S.n}`))
    .sort()
    .join();
  if (conn && want === subscribed) return;
  conn?.abort();
  subscribed = want;
  if (!cards.length) {
    conn = null;
    return;
  }
  const ctrl = (conn = new AbortController());
  readStream(ctrl).finally(() => {
    if (conn !== ctrl) return; // replaced by a newer stream
    conn = null;
    setTimeout(listenToCards, 1000); // dropped (server restart, network): pick up where each card left off
  });
}

/** Read every card's output over one /api/events stream, routing each line to its card; reconnects when it drops. */
async function readStream(ctrl: AbortController) {
  const c = cards.map(S => `${S.cid}:${S.n}:${S.gen ?? ''}`).join();
  let res: Response;
  try {
    res = await fetch(`/api/events?page=${page}&c=${c}`, { signal: ctrl.signal });
  } catch {
    return;
  }
  if (!res.ok || !res.body) return;
  const rd = res.body.getReader(),
    dec = new TextDecoder();
  // the server sends a keep-alive every 15s: this long without a byte is a half-open connection (sleep, network
  // change) that would otherwise hang here for good. Aborting it reconnects (see listen).
  let buf = '',
    idle = 0;
  /** Restart the idle timer: a stream silent for 40s is closed and opened again. */
  const watch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(), 40_000);
  };
  watch();
  try {
    for (;;) {
      const { done, value } = await rd.read();
      if (done) return;
      watch();
      const got = dec.decode(value, { stream: true }),
        nl = got.lastIndexOf('\n');
      if (nl < 0) {
        buf += got;
        continue;
      } // a long line coming in pieces: only new text is searched for its end
      const lines = (buf + got.slice(0, nl)).split('\n');
      buf = got.slice(nl + 1);
      for (const l of lines) {
        if (!l.trim()) continue; // keep-alive
        let m: Msg | undefined;
        try {
          m = JSON.parse(l);
        } catch {
          /* still one of the card's lines: counted all the same (see line) */
        }
        const cid = m ? m._c : /^\{"_c":"([^"]+)"/.exec(l)?.[1];
        const S = cards.find(s => s.cid === cid);
        if (S) line(S, m, l);
      }
    }
  } catch {
    /* aborted, or the connection dropped */
  } finally {
    clearTimeout(idle);
  }
}

/** One line of a card's output. `m` is undefined for a line that isn't valid JSON: it still counts. */
function line(S: Session, m: Msg | undefined, raw: string) {
  if (m?.type === 'absent') {
    // no process: a restored agent can't be running, and a turn this page saw start never ends
    if (S.gen && !S.gone) ended(S, 'the server restarted');
    S.gone = true;
    agentsStopped(S);
    return;
  }
  if (m?.type === '_gap') {
    // lines were dropped before this page read them: the next is `to`; rebuild from the transcript
    if (typeof m.to === 'number') S.n = m.to;
    if (!S.stale) reload(S);
    return;
  }
  if (m?.type === 'attach') {
    S.gone = false;
    S.n = m.from;
    S.gen = m.gen; // the process these line numbers belong to
    if (S.stale && m.gen !== S.stale) S.stale = undefined;
    S.reader = m.reader;
    // mid-turn when this page (re)attached, e.g. after a reload: show it working (and stoppable) until the result,
    // with the messages it hasn't read yet queued behind it
    if (!S.queued.length && m.queued?.length) requeue(S, m.queued);
    S.picked = !!m.picked;
    S.pending = Math.max(S.pending, S.queued.length + (m.busy && m.picked ? 1 : 0), m.busy ? 1 : 0);
    renderCard(S);
    return;
  }
  if (!m?._r) S.n++; // re-sent on attach (an ask still open), not one of the process's numbered lines
  if (!m || S.stale) return; // stale: /clear, the old process's last lines (its new one attaches with another gen)
  if (m.type === 'exit') {
    // process ended (closed as idle, crashed, or server restarted): the next message starts a new one resuming this
    // session, and the same stream picks that one up from its first line
    ended(S, m.code ? `exit code ${m.code}` : '');
    return;
  }
  // a canvas tool call for this page (older ones replayed after a reconnect name an old reader: skip them)
  if (m.type === 'canvas_call') {
    if (m.to === S.reader) canvasCall(S, m as any);
    return;
  }
  try {
    handleMessage(S, m);
  } catch (x) {
    console.error(x, raw);
  }
}

/** The card's process is gone: nothing it was doing will finish, and nothing it asked can be answered. Messages it
 *  never read go back in the box, to send again. */
function ended(S: Session, why: string) {
  if (S.pending > S.queued.length)
    appendToLog(
      S,
      make(
        'div',
        'err',
        `Interrupted: ${who(S.backend)} stopped before finishing${why ? ` (${why})` : ''}. Send a message to carry on.`,
      ),
    );
  let back = 0;
  for (const b of S.queued.splice(0)) {
    b.classList.replace('queued', 'failed');
    b.querySelector('.unsend')?.remove();
    const again = unsent.get(b);
    if (again) {
      putBack(S, again.prompt, again.refs, again.images, false);
      back++;
    }
  }
  if (back)
    toast(
      `${back === 1 ? 'A message' : `${back} messages`} ${who(S.backend)} never read ${back === 1 ? 'is' : 'are'} back in the message box, to send again.`,
    );
  agentsStopped(S); // its agents were part of it
  expireAsks(S);
  if (S.pending || S.bg) {
    S.pending = S.bg = 0;
    requestEnded(S);
  }
  renderCard(S);
}
