// File previews: a project file in a window, opened from Ctrl+K. Code is highlighted, Markdown rendered, pictures
// shown. Only the path is saved: the file is read from disk when the window opens (again after a reload, or with
// the reload button), so it shows the file as it is without filling localStorage. One window per file; opened at a
// line (a code symbol), it marks that line until the page reloads.

import { fileOpener } from '../../canvas/core/find';
import { isFull, toggleFull } from '../../canvas/core/fullview';
import { items, type Rect, savedRect } from '../../canvas/core/items';
import { freeSpot } from '../../canvas/core/placement';
import { referable } from '../../canvas/core/refs';
import { changed, viewCenter } from '../../canvas/core/view';
import { makeWindow, removeButton, winTitle } from '../../canvas/core/window';
import { inkBox } from '../../canvas/ink/stroke';
import { api, q } from '../../lib/api';
import { base64 } from '../../lib/blobs';
import { ICON, iconButton, make, revealIn, spinWhile } from '../../lib/dom';
import { enhanceMarked } from '../../lib/markdown';
import { each, persist } from '../../lib/store';
import { isMarkdown, mdView, sourceView } from '../../panels/files';
import { editAt, editFocus, editing, editorText, toggleEdit } from './fileedit';

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i; // what /api/raw serves
const HTML = /\.html?$/i;
interface Saved {
  path: string;
  title: string;
  rect: Rect;
}

// before any window: the tab's glyph is this icon. Claude gets the path and reads the file itself, so a big file
// isn't pasted into the message and it sees the file as it is when it reads it.
referable('preview', {
  icon: '◫',
  name: 'file',
  label: el => el.dataset.path ?? '',
  copy: el => editorText(el) ?? texts.get(el.dataset.path ?? '') ?? '', // while editing: what's in the editor
  content: el => ({ text: `File: ${el.dataset.path} (read it if you need its contents)` }),
});

/** A text file as shown: Markdown rendered, anything else as code. `lines`: only that many (Ctrl+K's preview), from
 *  the start or from a little above `at`, a line to mark (shown as source then, even for Markdown). */
const texts = new Map<string, string>(); // each open file's text as last read, for its copy button
/** A text file's view: highlighted code or rendered Markdown, all of it or the lines around `at`. */
async function textView(path: string, lines?: number, at?: number) {
  try {
    let { text } = await api<{ text: string | null }>(`file?path=${q(path)}`),
      first = 1;
    if (text != null && !lines) texts.set(path, text);
    if (text != null && lines) {
      first = Math.max(1, (at ?? 1) - 20);
      text = text
        .split('\n', first - 1 + lines)
        .slice(first - 1)
        .join('\n');
    }
    if (text != null && !at && !lines && HTML.test(path)) return await htmlView(path, text); // Ctrl+K's peek: source
    return text != null && isMarkdown(path) && !at ? mdView(path, text) : await sourceView(path, text, { first, at });
  } catch (e) {
    return make('p', 'none', (e as Error).message);
  }
}

/** An HTML file as a browser shows it, in a frame sandboxed to an opaque origin: its scripts run but can't reach this
 *  page, its storage or the API (which refuses their cross-site requests). So the frame can't fetch the file's
 *  neighbours either: relative stylesheets, scripts and pictures are read here and inlined. Only those kinds, and only
 *  from the page's own folder and below, since the frame can still reach the network: a page from a clone or
 *  node_modules can't pull in `.env` or the project's other files and send them out.
 *  ponytail: url() inside CSS, fetch() and ES module imports from the page stay unresolved; serving the folder from
 *  a per-process token path (like /mcp/) is the upgrade if pages need them. */
async function htmlView(path: string, text: string) {
  const doc = new DOMParser().parseFromString(text, 'text/html'),
    folder = path.slice(0, path.lastIndexOf('/') + 1),
    dir = `http://p/${folder}`;
  /** A relative reference as a project path in the page's folder or below, when it has the extension wanted. */
  const local = (s: string | null, ext: RegExp) => {
    try {
      const u = s ? new URL(s, dir) : null,
        p = u?.origin === 'http://p' ? decodeURIComponent(u.pathname.slice(1)) : '';
      return p.startsWith(folder) && ext.test(p) ? p : ''; // the URL parser already folded away any ../
    } catch {
      return ''; // a stray % in the path: left as written
    }
  };
  const read = (p: string) =>
    api<{ text: string | null }>(`file?path=${q(p)}`).then(
      r => r.text,
      () => null,
    );
  const inline = (sel: string, attr: string, ext: RegExp, put: (el: Element, p: string) => Promise<void>) =>
    [...doc.querySelectorAll(sel)].map(el => {
      const p = local(el.getAttribute(attr), ext);
      return p ? put(el, p).catch(() => {}) : undefined;
    });
  await Promise.all([
    ...inline('link[rel~=stylesheet][href]', 'href', /\.css$/i, async (el, p) => {
      const css = await read(p);
      if (css != null) el.replaceWith(Object.assign(doc.createElement('style'), { textContent: css }));
    }),
    ...inline('script[src]', 'src', /\.m?js$/i, async (el, p) => {
      const js = await read(p); // still a src, as a data: URL: defer, async and type=module keep working
      if (js != null) el.setAttribute('src', `data:text/javascript;base64,${await base64(new Blob([js]))}`);
    }),
    ...inline('img[src]', 'src', IMAGE, async (el, p) => {
      const r = await fetch(`/api/raw?path=${q(p)}`);
      if (r.ok) el.setAttribute('src', `data:${r.headers.get('content-type')};base64,${await base64(await r.blob())}`);
    }),
  ]);
  const frame = make('iframe', 'pvnode-html');
  frame.sandbox.add('allow-scripts'); // no allow-same-origin: that would hand it this page
  frame.title = path;
  frame.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
  return frame;
}

