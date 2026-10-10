// Model and effort, per session card: which model this card's Claude runs as, and how hard it thinks. Picked in the
// card's message bar, alongside its permission mode (mode.ts). Both go with the next send: the model switches the
// running process silently; the CLI can't change effort on a running process, so the server starts a new one
// (resuming the conversation) once it's idle (live.Start).

import { agentMeta, getPref, metaNow, noEffort, setPref, title } from '../../lib/agents';
import { make } from '../../lib/dom';
import { saveSoon } from '../../lib/store';
import type { Session } from '../../types/session';
import { cards, meta } from './session';

/** The models a card's agent offers. */
// Claude Code's models come with its other account-wide info (meta, main.ts); another agent's from lib/agents.ts
const modelsOf = (S: Session) => (S.backend === 'claude' ? meta.models : metaNow(S.backend).models);

/** Fill a card's model picker from its agent's models, keeping the card's choice. */
function fillModel(S: Session, sel: HTMLSelectElement) {
  const models = modelsOf(S);
  if (!models.length) return; // not in yet: keep the placeholder (and the card's choice, if restored)
  sel.replaceChildren(
    ...models.map(o => {
      const opt = make('option', '', o.value === 'default' ? 'Default model' : o.displayName); // beside the effort picker's "Default effort"
      opt.value = o.value === 'default' ? '' : o.value;
      opt.title = o.description;
      return opt;
    }),
  );
  if (!models.some(o => o.value === S.model)) S.model = ''; // e.g. a remembered model the agent no longer offers
  sel.value = S.model; // the card's choice, restored or picked before the list arrived
  if (S.effortSel) fillEffort(S, S.effortSel);
}

/** The model last picked for this agent (this browser). */
// The last model (per agent: model names don't carry over) and effort you picked: new cards start with them (this browser)
export const lastModel = (backend: string) => getPref(`drawa:model:${backend}`);
/** Where the effort picked for an agent is remembered. */
// not Auto: it's the /effort command's, not a level Claude can start at (config.Efforts), so a new card couldn't send
// Claude keeps the old key, so existing users keep their choice
const effortKey = (backend: string) => (backend === 'claude' ? 'drawa:effort' : `drawa:effort:${backend}`);
/** The effort last picked for this agent (this browser), when it's one the agent offers. */
export const lastEffort = (backend: string) => {
  const e = getPref(effortKey(backend));
  return backend !== 'claude' || (e !== 'auto' && EFFORTS.some(([v]) => v === e)) ? e : '';
};

/** The model picker for a card's message bar: options come from its agent itself (GET /api/meta). A fresh backend
 *  (nothing asked yet this page load) can take a few seconds the first time (its own throwaway process, and for
 *  OpenCode, its model catalog warming up), so the picker shows a spinner and disables rather than sitting there
 *  looking like "Default" is the only option. */
export function modelPicker(S: Session) {
  const sel = make('select', 'modelsel');
  sel.setAttribute('aria-label', 'Model for this session');
  sel.append(Object.assign(make('option', '', 'Default model'), { value: '' }));
  fillModel(S, sel);
  if (S.backend !== 'claude' && !modelsOf(S).length) {
    sel.disabled = true;
    sel.dataset.loading = '';
    sel.title = `Fetching ${title(S.backend)}'s models — this can take a few seconds the first time…`;
    agentMeta(S.backend).then(() => {
      fillModel(S, sel);
      sel.disabled = false;
      delete sel.dataset.loading;
      sel.removeAttribute('title');
    });
  }
  sel.value = S.model;
  sel.onchange = () => {
    S.model = sel.value;
    setPref(`drawa:model:${S.backend}`, S.model);
    if (S.effortSel) fillEffort(S, S.effortSel);
    saveSoon();
  };
  S.modelSel = sel;
  return sel;
}

/** Claude's own model list just arrived (or changed): refill every open card's picker without losing its choice. */
export function refreshModels() {
  for (const S of cards) if (S.modelSel) fillModel(S, S.modelSel);
}

/** Sets a card's model without an onchange round-trip (restoring a saved card). */
export function setModel(S: Session, model: string) {
  S.model = model;
  if (S.modelSel) S.modelSel.value = model;
}

