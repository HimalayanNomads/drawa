// The ? sheet (every registered shortcut, grouped) and the launch tip (one shortcut worth knowing, per launch).
// Both read lib/keys.ts when they open, so they list whatever the imported modules registered.
import { $, button, ICON, iconButton, make } from './dom';
import { type Command, command, commands, keysOf } from './keys';

const ORDER = ['Canvas', 'Items', 'Windows', 'Selection', 'Draw', 'Message box'];

/** Key caps for one combo: "Shift+w" -> <kbd>Shift</kbd><kbd>W</kbd>; "Ctrl" shows as ⌘ on a Mac. */
const caps = (combo: string) => keysOf(combo).map(k => make('kbd', '', k));

/** Tip text with `backticked` keys drawn as key caps. */
function tipText(p: HTMLElement, text: string) {
  text.split('`').forEach((s, i) => {
    if (s) p.append(...(i % 2 ? caps(s) : [s]));
  });
  return p;
}

/** The combos a row shows: arrow keys alone read as one cap ("←→↑↓", not "← or → or ↑ or ↓"). */
function shown(keys: string[]) {
  const each = keys.map(keysOf);
  return keys.length > 1 && each.every(c => c.length === 1 && /^[←→↑↓]$/.test(c[0]))
    ? [each.map(c => c[0]).join('')]
    : keys;
}

/** One shortcut's row in the ? sheet: its label and its key caps. */
function row(c: Command) {
  const r = make('div', 'kh-r'),
    k = make('span', 'k');
  r.dataset.label = c.label.toLowerCase();
  for (const combo of shown(c.keys ?? [])) k.appendChild(make('span', 'combo')).append(...caps(combo));
  r.append(make('span', '', c.label), k);
  return r;
}

let sheet: HTMLDialogElement | null = null;
/** Open the ? sheet: every registered shortcut, grouped, with a filter box. */
export function showHelp() {
  if (sheet?.open) return;
  const d = (sheet ??= document.body.appendChild(make('dialog', 'keys-help')));
  d.setAttribute('aria-label', 'Keyboard shortcuts');
  const input = make('input');
  Object.assign(input, { type: 'text', placeholder: 'Filter shortcuts', spellcheck: false });
  input.setAttribute('aria-label', 'Filter shortcuts');
  const bar = make('div', 'kh-bar');
  bar.append(
    make('h2', '', 'Keyboard shortcuts'),
    input,
    iconButton(ICON.x, 'Close', () => d.close()),
  );

  const body = make('div', 'kh-body');
  const listed = commands().filter(c => c.keys?.length);
  const groups = [...new Set([...ORDER, ...listed.map(c => c.group)])];
  for (const g of groups) {
    const rows = listed.filter(c => c.group === g);
    if (!rows.length) continue;
    const sec = make('section', 'kh-g');
    sec.append(make('h3', '', g), ...rows.map(row));
    body.append(sec);
  }
  const none = body.appendChild(make('p', 'kh-none', 'No shortcut matches.'));
  none.hidden = true;
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    for (const sec of body.querySelectorAll<HTMLElement>('.kh-g')) {
      let any = false;
      for (const r of sec.querySelectorAll<HTMLElement>('.kh-r'))
        any = !(r.hidden = !r.dataset.label!.includes(q)) || any;
      sec.hidden = !any;
    }
    none.hidden = !!body.querySelector('.kh-g:not([hidden])');
  };

  const foot = make('p', 'kh-foot');
  tipText(foot, "Shortcuts don't fire while you're typing. `Ctrl+K` also runs actions by name.");
  d.replaceChildren(bar, body, foot);
  d.onclick = e => {
    if (e.target === d) d.close();
  }; // click outside the sheet closes it, like confirmBox
  d.showModal();
  input.focus();
}
$('#btn-help').onclick = () => showHelp();
command({ label: 'Keyboard shortcuts', group: 'Items', keys: ['[Shift]+?'], run: showHelp });

/* ---------- launch tip ---------- */
const KEY = 'drawa:tips'; // global, not per project: the shortcuts are the same everywhere
interface Tips {
  next: number;
  off: boolean;
}
/** Which launch tip comes next and whether tips are off, from this browser. */
const load = (): Tips => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { next: Number.isInteger(s?.next) && s.next >= 0 ? s.next : 0, off: s?.off === true };
  } catch {
    return { next: 0, off: false };
  }
};
/** Remember the launch tip state. */
const save = (t: Tips) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* private mode: tips just repeat */
  }
};

/** One quiet tip in the corner, the next in turn each launch. Never takes focus; goes away by itself after 10s. */
export function showTip() {
  const tips = commands().filter(c => c.tip),
    st = load();
  if (st.off || !tips.length || document.querySelector('.launch-tip')) return;
  const el = make('div', 'launch-tip float');
  el.setAttribute('role', 'status');
  const p = make('p');
  /** Show the next tip in the rotation. */
  const show = () => {
    p.replaceChildren();
    tipText(p, tips[st.next % tips.length].tip!);
    st.next = (st.next + 1) % tips.length;
    save(st);
  };

  let timer = 0;
  /** Take the tip away. */
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  /** Is the pointer or focus on the tip? It stays while you're reading it. */
  const held = () => el.matches(':hover, :focus-within');
  /** Start (or restart) the countdown that takes the tip away. */
  const arm = () => {
    clearTimeout(timer);
    if (!held()) timer = setTimeout(close, 10000);
  };
  // paused while the pointer or focus is on it; the full 10s again once they leave
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => queueMicrotask(arm));
  el.addEventListener('focusout', () => setTimeout(arm)); // after focus has moved, so :focus-within is current

  const icon = make('span', 'spark');
  icon.innerHTML = ICON.sparkle;
  icon.setAttribute('aria-hidden', 'true');
  const more = make('div', 'more');
  more.append(
    button('All shortcuts', '', () => {
      close();
      showHelp();
    }),
    button('Hide tips', '', () => {
      st.off = true;
      save(st);
      close();
    }),
  );
  el.append(
    icon,
    p,
    iconButton(
      '›',
      'Next tip',
      () => {
        show();
        arm();
      },
      'next',
    ),
    iconButton(ICON.x, 'Close tip', close),
    more,
  );
  show();
  document.body.append(el);
  arm();
}
