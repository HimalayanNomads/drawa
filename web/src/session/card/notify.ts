// Telling you when an agent finishes: an in-app notice, or a count in the tab title and a system notification
// (if you allowed them) while you're away. Approvals and plans are announced wherever focus is.

import { watched } from '../../canvas/core/items';
import { centerOn } from '../../canvas/core/placement';
import { who } from '../../lib/agents';
import { button, make, notice, project } from '../../lib/dom';
import type { Session } from '../../types/session';
import { cur, focus } from './session';

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

/** Tell you a card finished or needs you, with a completion notice in-app or a system notification while away. */
export function notify(session: Session, why: 'done' | 'ask' | 'plan') {
  const heading =
    why === 'done'
      ? `${who(session.backend)} finished`
      : why === 'plan'
        ? 'Plan ready for review'
        : `${who(session.backend)} needs your approval`;
  if (why !== 'done') announce(`${heading}: ${session.title}`);
  if (!isAway()) {
    if (why !== 'done' || !session.card.isConnected || (cur === session && watched(session.card))) return;
    const show = button('Show', '', () => {
      completion.remove();
      if (!session.card.isConnected) return;
      focus(session);
      centerOn(session.card);
    });
    show.setAttribute('aria-label', `Show ${session.title}`);
    const completion = notice(`${heading}: ${session.title}`, show);
    completion.classList.add('completion');
    setTimeout(() => completion.remove(), 8000);
    return;
  }
  unread++;
  updateTitle();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const notification = new Notification(heading, {
    body: session.title,
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
