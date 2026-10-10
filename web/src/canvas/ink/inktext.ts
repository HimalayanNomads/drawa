// Text on the drawing: click to write (the Text tool); click your text again to change it.
import { closestAt } from '../../lib/dom';
import { changed } from '../core/view';
import { eraseStrokes, recordStrokesAdded, startStrokeChange } from './inkactions';
import { placeAt } from './inkplace';
import { rowAt } from './inkrows';
import { inkPlaced, paint, type Stroke, strokes } from './stroke';

const TEXT_PX: Record<number, number> = { 2: 14, 4: 18, 9: 28 }; // pen size -> font size on screen
let editor: HTMLTextAreaElement | null = null;
/** Write at the press (or change the text under it), in this pen color and size. */
export function writeAt(e: PointerEvent, color: string, size: number) {
  editor?.blur(); // finish the one being written
  const hit = closestAt<SVGTextElement>(e.clientX, e.clientY, '.ink-text');
  const old = hit && strokes.find(s => s.el === hit);
  const box = old?.el?.getBoundingClientRect();
  const at = box
    ? { clientX: box.left, clientY: box.top }
    : { clientX: e.clientX, clientY: e.clientY - (TEXT_PX[size] ?? 18) * 0.6 };
  const { host, pt, scale } = placeAt(at);
  const s: Stroke = old ?? {
    c: color,
    s: (TEXT_PX[size] ?? 18) * scale,
    sim: false,
    p: [pt(at).slice(0, 2)],
    t: '',
    host,
    h: host?.dataset.ink,
    ...rowAt(host, at),
  };
  const px = s.s / scale; // font size on screen now
  const ta = (editor = document.body.appendChild(document.createElement('textarea')));
  ta.className = `ink-editor ink-c-${s.c}`;
  ta.value = s.t ?? '';
  ta.setAttribute('aria-label', 'Text on the drawing');
  ta.style.cssText = `left:${at.clientX}px;top:${at.clientY}px;font-size:${px}px`;
  /** Grow the text box to fit what's typed. */
  const fitSize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    ta.style.width = 'auto';
    ta.style.width = `${Math.max(40, ta.scrollWidth + 4)}px`;
  };
  ta.oninput = fitSize;
  if (old?.el) old.el.style.visibility = 'hidden'; // the editor stands in for it
  ta.onkeydown = ev => {
    ev.stopPropagation(); // typing isn't a shortcut
    if (ev.key === 'Escape' || (ev.key === 'Enter' && !ev.shiftKey)) {
      ev.preventDefault();
      ta.blur();
    }
  };
  ta.onblur = () => {
    if (editor === ta) editor = null;
    ta.remove();
    const text = ta.value.replace(/\s+$/, '');
    if (old?.el) old.el.style.visibility = '';
    if (!text) {
      if (old) eraseStrokes(old);
      return;
    }
    const done = old && text !== old.t ? startStrokeChange([old]) : null;
    s.t = text;
    if (!old) {
      strokes.push(s);
      recordStrokesAdded(s);
    }
    paint(s);
    done?.();
    if (!old) inkPlaced([s]);
    changed();
  };
  requestAnimationFrame(() => {
    fitSize();
    ta.focus();
  });
}
/** Finish the text being written, if any. */
export const finishText = () => editor?.blur();
