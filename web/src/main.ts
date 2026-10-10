// biome-ignore-all assist/source/organizeImports: import order here is evaluation order, which sets registration order (see CLAUDE.md)
// Boot: wire the toolbar and panels, restore the canvas, load history + files.
// Features register themselves on import (saved-layout slices, referable kinds); the imports below are the app.
import './lib/fonts'; // applies the saved font choice right away
import './lib/theme';
import './lib/uimode'; // full or minimal interface, from your settings file (lib/prefs.ts)
import './lib/settings'; // the toolbar's Settings panel
import { symbolsOn } from './lib/symbols'; // code symbols for Ctrl+K and diffs; its Settings control asks the server whether ctags is there
import './lib/tooltip'; // the app's own tooltips for every title="…"
import './lib/update'; // checks GitHub for a newer release and offers to install it
import { api } from './lib/api';
import { $, make, ICON, project, typing, pressed } from './lib/dom';
import { command } from './lib/keys';
import { showTip } from './lib/help';
import { persist, restore, saveSoon } from './lib/store';
import { onReconnect } from './lib/connection';
import { apply, zoomAt, onChange, stage, view as camera } from './canvas/core/view';
import { fit } from './canvas/core/placement';
import { edgeGrip } from './canvas/core/drag';
import { rect, items } from './canvas/core/items';
import { redraw } from './canvas/graph/graph';
import { anyFull } from './canvas/core/fullview';
import './canvas/core/nav'; // pan, wheel, minimap, zoom buttons
import './canvas/ink/shapes'; // moving and resizing drawn shapes in Select mode
import { setDrawing, drawing } from './canvas/ink/ink';
import { setMode } from './canvas/core/mode';
import { selected } from './canvas/core/select'; // also Ctrl/Cmd+A, Delete, arrow-key nudges
import { addImage } from './items/image/image';
import { noteHere } from './items/notes';
import { docWindow } from './items/doc';
import './items/sketch'; // whiteboards you already have still load (new ones: the Scratchpad replaced it)
import './items/diagram';
import './items/plan/plan';
import './items/snippet/snippet';
import './items/image/image';
import './items/agent';
import './items/group/group'; // Ctrl+G groups the selected windows into a frame
import './items/preview/preview'; // Ctrl+K opens project files in windows
import { openFinder } from './canvas/core/find';
import { menuSection } from './canvas/core/menu'; // the right-click menu: a window's tab, the empty canvas
import './canvas/core/winkeys'; // W steps through windows, M collapses, Shift+F full view...
import './canvas/core/layers'; // bring forward / send back: the tab's right-click menu, the selection bar, ] / [
import { openGit } from './items/git/git';
import { openGitHub } from './items/github/github';
import { loadTree, closeInspector, showTab } from './panels/files';
import { cards, cur, newSession, meta, cycleCards } from './session/card/session';
import { attach } from './session/card/live';
import { refreshModels, seedInfo } from './session/card/gen';
import { loadSessions } from './session/card/history';
import { agentsReady, installed, lastAgent, setLastAgent, title, blurb, chooser } from './lib/agents';

const drawer = $('#drawer'),
  inspector = $('#inspector'),
  drawerBtn = $('#btn-drawer');
/** Open or close the drawer (files and History). */
const toggleDrawer = (open = drawer.hidden) => {
  drawer.hidden = !open;
  drawerBtn.setAttribute('aria-expanded', String(open));
};

$('#btn-new').onclick = () => newSession();

// Phones: the toolbar's tail folds into a ⋯ menu rather than scrolling off the edge. The wrapper is display:contents
// on wider screens (chrome.css), so the buttons sit in the bar as before.
const more = make('button', 'btn'),
  tail = make('div');
