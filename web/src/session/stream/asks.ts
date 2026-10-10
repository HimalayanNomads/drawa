// Claude asking you: tool permission prompts and AskUserQuestion forms, answered right in the card.
// (Plan approval goes through the same request, but plan.ts shows it as a document on the canvas.)

import { plansExpired, planWithdrawn, reviewPlan } from '../../items/plan/plan';
import { who } from '../../lib/agents';
import { post } from '../../lib/api';
import { button, confirmBox, make, relPath } from '../../lib/dom';
import { change, inFile } from '../../panels/diff';
import type { Session } from '../../types/session';
import { notify } from '../card/notify';
import { appendToLog, renderCard } from '../card/render';
import { type Msg, toolArg } from './stream';

/** Claude wants to use a tool that needs your OK (or presents a plan, see plan.ts). */
export function approval(S: Session, m: Msg) {
  const r = m.request,
    id: string = m.request_id;
  if (S.asks.has(id)) return; // already shown (re-sent on re-attach)
  S.asks.add(id);
  if (r.tool_name === 'ExitPlanMode') {
    if (!reviewPlan(S, id, r.tool_use_id, r.input?.plan)) S.asks.delete(id);
    else notify(S, 'plan');
    renderCard(S);
    return;
  }
  notify(S, 'ask');
  if (r.tool_name === 'AskUserQuestion') return question(S, id, r.input?.questions ?? []);
  // compact prompt: what exactly will run (the command / path), Claude's own description as a caption
  const input = r.input ?? {},
    tool = r.display_name ?? r.tool_name;
  const what = relPath(String(input.command ?? input.file_path ?? input.url ?? input.pattern ?? toolArg(input) ?? ''));
  const box = appendToLog(S, make('div', 'ask perm')),
    top = make('div', 'top'),
    row = make('div', 'row');
  box.dataset.rid = id;
  top.append(make('span', 'need', 'Approval needed'), make('b', '', tool));
  box.append(top, make('code', '', what || tool));
  const caption =
    r.description && r.description !== what
      ? r.description
      : r.decision_reason !== 'This command requires approval'
        ? r.decision_reason
        : '';
  if (caption) box.append(make('p', '', caption));
  // file changes: show exactly what would change before you allow it
  const diff =
    input.file_path && ['Edit', 'MultiEdit', 'Write'].includes(r.tool_name)
      ? change(S, r.tool_name, relPath(String(input.file_path)), input)
      : undefined;
  if (diff) {
    box.append(diff);
    inFile(diff);
  }
  /** Answer a permission prompt; the buttons come back if the server didn't take it. */
  const answer = (allow: boolean, always = false) => {
    // answered only once the server took it: on failure the buttons stay, to try again
    row.querySelectorAll('button').forEach(b => (b.disabled = true));
    box.querySelector(':scope > .err')?.remove();
    post('respond', { cid: S.cid, request_id: id, allow, always }).then(
      () => {
        box.replaceChildren(
          make(
            'span',
            'answered',
            `${allow ? '\u2713' : '\u2717'} ${allow ? (always ? 'Always allowed' : 'Allowed') : 'Denied'} ${tool}`,
          ),
          make('code', '', what),
        );
        box.classList.add('done', allow ? 'yes' : 'no');
        S.asks.delete(id);
        renderCard(S);
      },
      e => {
        if (!S.asks.has(id)) return; // expired meanwhile (its process ended)
        row.querySelectorAll('button').forEach(b => (b.disabled = false));
        box.append(make('span', 'err', `Could not answer: ${e.message}`));
      },
    );
  };
  /** Add a button to the prompt's row. */
  const btn = (label: string, cls: string, fn: () => void) => row.appendChild(button(label, cls, fn));
  btn('Deny', '', () => answer(false)).title = 'Deny (Esc)';
  if (r.permission_suggestions?.length)
    btn('Always allow', '', () => answer(true, true)).title = 'Allow, and don\u2019t ask again for this';
  const allow = btn('Allow', 'primary', () => answer(true));
  allow.title = 'Allow (Enter)';
  box.append(row);
  row.prepend(make('span', 'keys', 'Enter to allow \u00b7 Esc to deny'));
  renderCard(S);
  box.scrollIntoView({ block: 'nearest' });
  takeFocus(S, allow);
}