export const EFFORTS: [string, string, string][] = [
  ['', 'Default effort', "Claude's own default effort for the model"],
  ['low', 'Low', 'Fast, lighter-weight answers'],
  ['medium', 'Medium', 'Handles most tasks'],
  ['high', 'High', 'More thorough, slower'],
  ['xhigh', 'Extra high', 'Very thorough, slower still'],
  ['max', 'Max', 'Most thorough; burns through usage fastest'],
  ['auto', 'Auto', 'Claude adjusts effort per turn'],
];

/** The effort picker for a card's message bar. It's sent with every message; the process picks it up at its next
 *  start (see Start and buildArgv in internal/live). */
export function effortPicker(S: Session) {
  const sel = make('select', 'effortsel');
  sel.setAttribute('aria-label', 'Effort for this session');
  sel.onchange = () => {
    S.effort = sel.value;
    setPref(effortKey(S.backend), S.effort);
    saveSoon();
  };
  S.effortSel = sel;
  fillEffort(S, sel);
  return sel;
}

/** A Read more link beside a disabled effort picker, for an agent that says why it has none; null otherwise. */
export function effortNote(S: Session) {
  const href = noEffort(S.backend);
  if (!href) return null;
  const a = make('a', 'effortnote', 'Read more');
  Object.assign(a, {
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: `Why ${title(S.backend)} has no effort setting`,
  });
  return a;
}

const LABELS: Record<string, string> = { xhigh: 'Extra high', minimal: 'Minimal' };
/** An effort level as the picker shows it ("High", "Max"). */
const effortLabel = (e: string) => LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

/** The effort levels to offer for a card's model. */
// Claude's levels are fixed; another agent's come per model from its meta. "Default model" ('') uses the agent's
// Default entry ('' from other agents, 'default' from Claude) when it lists one; with no levels to offer, the picker hides.
function effortsOf(S: Session): [string, string, string][] {
  if (S.backend === 'claude') return EFFORTS;
  const models = modelsOf(S),
    m = models.find(o => (S.model ? o.value === S.model : o.value === '' || o.value === 'default'));
  const levels = m?.efforts ?? [];
  if (!levels.length) return [];
  return [
    ['', 'Default effort', `${title(S.backend)}'s own default effort for the model`],
    ...levels.map(e => [e, effortLabel(e), ''] as [string, string, string]),
  ];
}

/** Refills a card's effort options for its current model (picked, restored or arrived late), dropping a level it doesn't offer.
 *  Restored cards' effort is kept until their agent's models are in, so a slow meta doesn't wipe it. */
function fillEffort(S: Session, sel: HTMLSelectElement) {
  if (noEffort(S.backend)) {
    // shown, but off: the agent can't take one (effortNote says why)
    S.effort = '';
    sel.replaceChildren(Object.assign(make('option', '', 'Effort: disabled'), { value: '' }));
    sel.disabled = true;
    sel.title = `${title(S.backend)} can't change effort from Drawa`;
    return;
  }
  const efforts = effortsOf(S);
  sel.replaceChildren(
    ...efforts.map(([value, l, desc]) => Object.assign(make('option', '', l), { value, title: desc })),
  );
  if (efforts.length) {
    if (!efforts.some(([v]) => v === S.effort)) S.effort = '';
  } else if (modelsOf(S).length) S.effort = '';
  if (efforts.length) sel.value = S.effort;
  if (efforts.length) delete sel.dataset.off;
  else sel.dataset.off = '';
}

/** Sets a card's effort without an onchange round-trip (restoring a saved card). */
export function setEffort(S: Session, effort: string) {
  S.effort = effort;
  if (S.effortSel) fillEffort(S, S.effortSel);
}

/** A status line below the message bar: tools available and context used as text, plus a ring badge each for the
 *  5-hour and 7-day usage windows (filled by how much of that window is used; hover either for the exact numbers
 *  and reset time). Filled from state the process reports as it runs (its init line, and rate_limit_event; see
 *  stream.ts); hidden until then. Re-rendered on a minute ticker (below) so the rings don't go stale between turns. */
function ringWrap(label: string) {
  const wrap = make('span', 'ringwrap'),
    el = make('span', 'ring'),
    pct = make('span', 'pct');
  el.dataset.label = label;
  wrap.append(el, pct);
  return { wrap, el, pct };
}

/** "N tools loaded · M/T MCP servers · P% context" plus the two usage rings, all in one row: a full-width flex
 *  item forces it below the model/effort dropdowns, right-aligned under the effort one. */
