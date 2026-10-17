// Text files dropped or pasted into a message box (Markdown, code, JSON, logs…): read in the browser and sent to
// Claude as the file's contents, shown as a chip like any other reference. Images go through images.ts instead.
// ponytail: binary files (PDF, office, archives) aren't sent; that needs an upload the CLI can Read (server side).

import type { Ref } from '../../canvas/core/refs';
import { referable } from '../../canvas/core/refs';
import { make, toast } from '../../lib/dom';
import { raster } from './filetypes';

// it all goes into one message: 200KB of text is ~50k tokens, and a few of those fill a context window
const MAX = 200_000,
  TOTAL = 500_000;
const texts = new WeakMap<HTMLElement, string>();

referable('upload', {
  icon: '▤',
  label: el => el.dataset.label ?? 'file',
  content: el => {
    const name = el.dataset.label ?? 'file',
      lang = /\.([\w]+)$/.exec(name)?.[1] ?? '';
    return { text: `Attached file "${name}":\n\`\`\`\`${lang}\n${texts.get(el) ?? ''}\n\`\`\`\`` };
  },
});

/** Is it text? Its type says so, or its first 4KB decode as UTF-8 with no NUL bytes (most code and config files
 *  have no type, or a wrong one). `stream`: a character cut off at the 4KB edge isn't an error. */
async function isText(f: File) {
  if (f.type.startsWith('text/') || /json|xml|yaml|javascript|typescript|markdown|sql|x-sh/.test(f.type)) return true;
  const head = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Read the text files among `files` into references for the next message; say why the others were skipped. */
export async function textRefs(files: File[]): Promise<Ref[]> {
  const out: Ref[] = [],
    skipped: string[] = [];
  let total = 0;
  for (const file of files) {
    // a bitmap only reaches textRefs after failing to decode; blaming size or text would be misleading
    if (raster(file)) {
      skipped.push(`${file.name} (could not be read as an image)`);
      continue;
    }
    if (file.size > MAX) {
      skipped.push(`${file.name} (over 200KB)`);
      continue;
    }
    if (total + file.size > TOTAL) {
      skipped.push(`${file.name} (over 500KB for one message)`);
      continue;
    }
    if (!(await isText(file))) {
      skipped.push(`${file.name} (not a text file)`);
      continue;
    }
    total += file.size;
    const el = make('span');
    el.dataset.label = file.name;
    texts.set(el, await file.text());
    out.push({ kind: 'upload', label: file.name, el });
  }
  if (skipped.length) toast(`Not attached: ${skipped.join(', ')}. Text files and images can be attached.`);
  return out;
}
