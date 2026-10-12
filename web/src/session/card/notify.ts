// Completion alerts follow Settings; the unread count and question/approval/plan alerts stay independent.

import { watched } from '../../canvas/core/items';
import { centerOn } from '../../canvas/core/placement';
import { who } from '../../lib/agents';
import { button, make, notice, project } from '../../lib/dom';
import { prefs } from '../../lib/prefs';
import { CompletionMode } from '../../types/prefs';
import type { Session } from '../../types/session';
import { cur, focus } from './session';

const COMPLETION_NOTICE_TIMEOUT_MS = 3000;

let unread = 0;
/** Are you looking elsewhere (another tab or app)? */
const isAway = () => document.hidden || !document.hasFocus();
/** Show the unread count in the tab's title. */
const updateTitle = () => {
  document.title = `${unread ? `(${unread}) ` : ''}${project.name} · Drawa`;
};

/** Ask for notification permission once ever, from a user action (sending a message). Dismissing the browser's
 *  prompt (neither allow nor block) leaves permission 'default', so a plain permission check would ask again on
 *  every message; the localStorage flag remembers we already asked. */
const ASKED_KEY = 'drawa:notify:asked';
/** Ask for notification permission once ever, from a user action (the browser forgets a dismissed prompt). */
export function askPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  try {
    if (localStorage.getItem(ASKED_KEY)) return;
  } catch {}
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {}
  Notification.requestPermission().catch(() => {});
}

// Screen readers hear an approval or a plan as it arrives, wherever focus is (the finished reply itself is read from
// the card's role=log). Cleared first: the same words twice in a row wouldn't be read again.
const live = document.body.appendChild(make('div', 'sr-only'));
live.setAttribute('aria-live', 'assertive');
/** Read a message out to screen readers. */
const announce = (text: string) => {
  live.textContent = '';
  setTimeout(() => (live.textContent = text), 50);
};

/** Name the backend and session once, distinguishing a question from a tool approval. */
function getHeading(session: Session, why: 'done' | 'ask' | 'plan', question: boolean) {
  const name = `${who(session.backend)}: ${session.title}`;
  if (why === 'done') return `${name} Finished`;
  if (why === 'plan') return `${name} Plan ready for review`;
  return `${name} ${question ? 'Questions asked' : 'Needs your approval'}`;
}

/** Tell you a card finished or needs you, without changing focus until you choose its alert. */
export function notify(session: Session, why: 'done' | 'ask' | 'plan', question = false) {
  const heading = getHeading(session, why, question),
    away = isAway();
  if (why !== 'done') announce(heading);
  if (away) {
    unread++;
    updateTitle();
  }
  if (why === 'done') {
    const mode = prefs().completion;
    if (mode === CompletionMode.None) return;
    if (mode === CompletionMode.Toast) {
      if (!session.card.isConnected || (cur === session && watched(session.card))) return;
      const show = button('Show', '', () => {
        completion.remove();
        if (!session.card.isConnected) return;
        focus(session);
        centerOn(session.card);
      });
      show.setAttribute('aria-label', `Show ${session.title}`);
      const completion = notice(heading, show);
      completion.classList.add('completion');
      setTimeout(() => completion.remove(), COMPLETION_NOTICE_TIMEOUT_MS);
      return;
    }
  }
  if (!away) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const notification = new Notification(heading, {
    tag: session.cid + why,
    silent: why === 'done',
  });
  notification.onclick = () => {
    window.focus();
    focus(session);
    centerOn(session.card);
    notification.close();
  };
}

/** You're back: the unread count clears. */
const markSeen = () => {
  if (unread && !isAway()) {
    unread = 0;
    updateTitle();
  }
};
addEventListener('focus', markSeen);
document.addEventListener('visibilitychange', markSeen);
