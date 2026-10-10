// Telling you when Claude needs you while you're looking elsewhere: a count in the tab title, and a system
// notification (if you allowed them) when a turn finishes or Claude waits for an approval or an answer.

import { centerOn } from '../../canvas/core/placement';
import { who } from '../../lib/agents';
import { make, project } from '../../lib/dom';
import type { Session } from '../../types/session';
import { focus } from './session';

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

/** Tell you a card finished or needs you: a count in the tab title and a system notification while you're away. */
export function notify(S: Session, why: 'done' | 'ask' | 'plan') {
  const head =
    why === 'done'
      ? `${who(S.backend)} finished`
      : why === 'plan'
        ? 'Plan ready for review'
        : `${who(S.backend)} needs your approval`;
  if (why !== 'done') announce(`${head}: ${S.title}`);
  if (!isAway()) return;
  unread++;
  updateTitle();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(head, { body: S.title, tag: S.cid + why, silent: why === 'done' });
  n.onclick = () => {
    window.focus();
    focus(S);
    centerOn(S.card);
    n.close();
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
