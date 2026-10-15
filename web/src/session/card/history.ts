// History: Claude Code's saved transcripts for this folder. Opening one puts its card (and its graph) on the canvas.

import { bulk, type Rect } from '../../canvas/core/items';
import { centerOn } from '../../canvas/core/placement';
import { dropSession, redraw } from '../../canvas/graph/graph';
import { clearInk } from '../../canvas/ink/stroke';
import { agentsStopped, dropAgents } from '../../items/agent';
import { dropPlans } from '../../items/plan/plan';
import { copySidTip, installed, title } from '../../lib/agents';
import { api, q, type SavedMessage, type SessionInfo } from '../../lib/api';
import { $, ago, button, copyButton, make, quietPings, toast } from '../../lib/dom';
import { enhanceMarked } from '../../lib/markdown';
import { save } from '../../lib/store';
import type { Session } from '../../types/session';
import { replay } from '../stream/stream';
import { pinToBottom, renderCard } from './render';
import { cards, focus, newSession } from './session';

let saved: SessionInfo[] = []; // what the server answered for the search box's query (all, newest first, when empty)
let asked = ''; // the query the newest request was for: an answer to an older one is dropped

/** List this folder's saved conversations in the History panel (the open ones marked): the newest, or every one
 *  that matches the search box, by name or ID (the server searches them all, not only the newest). */
export async function loadSessions() {
  const query = findBox.value.trim();
  asked = query;
  let found: SessionInfo[];
  try {
    found = await api<SessionInfo[]>(query ? `sessions?q=${q(query)}` : 'sessions');
  } catch {
    return;
  }
  if (query !== asked) return;
  saved = found;
  showSessions();
}

/** A query with no spaces this long may be a session ID: the server checks its shape per agent. */
const MIN_ID_LENGTH = 8;
const maybeId = (query: string) => query.length >= MIN_ID_LENGTH && !/\s/.test(query);

/** Draw the list. An ID that matched nothing gets a row to continue it (another agent's, or one not listed). */
function showSessions() {
  const query = findBox.value.trim();
  const rows: HTMLElement[] = saved.map(sessionRow);
  // after the matches, so Enter (which opens the first row) opens a match rather than asking for an ID that isn't one
  if (maybeId(query) && !saved.some(session => session.id === query)) rows.push(continueRow(query));
  if (rows.length) return $('#sessions').replaceChildren(...rows);
  $('#sessions').replaceChildren(
    make(
      'p',
      'none',
      query
        ? 'No session matches. Paste a session ID to continue it.'
        : 'No saved sessions for this folder yet. Every session you start here is saved automatically.',
    ),
  );
}

/** One saved session: opens it on the canvas, with a button that copies its ID. */
function sessionRow(session: SessionInfo) {
  const open = make('button', `sess${cards.some(card => card.sid === session.id) ? ' open' : ''}`),
    details = make('span', 'd');
  details.append(make('span', '', ago(session.mtime)));
  if (installed().length > 1) details.prepend(make('span', 'agent', title(session.backend ?? 'claude'))); // which agent's, once there's a choice
  open.append(make('span', 't', session.title), details);
  open.title = session.title;
  open.onclick = () => resume(session);
  const row = make('div', 'sessrow'); // the copy button beside the row's button, not inside it (no nested buttons)
  row.append(
    open,
    copyButton(() => session.id, copySidTip(session.backend ?? 'claude', session.id)),
  );
  return row;
}

/** A session ID typed or pasted that isn't in the list (older than its newest 50, or not listed yet). */
function continueRow(id: string) {
  const open = make('button', 'sess');
  open.append(make('span', 't', `Continue session ${id}`), make('span', 'd', 'Open it by its ID'));
  open.onclick = () => resumeById(id);
  return open;
}

/** The first thing you typed in a transcript, to name its card. */
function firstPrompt(messages: SavedMessage[]) {
  for (const message of messages) {
    if (message.role !== 'user' || (message as { isMeta?: boolean }).isMeta) continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.find(block => block.type === 'text')?.text;
    if (text?.trim()) return text.trim();
  }
}

/** A session asked for by its ID, and the agent that had it. */
interface FoundSession {
  backend: string;
  messages: SavedMessage[];
}

/** Continue a session by its ID: each installed agent is asked for it, and the first that has it opens it.
 *  ponytail: only this folder's sessions (where each CLI keeps them); one from another project isn't found. */
async function resumeById(id: string) {
  const open = cards.find(card => card.sid === id);
  if (open) return resume({ id, title: open.title, backend: open.backend });
  const tries = installed().map(agent =>
    api<SavedMessage[]>(sessionPath(id, agent.name)).then(messages => {
      if (!Array.isArray(messages)) throw new Error('missing');
      return { backend: agent.name, messages };
    }),
  );
  let found: FoundSession;
  try {
    found = await Promise.any(tries);
  } catch {
    return toast(`No saved session with the ID ${id} in this folder.`);
  }
  findBox.value = '';
  await resume({ id, title: firstPrompt(found.messages) ?? id, backend: found.backend }, undefined, {
    got: Promise.resolve(found.messages),
  });
}

const SEARCH_DELAY_MS = 200; // ask the server once typing pauses, not on every key
const findBox = $('#sessfind') as HTMLInputElement;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
findBox.oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadSessions, SEARCH_DELAY_MS);
};
findBox.onkeydown = async event => {
  if (event.key === 'Enter') {
    if (!findBox.value.trim()) return;
    clearTimeout(searchTimer);
    await loadSessions(); // what was typed may not have been searched yet
    $('#sessions').querySelector<HTMLButtonElement>('.sess')?.click();
    return;
  }
  if (event.key !== 'Escape') return;
  if (!findBox.value) return findBox.blur(); // the next Escape closes the drawer
  findBox.value = '';
  loadSessions();
};

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