/** A new ask takes the keyboard from the card's empty message box, so Enter answers it rather than sending. A draft
 *  being typed, or focus elsewhere on the page, is left alone. */
function takeFocus(S: Session, el: HTMLElement) {
  if (document.activeElement === S.ta && !S.ta.value.trim()) el.focus({ preventScroll: true });
}

/** Claude asks you multiple-choice questions (AskUserQuestion): answer them in the card. */
function question(
  S: Session,
  id: string,
  qs: {
    question: string;
    header?: string;
    options: { label: string; description?: string }[];
    multiSelect?: boolean;
  }[],
) {
  const box = appendToLog(S, make('div', 'ask q')),
    picked = qs.map(() => new Set<string>()),
    other = qs.map(() => '');
  box.dataset.rid = id;
  const row = make('div', 'row'),
    skip = make('button', 'btn', 'Skip'),
    ok = make('button', 'btn primary', 'Answer');
  /** Submit is enabled once every question has an answer. */
  const ready = () => {
    ok.disabled = !qs.every((_, i) => picked[i].size || other[i].trim());
  };
  qs.forEach((q, i) => {
    const f = make('fieldset');
    const hint = make('span', 'hint', q.multiSelect ? 'Pick any' : 'Pick one');
    hint.id = `ask-${id}-${i}`;
    f.setAttribute('role', q.multiSelect ? 'group' : 'radiogroup');
    f.setAttribute('aria-describedby', hint.id);
    f.append(make('legend', '', q.question), hint);
    f.dataset.multi = String(!!q.multiSelect);
    if (q.header) f.prepend(make('span', 'chip', q.header));
    for (const o of q.options) {
      const b = make('button', 'opt');
      b.setAttribute('aria-pressed', 'false');
      b.append(make('b', '', o.label), ...(o.description ? [make('span', '', o.description)] : []));
      b.onclick = () => {
        const on = !picked[i].has(o.label); // before clearing: clicking the picked one of a single choice unpicks it
        if (!q.multiSelect) {
          picked[i].clear();
          f.querySelectorAll('.opt').forEach(x => x.setAttribute('aria-pressed', 'false'));
          if (on) {
            other[i] = '';
            f.querySelector('input')!.value = '';
          } // one answer: an option or your own words
        }
        if (on) picked[i].add(o.label);
        else picked[i].delete(o.label);
        b.setAttribute('aria-pressed', String(on));
        ready();
      };
      f.append(b);
    }
    const inp = make('input');
    inp.placeholder = 'Other (type your own answer)';
    inp.setAttribute('aria-label', `Other answer: ${q.question}`);
    inp.oninput = () => {
      other[i] = inp.value;
      if (!q.multiSelect && inp.value.trim()) {
        picked[i].clear();
        f.querySelectorAll('.opt').forEach(x => x.setAttribute('aria-pressed', 'false'));
      }
      ready();
    };
    inp.onkeydown = e => {
      if (e.key === 'Enter' && !e.isComposing && !ok.disabled) {
        e.preventDefault();
        ok.click();
      }
    }; // like a form's submit
    f.append(inp);
    box.append(f);
  });
  /** Send the answers to the question; the form stays to try again if the server didn't take them. */
  // answered only once the server took it: on failure the choices and typed answers stay, to try again
  const respond = (text: string, body: object) => {
    const ctl = [...box.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')];
    ctl.forEach(x => (x.disabled = true));
    box.querySelector(':scope > .err')?.remove();
    post('respond', { cid: S.cid, request_id: id, ...body }).then(
      () => {
        row.replaceChildren(make('span', 'answered', text));
        box.classList.add('done');
        S.asks.delete(id);
        renderCard(S);
      },
      e => {
        if (!S.asks.has(id)) return; // expired meanwhile (its process ended)
        ctl.forEach(x => (x.disabled = false));
        ready();
        box.append(make('span', 'err', `Could not answer: ${e.message}`));
      },
    );
  };
  ok.onclick = () => {
    const answers = Object.fromEntries(
      qs.map((q, i) => [q.question, [...picked[i], ...(other[i].trim() ? [other[i].trim()] : [])].join(', ')]),
    );
    respond(`Answered: ${Object.values(answers).join(' \u00b7 ')}`, { allow: true, answers });
  };
  skip.onclick = async () => {
    if (
      qs.some((_, i) => picked[i].size || other[i].trim()) &&
      !(await confirmBox('Skip these questions?', 'What you picked or typed won\u2019t be sent.', 'Skip'))
    )
      return;
    respond('Skipped', {
      allow: false,
      message: 'The user skipped these questions; continue with your best judgment.',
    });
  };
  skip.title = 'Skip (Esc, when nothing\u2019s picked)';
  ok.title = 'Answer (Enter)';
  // Enter answers, Esc skips, 1-9 pick an option of the question you're in (Space still toggles a focused option)
  box.addEventListener('keydown', e => {
    const t = e.target as HTMLElement,
      f = t.closest('fieldset') ?? box.querySelector('fieldset');
    if (e.key === 'Escape') {
      // with picks or typed text, Esc isn't a skip: leave it to outer handlers (leaving full view)
      if (qs.some((_, i) => picked[i].size || other[i].trim())) return;
      e.preventDefault();
      e.stopPropagation();
      if (!skip.disabled) skip.click();
      return;
    }
    if (t.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return; // typing, or the input's own Enter
    if (e.key === 'Enter' && (t === box || t.classList.contains('opt'))) {
      e.preventDefault();
      if (!ok.disabled) ok.click();
    } else if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      f?.querySelectorAll<HTMLButtonElement>('.opt')[+e.key - 1]?.click();
    }
  });
  row.prepend(make('span', 'keys', '1\u20139 to pick \u00b7 Enter to answer \u00b7 Esc to skip'));
  row.append(skip, ok);
  box.append(row);
  ready();
  renderCard(S);
  box.scrollIntoView({ block: 'nearest' });
  const first = box.querySelector<HTMLElement>('.opt, input');
  if (first) takeFocus(S, first);
}

/** The card's process ended: what it asked can't be answered any more (the next message starts a new one). */
export function expireAsks(S: Session) {
  if (!S.asks.size) return;
  S.asks.clear();
  for (const box of S.log.querySelectorAll<HTMLElement>('.ask:not(.done)'))
    closeAsk(S, box, `Expired: ${who(S.backend)} stopped before this was answered`);
  plansExpired(S);
}

/** The agent took back one ask (control_cancel_request): it went ahead without an answer, e.g. its turn was stopped. */
export function withdrawAsk(S: Session, id: string) {
  if (!S.asks.delete(id)) return;
  const box = S.log.querySelector<HTMLElement>(`.ask[data-rid="${CSS.escape(id)}"]:not(.done)`);
  if (box) closeAsk(S, box, `Withdrawn: ${who(S.backend)} no longer needs an answer`);
  else planWithdrawn(S, id); // plan approvals are a window on the canvas, not a box in the log
  renderCard(S);
}

/** Close an ask (answered, withdrawn or expired): its controls disabled, its row saying why. */
function closeAsk(S: Session, box: HTMLElement, why: string) {
  // its buttons are about to be disabled: don't let keyboard focus fall to <body>
  if (box.contains(document.activeElement)) S.ta.focus();
  box.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(x => (x.disabled = true));
  box.querySelector(':scope > .err')?.remove();
  box.querySelector(':scope > .chg')?.remove(); // can hold a whole file: done with it
  box.querySelector(':scope > .row')?.replaceChildren(make('span', 'answered', why));
  box.classList.add('done');
}
