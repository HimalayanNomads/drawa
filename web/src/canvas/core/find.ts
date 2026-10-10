// Find a window: Ctrl/Cmd+K (or the toolbar's search button) lists everything on the canvas; type to filter by
// title and content, Enter flies to it, brings it to the front and expands it if it was collapsed. Project files and
// then code symbols (lib/symbols.ts) matching the query are listed below the windows, the highlighted one previewed
// beside the list; picking one opens its file in a window (see fileOpener), at the symbol's line. Commands
// (lib/keys.ts entries with `run`) matching the query are listed above.
import { api, q as enc } from '../../lib/api';
import { $, make, ping, reducedMotion, revealIn } from '../../lib/dom';
import { command, commands, keysOf } from '../../lib/keys';
import { enhanceMarked } from '../../lib/markdown';
import { persist } from '../../lib/store';
import { type CodeSymbol, findSymbols, symbolsOn } from '../../lib/symbols';
import { floatAt } from './dock';
import { bringToFront, hidden, items, onCanvas } from './items';
import { centerOn } from './placement';
import { kindName, refIcon, refStatus } from './refs';
import { expand, focusInput, removeQuietly, titleOf } from './window';

const box = document.body.appendChild(make('div', 'finder'));
box.hidden = true;
box.setAttribute('role', 'dialog');
box.setAttribute('aria-label', 'Find a window, file or command');
const input = box.appendChild(make('input'));
input.setAttribute('aria-label', 'Find a window, file or command');
const body = box.appendChild(make('div', 'finder-b'));
const list = body.appendChild(make('div', 'finder-list'));
list.setAttribute('role', 'listbox');
const peekBox = body.appendChild(make('div', 'finder-peek'));
peekBox.onmousedown = e => e.preventDefault(); // keeps focus in the input, whose blur closes the finder (wheel scrolling still works)

const TEXT = 40_000;
/** What a window's content search covers: a chat log's newest ~40k characters (read row by row from the end, so a
 *  huge transcript isn't turned into one string), other windows' first 40k. */
function textOf(el: HTMLElement) {
  const log = el.querySelector('.log');
  if (!log) return (el.querySelector('.win-b, .ntext')?.textContent ?? el.textContent ?? '').slice(0, TEXT);
  const parts: string[] = [];
  let n = 0;
  for (let r = log.lastElementChild; r && n < TEXT; r = r.previousElementSibling) {
    const t = r.textContent ?? '';
    parts.push(t);
    n += t.length;
  }
  return parts.reverse().join('\n').slice(-TEXT);
}

// `line` and `tag` (ctags' kind of definition): a code symbol
interface Hit {
  el?: HTMLElement;
  path?: string;
  line?: number;
  tag?: string;
  run?: () => void;
  key?: string;
  title: string;
  kind: string;
  excerpt: string;
  score: number;
}
interface Entry {
  el: HTMLElement;
  title: string;
  t: string;
  kind: string;
  body: string;
  b: string;
}
let hits: Hit[] = [],
  sel = 0,
  index: Entry[] = [];
/** Read every window's title and text once, when the finder opens: typing then only filters this. */
function build() {
  // most recently brought to the front first: that's the order you used them in
  index = items()
    .filter(el => !hidden(el))
    .sort(
      // a collapsed group's windows: find the group instead
      (a, b) => (Number(b.style.zIndex) || 0) - (Number(a.style.zIndex) || 0),
    )
    .map(el => {
      const title = titleOf(el) || kindName(el.dataset.kind ?? ''),
        body = textOf(el);
      return { el, title, t: title.toLowerCase(), kind: el.dataset.kind ?? '', body, b: body.toLowerCase() };
    });
}

let openFile: ((path: string, line?: number, edit?: boolean) => HTMLElement) | null = null,
  peekFile: ((path: string, line?: number) => Promise<HTMLElement>) | null = null;
/** List project files and code symbols too: picking one calls `open`, which returns its file's window (an open one,
 *  or a new one) showing `line` when given; the highlighted one is shown beside the list with what `peek` draws. */
export const fileOpener = (open: typeof openFile, peek: typeof peekFile) => {
  openFile = open;
  peekFile = peek;
};

