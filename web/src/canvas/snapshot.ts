// A picture of a canvas window as you see it, with whatever was drawn on it: its own ink (inside it) and canvas
// strokes that cross it. Used to show Claude drawings: plan feedback, and canvas_read on any item.
import { rect } from './canvas'
import { hasInk } from './ink'
import { strokesIn } from './inksel'

/** PNG (base64) of `el` plus the ink on and over it. Without `always`, null when nothing was drawn there.
 *  `skip`: classes of parts left out of the picture (buttons, form fields). */
export async function snapshot(el: HTMLElement, o: { always?: boolean; skip?: string[] } = {}): Promise<string | null> {
  const r = rect(el), strokes = strokesIn(r)
  if (!o.always && !strokes.length && !hasInk(el)) return null
  const skip = ['grip', ...(o.skip ?? [])]
  const { toCanvas } = await import('html-to-image') // big: loaded on first use
  const canvas = await toCanvas(el, {
    pixelRatio: 1.5,
    backgroundColor: getComputedStyle(el.querySelector('.win-b') ?? el).backgroundColor,
    // static: an absolutely positioned root renders blank in html-to-image's picture (even at left/top 0)
    style: { position: 'static', left: '0', top: '0', transform: 'none', margin: '0' },
    filter: n => !(n instanceof HTMLElement && skip.some(c => n.classList.contains(c))),
  })
  const ctx = canvas.getContext('2d')!
  ctx.scale(canvas.width / el.offsetWidth, canvas.height / el.offsetHeight)
  ctx.translate(-r.x, -r.y) // canvas strokes are in world coordinates
  for (const s of strokes) {
    ctx.fillStyle = s.color
    if (s.area) { ctx.globalAlpha = 0.16; ctx.fill(new Path2D(s.area)); ctx.globalAlpha = 1 } // a filled shape's inside
    if (s.text == null) { ctx.fill(new Path2D(s.d)); continue }
    ctx.font = `500 ${s.size}px ${getComputedStyle(document.body).fontFamily}` // text written with the Text tool
    s.text.split('\n').forEach((line, i) => ctx.fillText(line, s.at[0], s.at[1] + s.size * (0.95 + i * 1.25)))
  }
  return canvas.toDataURL('image/png').split(',')[1]
}
