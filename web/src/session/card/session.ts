// Session cards: each is a live Claude process on the server. You can type any time (messages queue while Claude
// or its agents work, like the terminal); output streams in continuously (stream.ts). Every tool call also lands on
// the graph. This module owns the card itself: creating, focusing, closing, and its header / status.
// Its types are types.ts, drawing it render.ts, how the canvas saves and references it saved.ts.
import { bringToFront, onCanvas, type Rect } from '../../canvas/core/items';
import { centerOn, nextColumn, spotBeside } from '../../canvas/core/placement';
import { expand, makeWindow } from '../../canvas/core/window';
import { dropSession, redraw } from '../../canvas/graph/graph';
import { clearInk } from '../../canvas/ink/stroke';
import { dropAgents, runningAgents, showAgent } from '../../items/agent';
import { dropPlans } from '../../items/plan/plan';
import { lastAgent, type Model, modesOf, who } from '../../lib/agents';
import { post } from '../../lib/api';
import { confirmBox, copyButton, EDITABLE, ICON, iconButton, make, perFrame, ping, project, uuid } from '../../lib/dom';
import { onSendKey } from '../../lib/sendkey';
import { save, saveSoon } from '../../lib/store';
import { composer } from '../composer/composer';
import { keepImages } from '../composer/drafts';
import { lastEffort, lastModel, seedInfo } from './gen';
import { loadSessions } from './history';
import { attach } from './live';
import { lastMode } from './mode';
import { pinToBottom, renderCard } from './render';
import './saved'; // the cards' saved-layout slices, and what makes them removable and referable
import type { Session } from '../../types/session';

export const cards: Session[] = [];
export let cur: Session | undefined; // the focused card
/** Models and slash commands / skills, from Claude itself (GET /api/meta). */
/** Also carries tools/MCP counts and usage-window stats from a $0 `/usage` ask (see internal/live/meta.go): the
 *  same for every card (it's account-wide, not per-conversation), so a card's status line can show it before its
 *  own process has ever run (see gen.ts's seedInfo). */
export const meta: {
  models: Model[];
  commands: { name: string; description: string; argumentHint?: string }[];
  tools?: number;
  mcpTotal?: number;
  mcpConnected?: number;
  usageUtil?: number;
  usageResetAt?: number;
  weeklyUtil?: number;
  weeklyResetAt?: number;
} = { models: [], commands: [] };

/* ---------- the card ---------- */
function emptyState(S: Session) {
  const e = make('div', 'empty'),
    ul = make('ul'),
    chips = make('div', 'chips');
  const name = who(S.backend);
  e.append(make('h2', '', 'New session'), make('p', '', `${name} works in ${project.root}`));
  const tips: [string, string][] = [
    ['--edit', `Files ${name} reads or changes are listed in a Files window beside this card, changed files first.`],
    ['--run', 'Commands it runs collect in a commands window below the card (click its tab to see the output).'],
    [
      '--write',
      'Type / for skills and commands, @ to reference scratchpads, diagrams, plans, notes or files (or drop them on the message box).',
    ],
    [
      '--read',
      'Ask first by default. Change it per session in the message bar (Allow edits, Plan only, Allow everything).',
    ],
  ];
  for (const [color, text] of tips) {
    const li = make('li'),
      i = make('i');
    i.style.background = `var(${color})`;
    li.append(i, text);
    ul.append(li);
  }
  for (const q of ['Summarize this project', 'Map the main modules', 'Find TODOs and rough edges']) {
    const c = make('button', 'btn', q);
    c.type = 'button';
    c.onclick = () => {
      S.ta.value = q;
      S.ta.focus();
    };
    chips.append(c);
  }
  e.append(ul, chips);
  return e;
}

/** `here`: in a free spot in the view, leaving the camera where it is (the card a reload makes when none was saved:
 *  jumping off to the next column would lose your place). */