more.id = 'btn-more';
tail.id = 'bar-more';
more.innerHTML = ICON.more;
more.title = 'More';
more.setAttribute('aria-label', 'More');
more.setAttribute('aria-controls', 'bar-more');
/** Open or close the toolbar's overflow menu. */
const showMore = (open: boolean) => {
  tail.classList.toggle('open', open);
  more.setAttribute('aria-expanded', String(open));
};
showMore(false);
tail.append(...['#btn-scratch', '#btn-git', '#btn-drawer', '#btn-theme', '#btn-settings'].map(s => $(s)));
$('#bar').append(more, tail);
more.onclick = () => showMore(!tail.classList.contains('open'));
tail.addEventListener('click', () => showMore(false)); // picking one closes the menu
addEventListener('pointerdown', e => {
  if (!more.contains(e.target as Node) && !tail.contains(e.target as Node)) showMore(false);
});

/** New session ▾: which agent a new card runs. The button itself (and N) starts the last one picked; with only one
 *  agent installed there's nothing to pick, so no chevron. */
function newSessionMenu() {
  const list = installed(),
    btn = $('#btn-new');
  if (list.length < 2) return;
  /** Name the agent a new session starts with on the New button. */
  const label = () => {
    btn.title = `New ${title(lastAgent())} session (N)`;
    btn.setAttribute('aria-label', btn.title);
  };
  const menu = chooser(
    'Agent for a new session',
    list.map(a => ({ value: a.name, text: a.title, desc: blurb(a.name) })),
    lastAgent(),
    v => {
      setLastAgent(v);
      label();
      newSession({ backend: v });
    },
    true,
  );
  menu.classList.add('newagent');
  btn.after(menu);
  label();
}
$('#btn-scratch').onclick = () => docWindow({ edit: true });
$('#btn-git').onclick = () => openGit();
drawerBtn.onclick = () => toggleDrawer();
$('#dclose').onclick = () => toggleDrawer(false);
$('#iclose').onclick = closeInspector;
$('#refresh').onclick = () => {
  loadTree();
  loadSessions();
};
for (const b of document.querySelectorAll('.seg [data-l], .seg [data-r]')) pressed(b, b.classList.contains('on'));
for (const b of document.querySelectorAll<HTMLElement>('.seg [data-l]')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('.seg [data-l]')) pressed(o, o === b);
    $('#tree').hidden = b.dataset.l !== 'tree';
    $('#sessions').hidden = b.dataset.l !== 'sessions';
  };
}
for (const b of document.querySelectorAll<HTMLElement>('[data-r]'))
  b.onclick = () => showTab(b.dataset.r as 'changes' | 'viewer');

persist(
  'view',
  () => ({ ...camera }),
  v => {
    Object.assign(camera, v);
  },
  0,
);

// Inspector: drag its left edge to widen it.
edgeGrip(inspector, 360);

