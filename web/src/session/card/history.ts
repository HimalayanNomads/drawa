// History: Claude Code's saved transcripts for this folder. Opening one puts its card (and its graph) on the canvas.

import { bulk, type Rect } from '../../canvas/core/items';
import { centerOn } from '../../canvas/core/placement';
import { dropSession, redraw } from '../../canvas/graph/graph';
import { clearInk } from '../../canvas/ink/stroke';
import { agentsStopped, dropAgents } from '../../items/agent';
import { dropPlans } from '../../items/plan/plan';
import { copySidTip, installed, title } from '../../lib/agents';
import { api, q, type SavedMessage, type SessionInfo } from '../../lib/api';
import { $, ago, button, copyButton, make, quietPings } from '../../lib/dom';
import { enhanceMarked } from '../../lib/markdown';
import { save } from '../../lib/store';
import type { Session } from '../../types/session';
import { replay } from '../stream/stream';
import { pinToBottom, renderCard } from './render';
import { cards, focus, newSession } from './session';

/** List this folder's saved conversations in the History panel (the open ones marked). */
export async function loadSessions() {
  let list: SessionInfo[];
  try {
    list = await api<SessionInfo[]>('sessions');
  } catch {
    return;
  }
  if (!list.length)
    return $('#sessions').replaceChildren(
      make('p', 'none', 'No saved sessions for this folder yet. Every session you start here is saved automatically.'),
    );
  $('#sessions').replaceChildren(
    ...list.map(s => {
      const b = make('button', `sess${cards.some(t => t.sid === s.id) ? ' open' : ''}`),
        d = make('span', 'd');
      d.append(make('span', '', ago(s.mtime)));
      if (installed().length > 1) d.prepend(make('span', 'agent', title(s.backend ?? 'claude'))); // which agent's, once there's a choice
      b.append(make('span', 't', s.title), d);
      b.title = s.title;
      b.onclick = () => resume(s);
      const row = make('div', 'sessrow'); // the copy button beside the row's button, not inside it (no nested buttons)
      row.append(
        b,
        copyButton(() => s.id, copySidTip(s.backend ?? 'claude', s.id)),
      );
      return row;
    }),
  );
}

const SHOWN = 300; // messages put in the page when a session opens

/** "Show earlier messages": moves the off-page part in above, keeping what you're looking at in place. */
function earlier(log: HTMLElement, older: HTMLElement) {
  const b = button(`Show ${older.childElementCount} earlier entries`, 'earlier', () => {
    const fromBottom = log.scrollHeight - log.scrollTop;
    b.replaceWith(...older.childNodes);
    enhanceMarked(log);
    log.scrollTop = log.scrollHeight - fromBottom;
  });
  return b;
}

/** Open a saved session as a card. `at` restores a saved position (on reload) instead of placing a new one.
 *  Restoring many: `o.got` is its transcript, already being fetched, and `o.quiet` leaves saving to the caller. */
/** Where a saved session is read: the agent that ran it keeps it (Claude's transcripts are the default). */
export const sessionPath = (id: string, backend = 'claude') =>
  `session?id=${q(id)}${backend === 'claude' ? '' : `&backend=${q(backend)}`}`;

/** Open a saved conversation in a card (or bring its open card into view), replaying its transcript. */
export async function resume(
  s: { id: string; title: string; cid?: string; backend?: string },
  at?: Rect,
  o: { got?: Promise<unknown>; quiet?: boolean } = {},
) {
  const open = cards.find(t => t.sid === s.id);
  if (open) {
    focus(open);
    centerOn(open.card);
    return;
  }
  const backend = s.backend ?? 'claude';
  const blank = !at && cards.find(t => !t.sid && !t.pending && t.backend === backend && t.log.querySelector('.empty'));
  const S = blank || newSession(at ? { rect: at, cid: s.cid, backend } : { backend });
  S.sid = s.id;
  S.title = s.title.slice(0, 48);
  await fill(S, o.got ?? api(sessionPath(s.id, backend)), !!(at && s.cid));
  redraw();
  if (!at) centerOn(S.card);
  if (o.quiet) return;
  save();
  loadSessions();
}