export function newSession(opts: { rect?: Rect; cid?: string; backend?: string; here?: boolean } = {}) {
  const w = Math.max(340, Math.min(460, innerWidth - 32)); // phones: fits the screen
  const r = opts.rect ?? (opts.here ? spotBeside(null, w, 600) : nextColumn(w, 600));
  const close = iconButton(ICON.x, 'Close session', () => askClose(S), 'closebtn');
  // Claude Code's own resume list hides -p sessions, so this is how you open a card's session in a terminal
  const sidBtn = copyButton(() => S.sid ?? '', 'Copy session ID');
  sidBtn.classList.add('sidbtn');
  sidBtn.hidden = true;
  const {
    el: card,
    head,
    title,
    body,
  } = makeWindow({
    kind: 'session',
    cls: 'card',
    title: 'New session',
    rect: r,
    minW: 340,
    minH: 300,
    actions: [sidBtn, close],
  });
  head.prepend(make('span', 'dot'));
  const ctx = make('span', 'ctx'); // a span, not a button: the tab's buttons are the window controls at its end
  ctx.tabIndex = 0;
  ctx.setAttribute('role', 'button');
  ctx.onclick = e => {
    e.stopPropagation();
    S.ta.value = '/compact ';
    S.ta.focus();
  }; // a nudge, not an action: you still send it
  ctx.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.click();
    }
  };
  // running sub-agents: a badge that never shrinks away (the meta text does), visible when collapsed too; each click
  // shows the next running agent's window
  const agentsBtn = make('button', 'agents');
  agentsBtn.hidden = true;
  let nextAgent = 0;
  agentsBtn.onclick = e => {
    e.stopPropagation();
    const run = runningAgents(S);
    if (run.length) showAgent(run[nextAgent++ % run.length]);
  };
  title.after(agentsBtn, make('span', 'm'), ctx);
  const log = make('div', 'log');
  log.setAttribute('role', 'log'); // a screen reader reads out what's added; aria-busy (renderCard) holds a streaming reply until it's whole
  log.setAttribute('aria-label', 'Conversation');
  // scrolled up to read: a way back to the latest message (appends while you're up there don't scroll, so it stays shown)
  const down = iconButton(
    ICON.open,
    'Scroll to the latest message',
    () => {
      S.atEnd = true;
      pinToBottom(S);
    },
    'tobottom',
  );
  down.hidden = true;
  // Scrolling up stops following new output at once (checked per event: a streaming frame would pull you back
  // first); scrolling back down to where the way-back button hides follows again. (Rows below render at their real
  // height only once on screen, so "the bottom" moves as you get there.) Content shrinking at the end also moves
  // scrollTop up, but leaves you at the bottom, so it re-follows on the next frame.
  let lastTop = 0,
    wentDown = false;
  /** After a scroll: following again once back at the bottom, and the way-back button only while scrolled up. */
  const settle = perFrame(() => {
    const left = log.scrollHeight - log.scrollTop - log.clientHeight;
    if (left < 4 || (wentDown && left < 200)) S.atEnd = true;
    down.hidden = left < 200;
  });
  log.addEventListener(
    'scroll',
    () => {
      wentDown = log.scrollTop > lastTop;
      if (log.scrollTop < lastTop - 1) S.atEnd = false;
      lastTop = log.scrollTop;
      settle();
    },
    { passive: true },
  );
  body.append(log, down);

  const S: Session = {
    cid: opts.cid ?? uuid(),
    sid: null,
    backend: opts.backend ?? lastAgent(),
    title: 'New session',
    reportedModel: '',
    model: '',
    effort: '',
    toolCount: 0,
    mcpTotal: 0,
    mcpConnected: 0,
    cost: 0,
    done: false,
    card,
    log,
    ta: null!,
    stopBtn: null!,
    atEnd: true,
    blocks: {},
    tools: {},
    pending: 0,
    bg: 0,
    queued: [],
    picked: false,
    mode: lastMode(),
    asks: new Set(),
    refs: [],
    images: [],
    sentRefs: new Set(),
    chips: null!,
    n: -1,
    ctx: { used: 0, max: 0 },
  };
  if (!(modesOf(S.backend)?.includes(S.mode) ?? true)) S.mode = 'default'; // e.g. Auto, which OpenCode doesn't have
  S.model = lastModel(S.backend); // restored cards set their own afterwards
  S.effort = lastEffort(S.backend); // the picker drops it if the model doesn't offer it
  composer(S, body); // message box, reference chips, / and @ menu
  seedInfo(S); // tools/MCP/usage from the account-wide meta info, if it's already in by now
  card.dataset.id = S.cid; // what canvas tools call this card
  log.dataset.ink = `c:${S.cid}`; // drawing over the chat scrolls with it
  log.dataset.inkRows = ''; // and stays on the message it was drawn over (see canvas/ink/inkrows.ts)
  log.append(emptyState(S));
  cards.push(S);
  attach(); // the page's one stream reads this card too, from its process's first line once it starts

  card.addEventListener('rename', e => {
    S.title = (e as CustomEvent<string>).detail;
    renderCard(S);
    saveSoon();
  });
  card.addEventListener('pointerdown', () => focus(S), true);
  card.addEventListener('focusin', () => focus(S));
  // a waiting permission prompt answers to Enter / Esc from the card, but never from a control of the card's own:
  // Enter on Stop or a dropdown must not allow a command, Esc in the message box only leaves it
  card.addEventListener(
    'keydown',
    e => {
      const open = S.log.querySelector<HTMLElement>('.ask.perm:not(.done)'),
        t = e.target as Element;
      if (!open || t.closest('.cmds, .pnode')) return;
      const control = t.closest(`${EDITABLE}, button, a[href], [role=button]`);
      if (control && !open.contains(control)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        if (control) return; // the ask's own buttons (Deny, View diff...) do what they say
        e.preventDefault();
        e.stopPropagation();
        open.querySelector<HTMLButtonElement>('.btn.primary')!.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        open.querySelector<HTMLButtonElement>('.row .btn:not(.primary)')!.click();
      }
    },
    true,
  );
  new ResizeObserver(redraw).observe(card);

  focus(S);
  renderCard(S);
  if (!opts.rect) {
    if (!opts.here) centerOn(card);
    S.ta.focus({ preventScroll: true });
  }
  return S;
}