const PAN: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const ZOOM: Record<string, number> = { '+': 1.25, '=': 1.25, '-': 1 / 1.25 };
let lastDown: EventTarget | null = null;
/** Fit the view to the selection, or to everything when nothing is selected. */
const fitSelection = () => {
  const s = selected();
  fit(true, s.length ? s.map(rect) : undefined);
};
/** Outside Draw mode, whose keys these are (P/A/E/T and 7/5/0/8 pick its tools, canvas/ink/ink.ts). */
const notDrawing = () => !drawing;
for (const c of [
  {
    label: 'Pan (Shift: farther)',
    keys: Object.keys(PAN).map(k => `[Shift]+${k}`),
    // unless the last click was in a window (its arrows scroll it) or a window is in full view; select.ts nudging a
    // selection comes first
    when: (e: KeyboardEvent) =>
      !anyFull() && ![e.target, lastDown].some(t => t instanceof Element && t.closest('.item, dialog')),
    key: (e: KeyboardEvent) => {
      const pan = PAN[e.key],
        step = e.shiftKey ? 400 : 80;
      camera.x -= pan[0] * step;
      camera.y -= pan[1] * step;
      apply(!e.repeat); // a held key moves at once: a glide per repeat would lag behind
    },
    tip: 'Arrow keys pan the canvas; hold `Shift` to go farther',
  },
  {
    label: 'Zoom in / out',
    keys: ['[Shift]++', '=', '-'],
    // not on the number row: Shift+0 types "=" on some layouts, "-" is Digit6 on AZERTY
    when: (e: KeyboardEvent) => !anyFull() && !e.code.startsWith('Digit'),
    key: (e: KeyboardEvent) => zoomAt(camera.k * ZOOM[e.key], undefined, undefined, true),
  },
  // Excalidraw's keys where we have the tool; the number row by its physical key (Shift+1 types "!")
  {
    label: 'Fit everything',
    keys: ['f', 'Shift+Digit1'],
    run: () => fit(),
    key: (e: KeyboardEvent) => (e.shiftKey || !drawing ? void fit() : false),
    tip: '`F` fits everything on screen; `Shift+2` zooms to the selection',
  },
  { label: 'Zoom to selection', keys: ['Shift+Digit2'], run: fitSelection },
  { label: 'Zoom to 100%', keys: ['Shift+Digit0'], run: () => zoomAt(1, undefined, undefined, true) },
  { label: 'Select mode', keys: ['v', 'Digit1'], when: notDrawing, run: () => setMode('select') },
  {
    label: 'Hand mode (or hold Space)',
    keys: ['h'],
    when: notDrawing,
    run: () => setMode('hand'),
    tip: 'Hold `Space` and drag to pan from any mode',
  },
])
  command({ ...c, group: 'Canvas' });
for (const c of [
  { label: 'New session', keys: ['n'], run: () => newSession() },
  {
    label: 'Next / previous session',
    keys: ['c', 'Shift+c'],
    key: (e: KeyboardEvent) => cycleCards(e.shiftKey ? -1 : 1),
    tip: '`C` steps through your sessions; `Enter` starts typing in one',
  },
  {
    label: 'Type in the focused session',
    keys: ['Enter'],
    when: () => !!cur && document.activeElement === document.body,
    key: () => cur!.ta.focus(),
  },
  {
    label: 'Sticky note',
    keys: ['t'],
    when: notDrawing,
    run: noteHere,
    tip: '`T` drops a sticky note in the middle of the view',
  },
  {
    label: 'Scratchpad',
    keys: ['s'],
    when: notDrawing,
    run: () => docWindow({ edit: true }),
    tip: '`S` opens a scratchpad for Markdown, code and diagrams',
  },
  { label: 'Insert picture', keys: ['Digit9'], when: notDrawing, run: () => pickImage.click() },
  { label: 'Git', keys: ['g'], when: notDrawing, run: () => openGit(), tip: '`G` opens Git: changes, commit and push' },
  { label: 'GitHub', keys: ['Shift+g'], run: () => openGitHub() },
  {
    label: 'History & files',
    keys: ['Shift+h'],
    run: () => toggleDrawer(),
    tip: '`Shift+H` opens past sessions and the project files',
  },
])
  command({ ...c, group: 'Items' });
/** A toolbar button's icon, for the right-click menu's New and Open sections. */
// the right-click menu's New and Open sections (canvas/core/menu.ts), with the toolbar's own icons
const iconOf = (sel: string) => $(sel).querySelector('svg')?.outerHTML;
const NOTE = '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h11v7l-4 4h-7zM13.5 9.5h-4v4"/></svg>';
const PR =
  '<svg viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6M12 11V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6"/></svg>';