/** Lines of the card's process were dropped before this page read them (the stream said `_gap`): rebuild its log
 *  from the transcript. Rows the stream adds while it loads are kept after it (see fill). ponytail: a reply still
 *  streaming shows from its next message on; replaying the live buffer's open message too would need the server to
 *  send it along. A message completed during the fetch can show twice. */
export async function reload(S: Session) {
  if (!S.sid) return;
  dropSession(S);
  dropPlans(S);
  dropAgents(S);
  clearInk(S.log);
  Object.assign(S, { blocks: {}, tools: {} });
  const asks = [...S.log.querySelectorAll('.ask:not(.done)')]; // still waiting on you: not in the transcript
  await fill(S, api(sessionPath(S.sid, S.backend)), false, asks);
  redraw();
}

/** Put a transcript in the card. `restored`: a card reopened on reload, whose transcript may not be written yet.
 *  `keep`: rows to put back after it. */
async function fill(S: Session, fetched: Promise<unknown>, restored: boolean, keep: Element[] = []) {
  S.log.replaceChildren(make('p', 'none', 'Loading session…'));
  renderCard(S);
  let msgs: SavedMessage[] | undefined;
  try {
    const got = await fetched;
    if (Array.isArray(got)) msgs = got; // else an older server's 200 {missing: true}
  } catch (e) {
    const x = e as Error & { body?: { missing?: boolean }; status?: number };
    if (!x.body?.missing && x.status !== 404) {
      S.log.replaceChildren(make('div', 'err', `Could not load this session: ${x.message}`));
      return;
    }
  }
  if (!msgs) {
    // no transcript yet
    // restored mid-way through its first reply: the CLI hasn't written the transcript yet, but the live process has
    // everything since it started (live.ts reads from line 0 when n is 0). ponytail: a dead process leaves it empty.
    if (restored) {
      S.log.replaceChildren();
      S.n = 0;
    } else
      S.log.replaceChildren(make('div', 'err', 'Could not load this session: its transcript isn\u2019t written yet.'));
    return;
  }
  // rows the live stream added while the transcript loaded (after the placeholder) are newer: they go after it, and
  // its replay mustn't take over their blocks still streaming
  const streamed = [...S.log.children].slice(1),
    streaming = S.blocks;
  S.log.replaceChildren();
  S.blocks = {};
  // one pass without layout reads (pinning to the bottom, pings, header updates), then settle once
  S.replaying = true;
  quietPings(true);
  bulk(true); // new windows (agents) get spots from one measurement of the canvas, not one per window
  const live = S.log,
    older = make('div') as HTMLDivElement;
  try {
    /** Is this message the main conversation's (not a sub-agent's)? */
    // long sessions: only the newest messages go into the page; older ones are still replayed (so the Files
    // window, terminal and plans are complete) but built off-page, and shown when you ask for them
    // sub-agents' messages (their ids, what they did) go to their windows, not the log: counted apart
    const own = (m: SavedMessage & { parent?: string }) => !m.parent;
    const main = msgs.filter(own),
      agents = msgs.filter(m => !own(m));
    let cut = Math.max(0, main.length - SHOWN);
    while (cut > 0 && main[cut].role !== 'user') cut--;
    agents.filter(m => (m as { aid?: string }).aid).forEach(m => replay(S, m)); // ids first: replayed SendMessage calls need them
    S.log = older;
    main.slice(0, cut).forEach(m => replay(S, m));
    S.log = live;
    main.slice(cut).forEach(m => replay(S, m));
    agents.filter(m => !(m as { aid?: string }).aid).forEach(m => replay(S, m)); // after: their Agent calls made their windows
  } catch (e) {
    live.append(make('div', 'err', `Could not load all of this session: ${(e as Error).message}`));
  } finally {
    S.log = live;
    S.blocks = streaming;
    S.replaying = false;
    quietPings(false);
    bulk(false);
  }
  live.append(...keep, ...streamed);
  if (older.childElementCount) live.prepend(earlier(live, older));
  if (S.gone) agentsStopped(S); // the stream said so before the transcript arrived
  renderCard(S); // skipped while replaying: its state (a background agent still running) and header
  pinToBottom(S);
}
