// Files search: the drawer's Files pane lists project files by name, then code symbols (when ctags is on), while its
// search box holds a query. The same server searches as Ctrl+K's; picking one opens it as the tree does.

import { centerOn } from '../canvas/core/placement';
import { pinFile } from '../canvas/graph/sessionwins';
import { api, q } from '../lib/api';
import { $, make } from '../lib/dom';
import { type CodeSymbol, findSymbols, symbolsOn } from '../lib/symbols';
import { openInspector } from './files';

const SEARCH_DELAY_MS = 120; // as Ctrl+K: ask once typing pauses
const MAX_FILES = 40;

const findBox = $('#filefind') as HTMLInputElement,
  hits = $('#filehits'),
  tree = $('#tree');
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let asked = ''; // the query the newest search was for: an answer to an older one is dropped

/** Open a file in its window on the canvas and in the inspector, at `line` if given. */
function open(path: string, line?: number) {
  centerOn(pinFile(path));
  openInspector(path, 'viewer', undefined, line);
}

/** A result row: its name, where it is, and for a symbol its kind. */
function hitRow(name: string, where: string, run: () => void, tag?: string) {
  const row = make('button');
  row.append(make('span', 'name', name));
  if (tag) row.append(make('span', 'tag', tag));
  row.append(make('span', 'where', where));
  row.title = where;
  row.onclick = run;
  return row;
}

/** A project file: its name, with its folder beside it. */
function fileRow(path: string) {
  const cut = path.lastIndexOf('/');
  return hitRow(path.slice(cut + 1), path.slice(0, cut + 1), () => open(path));
}

/** A code symbol: its name and kind, with the file and line it's defined at. */
function symbolRow(symbol: CodeSymbol) {
  return hitRow(symbol.name, `${symbol.path}:${symbol.line}`, () => open(symbol.path, symbol.line), symbol.kind);
}

/** Search files (and symbols) for the box's query; an empty box shows the tree again. */
async function search() {
  const query = findBox.value.trim();
  asked = query;
  hits.hidden = !query;
  tree.hidden = !!query;
  if (!query) return;
  const [files, symbols] = await Promise.all([
    api<string[]>(`files?q=${q(query)}`).catch(() => [] as string[]),
    findSymbols(query),
  ]);
  if (query !== asked) return;
  const rows: HTMLElement[] = files.slice(0, MAX_FILES).map(fileRow);
  if (symbols.length) rows.push(make('h3', '', 'Symbols'), ...symbols.map(symbolRow));
  if (rows.length) return hits.replaceChildren(...rows);
  hits.replaceChildren(make('p', 'none', symbolsOn() ? 'No file or symbol matches.' : 'No file matches.'));
}

/** Word the search box for what it can find: symbols only when ctags is on. */
export function wordFileFind() {
  findBox.placeholder = symbolsOn() ? 'Search files by name, or symbols' : 'Search files by name';
  findBox.setAttribute('aria-label', findBox.placeholder);
}

findBox.oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, SEARCH_DELAY_MS);
};
findBox.onkeydown = async event => {
  if (event.key === 'Enter') {
    if (!findBox.value.trim()) return;
    clearTimeout(searchTimer);
    await search(); // what was typed may not have been searched yet
    hits.querySelector('button')?.click();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    hits.querySelector('button')?.focus();
    return;
  }
  if (event.key !== 'Escape') return;
  if (!findBox.value) return findBox.blur(); // the next Escape closes the drawer
  findBox.value = '';
  search();
};
// arrow keys step through the results, back up to the box from the first
hits.onkeydown = event => {
  const row = event.target as HTMLElement;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const rows = [...hits.querySelectorAll('button')],
    next = rows.indexOf(row as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : -1);
  (next < 0 ? findBox : rows[Math.min(next, rows.length - 1)]).focus();
};