// the highlighted file's preview, kept while the finder is open so going back to a file is instant.
// ponytail: kept unbounded until close (a few hundred files at most per open); an LRU if that grows.
let peeked = '';
const peeks = new Map<string, Promise<HTMLElement>>();
/** A file's preview element for Ctrl+K, made once per file and line and kept for the session. */
const peekOf = (path: string, line?: number) => {
  const key = line ? `${path}:${line}` : path;
  let v = peeks.get(key);
  if (!v) peeks.set(key, (v = peekFile!(path, line)));
  return v;
};
/** Show the highlighted file's preview beside the list (wide while searching). */
function peekSelected() {
  box.classList.toggle('peeking', !!peekFile && !!input.value.trim()); // wide while searching, so neither the highlight nor typing resizes it
  const h = hits[sel],
    path = h?.path ?? '',
    key = h?.line ? `${path}:${h.line}` : path;
  if (key === peeked) return;
  peeked = key;
  if (!path || !peekFile) return void peekBox.replaceChildren();
  // the last preview stays until this one is drawn: no blank flash between files
  peekOf(path, h.line)
    .then(v => {
      if (peeked === key && !box.hidden) {
        peekBox.replaceChildren(v);
        enhanceMarked(peekBox);
        revealIn(peekBox);
      }
    })
    .catch(() => {});
}

// files and symbols matching the query: the server's fuzzy searches (files: the same as @ in a message), asked once
// typing pauses. `pending`: how many of this query's answers are still to come; `pickFirst` when Enter came meanwhile
// with nothing to pick
let found: Hit[] = [],
  syms: Hit[] = [],
  fileQ = '',
  typing = 0,
  pending = 0,
  pickFirst = false;
/** Ask the server for files (and code symbols, when ctags is on) matching what's typed; results come in as they
 *  answer. */
function findFiles() {
  clearTimeout(typing);
  const q = (fileQ = input.value.trim());
  found = [];
  syms = []; // the last query's aren't this one's: none are pickable until the answers come
  const withSyms = symbolsOn();
  pending = q && openFile ? (withSyms ? 2 : 1) : 0;
  if (!pending) return;
  /** Take one answer in, unless the query changed or the finder closed meanwhile; picks the first hit when Enter was
   *  pressed early. */
  const answer = (set: (got: Hit[]) => void, got: Hit[]) => {
    if (fileQ !== q || box.hidden) return;
    set(got);
    pending--;
    drawHits();
    if (pickFirst && !pending) {
      pickFirst = false;
      if (hits[0]) pickHit(hits[0]);
      return;
    }
    if (peekFile) got.slice(0, 3).forEach(h => peekOf(h.path!, h.line));
  };
  typing = setTimeout(() => {
    api<string[]>(`files?q=${enc(q)}`).then(
      l => answer(h => (found = h), l.map(fileHit)),
      () => answer(h => (found = h), []),
    );
    if (withSyms) findSymbols(q).then(l => answer(h => (syms = h), l.map(symHit)));
  }, 120);
}
/** A project file as a Ctrl+K hit: its name, with its folder as the excerpt. */
const fileHit = (path: string): Hit => {
  const cut = path.lastIndexOf('/');
  return { path, title: path.slice(cut + 1), kind: 'preview', excerpt: path.slice(0, cut + 1), score: 0 };
};
/** A code symbol as a Ctrl+K hit: its name, kind and where it's defined. */
const symHit = (s: CodeSymbol): Hit => ({
  path: s.path,
  line: s.line,
  tag: s.kind,
  title: s.name,
  kind: 'preview',
  excerpt: `${s.path}:${s.line}${s.scope ? ` · ${s.scope}` : ''}`,
  score: 0,
});

/** Commands whose label has every word of the query; none while the query is empty (that lists the windows). */
function findCommands(q: string): Hit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return commands()
    .filter(c => c.run && words.every(w => c.label.toLowerCase().includes(w)))
    .map(c => ({
      run: c.run,
      key: c.keys?.[0] && keysOf(c.keys[0]).join('+'),
      title: c.label,
      kind: '',
      excerpt: '',
      score: 0,
    }));
}
/** The section heading a hit belongs under: Commands, Symbols, Files or Windows. */
const sectionOf = (h?: Hit) => (!h ? '' : h.run ? 'Commands' : h.line ? 'Symbols' : h.path ? 'Files' : 'Windows');

