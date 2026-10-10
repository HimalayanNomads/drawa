// Drawing a card from its state: the header (title, model, context use, sub-agents badge), status classes and the
// message box's placeholder; and appending to its log, staying pinned to the bottom while you read there.
import './session'; // entering here still loads the card module first, so sub-agent windows (items/agent.ts) register before cards, as they always have
import { runningAgents } from '../../items/agent';
import { copySidTip, installed, title, who } from '../../lib/agents';
import { sendCombo } from '../../lib/sendkey';
import type { Session } from '../../types/session';
import { renderInfo } from './gen';

/** Header, status classes and composer placeholder from the session's current state. */
export function renderCard(S: Session) {
  if (S.replaying) return; // once at the end instead
  const busy = S.pending > 0 || S.bg > 0;
  S.card.dataset.state = S.asks.size ? 'asking' : busy ? 'busy' : S.done ? 'done' : 'idle';
  const t = S.card.querySelector<HTMLElement>('.t')!;
  if (!t.isContentEditable) t.textContent = S.title; // being renamed: a busy card re-renders often, don't wipe what you type
  const m = S.card.querySelector<HTMLElement>('.win-h .m')!;
  const model = S.reportedModel.replace(/^claude-/, '').replace(/^[\w.-]+\//, ''); // opencode reports provider/model
  m.textContent = installed().length > 1 ? [title(S.backend), model].filter(Boolean).join(' · ') : model; // which agent, once there's a choice
  const run = runningAgents(S).length,
    badge = S.card.querySelector<HTMLElement>('.win-h .agents')!;
  badge.hidden = !run;
  badge.textContent = String(run);
  badge.title = `${run} sub-agent${run === 1 ? '' : 's'} running. Click to show ${run === 1 ? 'its window' : 'the next one'}.`;
  badge.setAttribute('aria-label', badge.title);
  // The CLI reports an API-equivalent estimate even on a subscription, where it isn't billed: hover only.
  m.title = !S.cost
    ? ''
    : S.backend === 'claude'
      ? `Estimated API-equivalent cost: $${S.cost.toFixed(2)} (not billed on a Claude subscription)`
      : `Cost ${who(S.backend)} reports so far: $${S.cost.toFixed(2)}`;
  const ctx = S.card.querySelector<HTMLElement>('.win-h .ctx')!,
    pct = S.ctx.max ? Math.min(100, Math.round((S.ctx.used / S.ctx.max) * 100)) : 0;
  ctx.hidden = !S.ctx.used;
  ctx.style.setProperty('--p', `${pct}%`);
  ctx.dataset.level = pct >= 80 ? 'high' : pct >= 60 ? 'mid' : '';
  ctx.textContent = `${pct}%`;
  ctx.title = `Context: ${S.ctx.used.toLocaleString()} of ${S.ctx.max.toLocaleString()} tokens used. Click to write /compact (summarizes the conversation to free space).`;
  const sidBtn = S.card.querySelector<HTMLElement>('.win-h .sidbtn')!;
  sidBtn.hidden = !S.sid;
  if (S.sid) sidBtn.title = copySidTip(S.backend, S.sid);
  renderInfo(S);
  S.log.classList.toggle('busy', S.pending > 0);
  S.log.setAttribute('aria-busy', String(S.pending > 0));
  S.stopBtn.hidden = !busy;
  if (!busy || (S.stopBtn.dataset.state === 'stopping' && !S.pending)) delete S.stopBtn.dataset.state; // what it stopped is over
  // with no turn running, what's left to stop is background agents: they end with the process (see composer.ts)
  S.stopBtn.title = S.stopBtn.dataset.state
    ? 'Stopping\u2026'
    : S.pending
      ? `Stop what ${who(S.backend)} is doing`
      : 'Stop its background agents';
  S.ta.placeholder = busy
    ? `${who(S.backend)} is working. Type to queue a message.`
    : `Message ${who(S.backend)}: / commands, @ files, ! shell · ${sendCombo()} sends`;
}

/* ---------- appending to the log ---------- */
/** Append to the log, staying pinned to the bottom if you were reading there. */
export function appendToLog<T extends HTMLElement>(S: Session, e: T): T {
  S.log.append(e);
  if (!S.replaying && S.atEnd) S.log.scrollTop = S.log.scrollHeight;
  return e;
}
/** Open at the latest message and stay there while the log settles: rows render at their real height only once
 *  they're on screen (content-visibility), and diagrams and pictures finish later, so one scroll to the bottom
 *  lands short. Stops early the moment you scroll or click in the log yourself. */
const SETTLE_MS = 4000;
/** Open at the latest message and stay there while the log settles (rows render late); your own scroll or click stops
 *  it. */
export function pinToBottom(S: Session) {
  const log = S.log,
    end = performance.now() + SETTLE_MS,
    yours = new AbortController();
  for (const t of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
    log.addEventListener(t, () => yours.abort(), { passive: true, signal: yours.signal });
  /** Scroll to the bottom again each frame until the time is up or you take over. */
  const tick = () => {
    if (yours.signal.aborted || S.log !== log || performance.now() > end) return yours.abort();
    log.scrollTop = log.scrollHeight;
    requestAnimationFrame(tick);
  };
  tick();
}
/** Keep the log at its bottom when you're reading there (not while replaying). */
export const follow = (S: Session) => {
  if (!S.replaying && S.atEnd) S.log.scrollTop = S.log.scrollHeight;
};