menuSection('New', () => [
  { label: 'Session', icon: ICON.plus, keys: 'N', run: () => newSession() },
  { label: 'Sticky note', icon: NOTE, keys: 'T', run: noteHere },
  { label: 'Scratchpad', icon: iconOf('#btn-scratch'), keys: 'S', run: () => docWindow({ edit: true }) },
]);
menuSection('Open', () => [
  { label: 'Git', icon: iconOf('#btn-git'), keys: 'G', run: () => openGit() },
  { label: 'GitHub', icon: PR, keys: 'Shift+G', run: () => openGitHub() },
  {
    label: symbolsOn() ? 'Search files & symbols' : 'Search files & windows',
    icon: iconOf('#btn-find'),
    keys: 'Ctrl+K',
    run: openFinder,
  },
]);
command({
  label: 'Draw mode',
  group: 'Draw',
  keys: ['d'],
  run: () => setDrawing(!drawing),
  tip: '`D` draws on the canvas; `A` draws an arrow between two items',
});
addEventListener(
  'pointerdown',
  e => {
    lastDown = e.target;
  },
  true,
);
/** Is this a key from a hardware keyboard (not an on-screen keyboard or an IME)? */
// a key pressed outside a field means a hardware keyboard (an iPad's, say): show the tools' key hints even on touch.
// On-screen keyboards and IMEs send 'Unidentified'/'Process' or composing events, which aren't one
const keyboard = (e: KeyboardEvent) => {
  if (e.isComposing || e.key === 'Unidentified' || e.key === 'Process') return;
  if (!typing(e.target)) {
    document.documentElement.dataset.keys = '';
    removeEventListener('keydown', keyboard, true);
  }
};
addEventListener('keydown', keyboard, true);
// Esc backs out one layer: this registers after everything else's Esc, so anything nearer (Draw mode, full view, the
// selection, Settings) takes it first, and a field, menu or dialog with focus before any of them
/** The open toolbar menu, side panel or drawer, nearest first, and how to close it. */
const closable = (): (() => void) | undefined =>
  tail.classList.contains('open')
    ? () => {
        showMore(false);
        more.focus();
      }
    : !inspector.hidden
      ? closeInspector
      : !drawer.hidden
        ? () => toggleDrawer(false)
        : undefined;
command({
  label: 'Close the menu or side panel',
  group: 'Canvas',
  keys: ['Escape'],
  when: () => !!closable(),
  key: () => closable()!(),
});
// 9: insert a picture from a file (like Excalidraw's image tool), in the middle of the view
const pickImage = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true });
pickImage.onchange = () => {
  for (const f of pickImage.files ?? []) addImage(f, f.name).catch(console.warn);
  pickImage.value = '';
};

// The hint teaches pan/zoom once, then gets out of the way.
const hint = $('#hint');
/** Hide the empty-canvas hint once you start using the canvas. */
const dismiss = () => hint.classList.add('gone');
stage.addEventListener('wheel', dismiss, { once: true });
stage.addEventListener(
  'pointerdown',
  e => {
    if (e.target === stage) dismiss();
  },
  { once: true },
);
setTimeout(dismiss, 12000);

/* ---------- boot ---------- */
project.root = (await api<{ root: string }>('info')).root;
project.name = project.root.split('/').pop() || project.root;
document.title = `${project.name} · Drawa`;
$('#pname').textContent = project.name;
$('#ppath').textContent = project.root;

// Models and skills / slash commands come from Claude itself (slow the first time: the server asks a fresh process).
api<typeof meta>('meta')
  .then(m => {
    Object.assign(meta, m);
    refreshModels(); // fills in every card's model picker, restored ones included
    for (const S of cards) seedInfo(S); // and every card's status line, if its own process hasn't reported yet
  })
  .catch(() => {});

await agentsReady; // which agents there are: cards restore with theirs, and the New session menu lists them
newSessionMenu();
await restore();
apply();
if (!cards.length) newSession({ here: items().length > 0 }); // a canvas with windows on it: stay where you were looking
document.fonts.ready.then(redraw); // card text reflow can shift edge anchors
onChange(saveSoon);
// server back after an outage (or a restart): pick the live streams and lists up again
onReconnect(() => {
  for (const S of cards) attach(S);
  loadTree();
  loadSessions();
});
loadTree();
loadSessions();
cur?.ta.focus({ preventScroll: true });
showTip();