/** The windows whose title or text has every word typed, best match first (titles count more). */
function search(q: string): Hit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out: Hit[] = [];
  for (const { el, title, t, kind, body, b } of index) {
    if (!el.isConnected) continue;
    if (!words.length) {
      out.push({ el, title, kind, excerpt: '', score: 0 });
      continue;
    }
    // every word must match somewhere: the title counts most, then the kind, then the content
    let score = 0,
      inBody = -1;
    for (const w of words) {
      if (t.includes(w)) score += 10;
      else if (kindName(kind).startsWith(w)) score += 4;
      else if (b.includes(w)) {
        score += 1;
        if (inBody < 0) inBody = b.indexOf(w);
      } else {
        score = -1;
        break;
      }
    }
    if (score < 0) continue;
    // a content match shows where it was found, as the result's second line
    const excerpt =
      inBody >= 0
        ? '…' +
          body
            .slice(Math.max(0, inBody - 30), inBody + 60)
            .replace(/\s+/g, ' ')
            .trim() +
          '…'
        : '';
    out.push({ el, title, kind, excerpt, score });
  }
  return words.length ? out.sort((a, b) => b.score - a.score) : out;
}

/** Draw the hit list: commands, windows, files, then symbols, with section headings. */
function drawHits() {
  hits = [...findCommands(input.value), ...search(input.value).slice(0, 50), ...found, ...syms];
  sel = Math.min(sel, Math.max(0, hits.length - 1));
  list.replaceChildren(
    ...(hits.length
      ? hits.flatMap((h, i) => {
          const row = make('button', `finder-row${i === sel ? ' on' : ''}`);
          row.id = `finder-${i}`;
          row.tabIndex = -1; // Tab in the input moves the highlight instead (focus leaving the input would close the finder)
          row.setAttribute('role', 'option');
          row.setAttribute('aria-selected', String(i === sel));
          row.dataset.kind = h.kind;
          const status = h.el && refStatus(h.el);
          if (status) row.dataset.state = h.el!.dataset.state;
          const main = make('span', 'fr-main');
          main.append(make('b', '', h.title || '(untitled)'), ...(h.excerpt ? [make('small', '', h.excerpt)] : []));
          row.append(
            make('i', 'fr-g', h.run ? '›' : refIcon(h.kind)),
            main,
            make('span', 'fr-k', h.run ? (h.key ?? '') : (h.tag ?? (status || kindName(h.kind)))),
          );
          row.onmousedown = e => {
            e.preventDefault();
            pickHit(h);
          };
          // mousemove, not mouseenter: a redraw puts a new row under a resting pointer, which would take the highlight back from the arrow keys
          row.onmousemove = () => {
            if (sel === i) return;
            const was = list.querySelector('.on');
            was?.classList.remove('on');
            was?.setAttribute('aria-selected', 'false');
            row.classList.add('on');
            row.setAttribute('aria-selected', 'true');
            input.setAttribute('aria-activedescendant', row.id);
            sel = i;
            peekSelected();
          };
          // a header where a section starts: commands, then windows (unnamed when first), then files, then symbols
          const sec = sectionOf(h);
          if (sec === sectionOf(hits[i - 1]) || (sec === 'Windows' && !i)) return [row];
          const head = make('p', 'finder-sec', sec);
          head.setAttribute('role', 'presentation');
          return [head, row];
        })
      : [make('p', 'none', pending ? 'Searching files…' : 'Nothing matches.')]),
  );
  if (hits.length) input.setAttribute('aria-activedescendant', `finder-${sel}`);
  else input.removeAttribute('aria-activedescendant');
  list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  peekSelected();
}

/** Act on a hit: run a command, or bring its window into view (opening a file or symbol first). */
const pickHit = (h: Hit) => {
  if (h.run) {
    closeFinder(false);
    h.run();
    return;
  }
  const el = h.el ?? openFile?.(h.path!, h.line);
  if (el) go(el);
};

/** Open a project file in its window at `line` and fly to it (a diff's go to definition); `edit`: in its editor (the
 *  inspector's Edit). False when files can't be opened. */
export function openFileAt(path: string, line?: number, edit = false) {
  const el = openFile?.(path, line, edit);
  if (el) go(el);
  return !!el;
}