export function infoBadge(S: Session) {
  const el = make('div', 'status'),
    text = make('span', 'stext');
  const r5 = ringWrap('5h'),
    r7 = ringWrap('7d');
  el.append(text, r5.wrap, r7.wrap);
  el.hidden = true;
  Object.assign(S, { infoEl: el, infoText: text, ring5h: r5.el, ring5hPct: r5.pct, ring7d: r7.el, ring7dPct: r7.pct });
  return el;
}

/** A reset time as a clock time, with the date when it isn't today. */
function clockTime(unixSeconds: number) {
  const d = new Date(unixSeconds * 1000),
    time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** "3h 42m" (or "5d 2h" for the weekly window); "now" once it's passed but no fresher event arrived yet. */
function countdown(unixSeconds: number) {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  const d = Math.floor(mins / 1440),
    h = Math.floor((mins % 1440) / 60),
    m = mins % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** Draw a usage-window ring: how much of the window is used, and when it resets (in its tooltip). */
function drawRing(
  el: HTMLElement | undefined,
  pctEl: HTMLElement | undefined,
  util: number | undefined,
  resetAt: number | undefined,
  label: string,
) {
  if (!el || !pctEl) return;
  const wrap = el.parentElement;
  if (util == null || resetAt == null) {
    if (wrap) wrap.hidden = true;
    return;
  }
  if (wrap) wrap.hidden = false;
  const pct = Math.round(util * 100);
  el.style.setProperty('--p', String(pct));
  pctEl.textContent = `${pct}%`;
  const title = `${label}: ${pct}% used, resets in ${countdown(resetAt)} (${clockTime(resetAt)}).`;
  el.title = pctEl.title = title;
}

/** Fills a card's status fields from the account-wide meta info (tools/MCP/usage), unless its own process has
 *  already reported fresher ones. Called for a brand-new card, and again for every open card once /api/meta
 *  answers (it can take a while the first time: it spins up its own throwaway `claude` process). */
export function seedInfo(S: Session) {
  if (S.backend !== 'claude')
    return void agentMeta(S.backend).then(m => {
      // Codex's usage windows come with its model list
      if (S.usageResetAt == null && S.weeklyResetAt == null)
        renderInfo(
          Object.assign(S, {
            usageUtil: m.usageUtil,
            usageResetAt: m.usageResetAt,
            weeklyUtil: m.weeklyUtil,
            weeklyResetAt: m.weeklyResetAt,
          }),
        );
    });
  if (S.toolCount || meta.tools == null) return; // Claude Code's account and usage windows
  S.toolCount = meta.tools;
  S.mcpTotal = meta.mcpTotal ?? 0;
  S.mcpConnected = meta.mcpConnected ?? 0;
  S.usageUtil = meta.usageUtil;
  S.usageResetAt = meta.usageResetAt;
  S.weeklyUtil = meta.weeklyUtil;
  S.weeklyResetAt = meta.weeklyResetAt;
  renderInfo(S);
}

/** Draw a card's status line under its message box: tools loaded, context used, and the usage rings. */
export function renderInfo(S: Session) {
  const el = S.infoEl;
  if (!el) return;
  el.hidden = !S.toolCount && S.usageResetAt == null && S.weeklyResetAt == null;
  if (el.hidden) return;
  const pct = S.ctx.max ? Math.min(100, Math.round((S.ctx.used / S.ctx.max) * 100)) : 0;
  const parts = S.toolCount ? [`${S.toolCount} tools loaded`] : [];
  if (S.mcpTotal) parts.push(`${S.mcpConnected}/${S.mcpTotal} MCP servers`);
  if (S.ctx.used) parts.push(`${pct}% context`);
  S.infoText!.textContent = parts.join(' · ');
  S.infoText!.title =
    (S.toolCount
      ? `${S.toolCount} tools available${S.mcpTotal ? ` (${S.mcpConnected} of ${S.mcpTotal} MCP servers connected)` : ''}. `
      : '') +
    (S.ctx.used
      ? `Context: ${S.ctx.used.toLocaleString()} of ${S.ctx.max.toLocaleString()} tokens used (${pct}%).`
      : '');
  drawRing(S.ring5h, S.ring5hPct, S.usageUtil, S.usageResetAt, '5-hour usage limit');
  drawRing(S.ring7d, S.ring7dPct, S.weeklyUtil, S.weeklyResetAt, 'Weekly usage limit');
}

// the countdowns go stale between turns: nudge them back into shape once a minute, for any card showing one
setInterval(() => {
  for (const S of cards) if (S.usageResetAt || S.weeklyResetAt) renderInfo(S);
}, 60_000);