/** Show `node` in the ink host, keeping the ink layer drawn on it. Markdown built off-page is finished here. */
function fill(host: HTMLElement, node: Node) {
  for (const c of [...host.children]) if (!c.matches('svg.ink-local')) c.remove();
  host.prepend(node);
  enhanceMarked(host);
}

/** The picture, drawn in its ink host. `again`: the reload button, so it skips the copy the page already has. */
function picture(el: HTMLElement, host: HTMLElement, again: boolean) {
  const img = make('img', 'inode-img');
  img.alt = winTitle(el);
  img.onload = () => inkBox(host.dataset.ink!, host, img.naturalWidth, img.naturalHeight);
  img.onclick = () => {
    if (!isFull(el)) toggleFull(el);
  }; // as a picture window: full view, where it zooms and pans
  img.onerror = () => {
    if (img.isConnected) fill(host, make('p', 'none', "This picture can't be read: moved, deleted, or over 20 MB."));
  };
  img.src = `/api/raw?path=${q(el.dataset.path!)}${again ? `&v=${Date.now()}` : ''}`;
  return img;
}

/** The file's line under `y` in a code view, from its height and line count (one layout read, on a double-click). */
function lineAt(host: HTMLElement, y: number) {
  const code = host.querySelector('.src code'),
    n = host.querySelector('.src .ln')?.textContent?.split('\n').length;
  if (!code || !n) return 0; // rendered Markdown: no line to map to, the editor starts at the top
  const r = code.getBoundingClientRect();
  return Math.min(n, Math.max(1, Math.floor((y - r.top) / (r.height / n)) + 1));
}

const toLine = new WeakMap<HTMLElement, (line: number) => void>(),
  toEdit = new WeakMap<HTMLElement, () => Promise<void>>();

/** A project file in a window (opened from Ctrl+K): code, Markdown or a picture, editable in place. */
export function preview(o: { path: string; title?: string; rect: Rect; line?: number }) {
  const key = `pv:${o.path}`,
    image = IMAGE.test(o.path);
  /** Start or stop editing the file. */
  const edit = () => toggleEdit(el, host, o.path, pencil, () => load());
  const pencil = iconButton(ICON.pencil, 'Edit the file', edit);
  const reloadButton = iconButton(
    ICON.reload,
    'Read the file again',
    () => spinWhile(reloadButton, load(true)),
    'pv-reload',
  );
  const { el, body } = makeWindow({
    kind: 'preview',
    cls: 'pvnode',
    title: o.title || o.path.split('/').pop()!,
    rect: o.rect,
    minW: 200,
    minH: 120,
    actions: [...(image ? [] : [pencil]), reloadButton, removeButton('Remove from canvas')],
  });
  el.dataset.id = `preview:${o.path}`; // the same after a reload: arrows and canvas tools find it by this
  el.dataset.path = o.path;
  // the ink host is made once, here: strokes stay on it through the reload button, and restoring ink (phase 2)
  // finds it before the file is read. A picture's keeps its spot at any size; text's scrolls with the text.
  const host = image ? inkBox(key) : make('div', 'pvnode-s');
  host.dataset.ink = key;
  if (image) body.classList.add('inode-b');
  host.append(make('p', 'none', 'Reading…'));
  body.append(host);
  // double-click the text to edit it, as in a Markdown window, with the cursor on the line clicked
  if (!image)
    host.addEventListener('dblclick', async e => {
      if (editing(el) || (e.target as Element).closest('a, button, .mermaid')) return;
      const line = lineAt(host, e.clientY);
      await edit();
      if (line && editing(el)) editAt(el, line);
    });
  let loads = 0,
    at = o.line; // only the newest read is shown, when the reload button is pressed while one is still coming
  /** Read the file and show it, unless it's being edited (or the pencil was pressed while it was read). */
  const load = async (again = false) => {
    if (editing(el)) return; // the editor holds the file until you stop editing
    const n = ++loads,
      view = image ? picture(el, host, again) : await textView(o.path, undefined, at);
    if (n !== loads || editing(el)) return; // the pencil was pressed while this read was on its way
    fill(host, view);
    revealIn(host);
  };
  load();
  toLine.set(el, line => {
    at = line;
    if (editing(el)) editAt(el, line);
    else load();
  }); // read again: the line is where it is in the file now
  toEdit.set(el, async () => {
    if (editing(el)) editFocus(el);
    else await edit();
  });
  return el;
}

fileOpener(
  (path, line, edit) => {
    let el = items('preview').find(el => el.dataset.path === path); // a file already open is flown to rather than opened twice
    if (el) {
      if (line) toLine.get(el)?.(line);
    } else {
      const c = viewCenter();
      el = preview({ path, line, rect: freeSpot({ x: c.x - 260, y: c.y - 200, w: 520, h: 400 }) });
      changed();
    }
    if (edit) {
      const w = el;
      toEdit
        .get(w)?.()
        .then(() => {
          if (line) editAt(w, line);
        });
    }
    return el;
  },
  async (path, line) =>
    IMAGE.test(path)
      ? Object.assign(make('img', 'finder-img'), { src: `/api/raw?path=${q(path)}`, alt: '' })
      : textView(path, 200, line),
);

persist(
  'previews',
  () => items('preview').map((el): Saved => ({ path: el.dataset.path!, title: winTitle(el), rect: savedRect(el) })),
  (list: Saved[]) => each(list, preview),
);