/** C / Shift+C: the next (or previous) session card: expanded, brought into view and focused. The message box
 *  isn't focused, so C keeps stepping; Enter starts typing in it. */
export function cycleCards(step: 1 | -1) {
  if (!cards.length) return;
  const S = cards[(cards.indexOf(cur!) + step + cards.length) % cards.length] ?? cards[0];
  expand(S.card);
  focus(S);
  if (onCanvas(S.card)) centerOn(S.card);
  else S.card.scrollIntoView({ block: 'nearest' }); // pinned to the sidebar
  ping(S.card);
}

/** Make a card the focused one (raised, marked, saved as the focus). */
export function focus(S: Session) {
  if (cur === S) return;
  cur?.card.classList.remove('focus');
  cur = S;
  S.card.classList.add('focus');
  bringToFront(S.card);
  saveSoon();
}

/** The card's ×: closing kills its process, so a card still working (a turn, a question for you, background agents) asks first. */
async function askClose(S: Session) {
  const work = [S.pending && 'a reply', S.asks.size && 'a question for you', S.bg && 'background agents'].filter(
    Boolean,
  );
  if (
    work.length &&
    !(await confirmBox(
      'Close this session?',
      `${who(S.backend)} is still working (${work.join(', ')}). Closing stops it; the conversation stays in History.`,
      'Close',
    ))
  )
    return;
  closeSession(S);
}

/** Close a card: stop its process, take its windows and ink with it, and refresh History (a new card if it was the
 *  last). */
export function closeSession(S: Session) {
  post('close', { cid: S.cid }).catch(() => {});
  S.images = [];
  keepImages(S); // its draft's pictures
  dropSession(S);
  dropPlans(S);
  dropAgents(S);
  clearInk(S.log); // its ink goes with it, and its rows stop being watched
  S.card.remove();
  cards.splice(cards.indexOf(S), 1);
  attach(); // the page's stream stops reading it
  if (cur === S) cur = undefined;
  if (!cards.length) newSession();
  save();
  loadSessions();
}

/** /clear: a fresh conversation in this card. The CLI's own /clear does nothing in the mode the cards run it in,
 *  so the card's process is closed and its next message starts a new one; the old conversation stays in History. */
export async function clearSession(S: Session) {
  S.stale = S.gen; // lines the old process still sends (a busy turn's tail, its exit) mustn't land in the cleared card
  S.log.replaceChildren(make('p', 'none', 'Clearing…')); // a send that's mid-way sees its bubble gone and stops (live.ts)
  await post('close', { cid: S.cid }).catch(() => {});
  dropSession(S); // its Files and commands windows belonged to that conversation
  dropPlans(S);
  dropAgents(S);
  clearInk(S.log);
  Object.assign(S, {
    sid: null,
    title: 'New session',
    cost: 0,
    done: false,
    pending: 0,
    bg: 0,
    blocks: {},
    tools: {},
    queued: [],
    picked: false,
    ctx: { used: 0, max: 0 },
  });
  S.asks.clear();
  S.sentRefs.clear();
  S.log.replaceChildren(emptyState(S));
  renderCard(S);
  attach(); // read its next process from the start
  save();
  loadSessions();
}

onSendKey(() => cards.forEach(renderCard)); // the placeholder names the send key