let peekWin: HTMLElement | null = null; // the small window stickFileAt made last: the next pick takes its place
// still the peek after a reload, so a later pick replaces it rather than leaving one more behind; phase 2: after windows
persist(
  'refpeek',
  () => (peekWin?.isConnected ? (peekWin.dataset.id ?? null) : null),
  (id: string | null) => {
    peekWin = id ? (items().find(el => el.dataset.id === id) ?? null) : null;
  },
  2,
);
/** Open a project file at `line` in a small window stuck to the screen at (x, y), without moving the canvas (a
 *  diff's find references: you step through them with the list still open). One such window is reused from pick to
 *  pick. A window the file already has stays where you put it: it's brought into view at the line instead. */
export function stickFileAt(path: string, line: number, x: number, y: number) {
  const had = new Set(items()),
    el = openFile?.(path, line);
  if (!el) return false;
  // still the peek: not docked or put on the canvas since, and not holding an edit you haven't finished
  const ours =
    peekWin?.isConnected && peekWin.classList.contains('floating') && peekWin.dataset.state !== 'editing'
      ? peekWin
      : null;
  expand(el);
  if (had.has(el) && el !== ours) {
    // the user's own window
    if (onCanvas(el)) {
      bringToFront(el);
      centerOn(el);
    } else el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    setTimeout(() => ping(el), 300);
    return true;
  }
  if (ours && ours !== el) removeQuietly(ours); // only now: a pick that goes to your own window keeps the peek
  if (el !== ours) {
    el.style.width = '380px';
    el.style.height = '260px';
  }
  peekWin = el;
  floatAt(el, x, y);
  return true;
}

/** Fly to a window: expand it if collapsed, bring it forward, and put the cursor in it when it takes typing. */
function go(el: HTMLElement) {
  closeFinder(false);
  expand(el);
  if (!onCanvas(el))
    el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); // pinned (or in full view): already on screen
  else {
    bringToFront(el);
    centerOn(el);
  }
  setTimeout(() => ping(el), 300); // after the glide
  focusInput(el);
}

let from: HTMLElement | null = null; // where focus was before the finder opened: it goes back there unless something is picked
/** Open Ctrl+K: an empty query lists every window and command. */
export function openFinder() {
  if (box.hidden) from = document.activeElement as HTMLElement | null;
  box.hidden = false;
  input.value = '';
  input.placeholder = symbolsOn() ? 'Find a window, file, symbol or command' : 'Find a window, file or command';
  sel = 0;
  build();
  drawHits();
  input.focus();
}
/** Close Ctrl+K; `restore` hands focus back to where it was. */
function closeFinder(restore = true) {
  const back = from;
  from = null; // first: hiding the focused input blurs it, which calls close again
  box.hidden = true;
  index = [];
  found = [];
  syms = [];
  pending = 0;
  pickFirst = false;
  peeked = '';
  peeks.clear();
  clearTimeout(typing);
  peekBox.replaceChildren(); // don't hold on to big texts
  if (restore && back?.isConnected) back.focus({ preventScroll: true });
}

input.addEventListener('input', () => {
  sel = 0;
  pickFirst = false;
  findFiles();
  drawHits();
});
input.addEventListener('keydown', e => {
  e.stopPropagation(); // typing here isn't a canvas shortcut
  const down = e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey),
    up = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey);
  if (down || up) {
    e.preventDefault();
    sel = (sel + (down ? 1 : hits.length - 1)) % Math.max(1, hits.length);
    drawHits();
  } else if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (hits[sel]) pickHit(hits[sel]);
    else if (pending) pickFirst = true;
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFinder();
  }
});
// rows keep focus in the input (mousedown is prevented), so this is a real blur; focus that went somewhere stays there
input.onblur = e => closeFinder(!e.relatedTarget);
$('#btn-find').onclick = () => openFinder();
// from anywhere, even while typing in a card; not while a modal (or the whiteboard editor, whose own Ctrl+K it is) has
// the keyboard
command({
  label: 'Find a window, file or command',
  group: 'Items',
  keys: ['$mod+k'],
  anywhere: true,
  when: () => !document.querySelector('dialog[open]'),
  key: () => (box.hidden ? openFinder() : closeFinder()),
  tip: '`Ctrl+K` finds windows and files, and runs commands by name',
});
