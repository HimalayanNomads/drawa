// What you're writing in a card's message box survives a reload (the one after an update included): its text and
// references are saved with the layout, its pictures in IndexedDB (too big for localStorage), by the card's id.

import { byIds } from '../../canvas/core/items';
import { type Ref, refOf } from '../../canvas/core/refs';
import { base64, dropBlob, getBlob, putBlob } from '../../lib/blobs';
import { persist } from '../../lib/store';
import type { Session } from '../../types/session';
import { cards } from '../card/session';
import { putBack } from './composer';
import type { Pasted } from './images';

// ponytail: references to things that aren't canvas items (text files dropped in, a pull request) aren't kept
type Draft = { text?: string; refs?: string[]; images?: number };
const kept = new Map<string, string>(); // per card: the pictures in IndexedDB (their URLs), so unchanged ones aren't rewritten
/** The IndexedDB key of a draft's image `i`. */
const draftKey = (cid: string, i: number) => `draft:${cid}:${i}`;

/** Whether the card has something unsent in its box (such a card is kept on reload even with no conversation yet). */
export const hasDraft = (S: Session) => !!(S.ta.value.trim() || S.refs.length || S.images.length);

persist(
  'drafts',
  () =>
    Object.fromEntries(
      cards.filter(hasDraft).map(S => [
        S.cid,
        {
          text: S.ta.value || undefined,
          refs: S.refs.length ? S.refs.flatMap(r => r.el.dataset.id ?? []) : undefined,
          images: S.images.length || undefined,
        } satisfies Draft,
      ]),
    ),
  async (all: Record<string, Draft>) => {
    const ids = byIds();
    for (const [cid, d] of Object.entries(all ?? {})) {
      const S = cards.find(s => s.cid === cid);
      if (!S) continue;
      const refs = (d.refs ?? [])
        .map(id => ids.get(id))
        .map(el => el && refOf(el))
        .filter((r): r is Ref => !!r);
      const images: Pasted[] = [];
      for (let i = 0; i < (d.images ?? 0); i++) {
        const b = await getBlob(draftKey(cid, i)).catch(() => undefined);
        if (b) images.push({ type: b.type, data: await base64(b), url: URL.createObjectURL(b), blob: b });
      }
      putBack(S, d.text ?? '', refs, images, false);
    }
  },
  2,
); // after the items its references point at

/** The card's pictures changed: keep them in IndexedDB as its draft (none: drop what was kept). */
export function keepImages(S: Session) {
  const now = S.images.map(i => i.url).join(),
    before = kept.get(S.cid);
  if (now === (before ?? '')) return;
  const had = before ? before.split(',').length : 0;
  S.images.forEach((img, i) => {
    if (img.blob) putBlob(draftKey(S.cid, i), img.blob).catch(() => {});
  });
  for (let i = S.images.length; i < had; i++) dropBlob(draftKey(S.cid, i)).catch(() => {});
  kept.set(S.cid, now);
}
