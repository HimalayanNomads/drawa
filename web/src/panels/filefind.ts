// Files search: the drawer's Files pane lists project files by name, then code symbols (when ctags is on), while its
// search box holds a query. The same server searches as Ctrl+K's; picking one opens it as the tree does.

import { centerOn } from '../canvas/core/placement';
import { pinFile } from '../canvas/graph/sessionwins';
import { matchingFiles, splitPath } from '../lib/api';
import { $, make } from '../lib/dom';
import { searchBox } from '../lib/searchbox';
import { type CodeSymbol, findSymbols, symbolsOn } from '../lib/symbols';
import { loadTree, openInspector } from './files';

const SEARCH_DELAY_MS = 120; // as Ctrl+K: ask once typing pauses
const MAX_FILES = 40;

const findBox = $('#filefind') as HTMLInputElement,
  hits = $('#filehits'),
  tree = $('#tree');
let asked = ''; // the query the newest search was for: an answer to an older one is dropped

/** Open a file as the tree does: its window on the canvas and the inspector, at `line` if given. */
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
  const { name, folder } = splitPath(path);
  return hitRow(name, folder, () => open(path));
}

/** A code symbol: its name and kind, with the file and line it's defined at. */
function symbolRow(symbol: CodeSymbol) {
  return hitRow(symbol.name, `${symbol.path}:${symbol.line}`, () => open(symbol.path, symbol.line), symbol.kind);
}

/** Search files (and symbols) for the box's query; an empty box shows the tree again. False when a newer search
 *  took over. */
async function search() {
  const query = findBox.value.trim();
  asked = query;
  hits.hidden = !query;
  tree.hidden = !!query;
  if (!query) return true;
  const [files, symbols] = await Promise.all([matchingFiles(query), findSymbols(query)]);
  if (query !== asked) return false;
  const rows: HTMLElement[] = files.slice(0, MAX_FILES).map(fileRow);
  if (symbols.length) rows.push(make('h3', '', 'Symbols'), ...symbols.map(symbolRow));
  if (rows.length) hits.replaceChildren(...rows);
  else hits.replaceChildren(make('p', 'none', symbolsOn() ? 'No file or symbol matches.' : 'No file matches.'));
  return true;
}

/** Word the search box for what it can find: symbols only when ctags is on. */
export function wordFileFind() {
  findBox.placeholder = symbolsOn() ? 'Search files by name, or symbols' : 'Search files by name';
  findBox.setAttribute('aria-label', findBox.placeholder);
}

const searchNow = searchBox(findBox, { delayMs: SEARCH_DELAY_MS, search, results: hits });

/** Reload the Files pane: the tree, and the results too while the box holds a query (files come and go). */
export const reloadFiles = () => Promise.all([loadTree(), findBox.value.trim() ? searchNow() : undefined]);
