// Shapes in Draw mode (rectangle, ellipse, diamond, line) and moving your drawn objects around. A shape is an ink
// stroke (canvas/ink.ts) whose two points are its corners, or a line's two ends: it attaches to windows, scales in
// full view, follows chat rows, saves, erases and undoes like any stroke. In Select mode (not drawing), a shape or a
// piece of Text-tool text is an object in the canvas selection (canvas/select.ts): click to select it (Shift adds
// it), drag to move the selection, drag a corner to resize a lone shape; Delete, Esc and the arrow keys are the
// selection's own.
import { inkSelected, selectInk, selectedInk, selected, selectionMover, onSelect } from './select'
import { make, perFrame } from '../lib/dom'
import { onChange, changed, track, view } from './canvas'
import { handDrag } from './mode'
import { drawing, paint, type Stroke } from './ink'
import { objectAt, unitsPerPx } from './inksel'
import { changing } from './inkundo'

/* ---------- Select mode: a lone selected shape gets a frame and corner handles to resize it ---------- */
const box = document.body.appendChild(make('div', 'shape-sel'))
box.hidden = true
const handles = [0, 1, 2, 3].map(i => { const h = box.appendChild(make('i', 'h')); h.dataset.c = String(i); return h }) // corners: tl tr br bl
let picked: Stroke | null = null

// the frame follows the selection: exactly one drawing and no windows
onSelect(() => { const ink = selectedInk(); picked = ink.length === 1 && !selected().length ? ink[0] : null; place() })
/** Frame the picked object on screen; shapes get corner handles (a line only at its two ends). */
function place() {
  const el = picked?.el
  if (!picked || !el?.isConnected || drawing) { box.hidden = true; if (picked && !el?.isConnected) picked = null; return }
  const r = el.getBoundingClientRect()
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
  box.hidden = false
  const [a, b] = picked.p
  handles.forEach((h, i) => {
    const cx = i === 1 || i === 2 ? 1 : 0, cy = i >= 2 ? 1 : 0
    // a line has a point at this corner only if one end is extreme on both axes here
    const at = (q: number[], o: number[]) => (cx ? q[0] >= o[0] : q[0] <= o[0]) && (cy ? q[1] >= o[1] : q[1] <= o[1])
    h.hidden = !picked!.sh || (picked!.sh === 'line' && !at(a, b) && !at(b, a))
  })
}
onChange(() => place())
addEventListener('scroll', perFrame(place), { capture: true, passive: true }) // a streaming chat scrolls often

// pressing a drawn object (before the canvas pans or boxes a selection, and before windows drag)
document.addEventListener('pointerdown', e => {
  const t = e.target as Element
  if (e.button !== 0 || drawing) return
  const corner = t.closest<HTMLElement>('.shape-sel .h')
  if (corner && picked?.sh) { // resize: move whichever point is extreme on this corner's sides
    const i = Number(corner.dataset.c), cx = i === 1 || i === 2, cy = i >= 2, s = picked, orig = s.p.map(q => [...q]), k = unitsPerPx(s)
    const ix = orig[0][0] <= orig[1][0] === !cx ? 0 : 1, iy = orig[0][1] <= orig[1][1] === !cy ? 0 : 1
    const done = changing([s])
    track(corner, e, (dx, dy) => { s.p[ix][0] = orig[ix][0] + dx * k; s.p[iy][1] = orig[iy][1] + dy * k; paint(s); place(); changed() /* its arrows follow */ }, () => {
      if (s.p.some((q, j) => q[0] !== orig[j][0] || q[1] !== orig[j][1])) done()
      changed()
    })
    return
  }
  const s = handDrag() ? null : objectAt(t)
  if (!s) return
  if (!inkSelected(s)) selectInk(s, e.shiftKey)
  const move = selectionMover() // the whole selection moves, windows too; screen px to canvas units
  track(t, e, (dx, dy) => { move(dx / view.k, dy / view.k); place() }, () => { move.end(); place() })
}, true)
