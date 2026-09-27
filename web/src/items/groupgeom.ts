// Geometry for window groups (items/group.ts): the frame around a group's windows, and pushing groups apart so they
// never overlap. No DOM here, so groupgeom.check.ts runs it under Node.
import type { Rect } from '../canvas/canvas'

export const PAD = 24 // between a group's edge and its windows
export const GAP = 24 // kept between two groups

/** The frame around these windows: their bounding box plus padding, with room for the group's tab on top. */
export function frameAround(rs: Rect[], pad: number, tab: number): Rect | null {
  if (!rs.length) return null
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y))
  const x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h))
  return { x: x0 - pad, y: y0 - pad - tab, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad + tab }
}

/** The room inside a frame for its windows: the frame minus its padding and its tab (frameAround's inverse). */
export const inner = (f: Rect, pad: number, tab: number): Rect => ({ x: f.x + pad, y: f.y + pad + tab, w: f.w - 2 * pad, h: f.h - 2 * pad - tab })

/** Windows laid out in `from`, stretched or shrunk into `to`: positions and sizes scale alike, each window kept at
 *  least `min`. ponytail: one minimum for every kind; a window whose own minimum is bigger can end up overlapping
 *  its neighbours when a frame is shrunk a lot. */
export function scaleInto(rs: Rect[], from: Rect, to: Rect, min = { w: 160, h: 100 }): Rect[] {
  const sx = from.w > 0 ? to.w / from.w : 1, sy = from.h > 0 ? to.h / from.h : 1
  return rs.map(r => ({ x: to.x + (r.x - from.x) * sx, y: to.y + (r.y - from.y) * sy, w: Math.max(min.w, r.w * sx), h: Math.max(min.h, r.h * sy) }))
}

const overlap = (a: Rect, b: Rect, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

/** Where a window dropped into a group goes: its drop spot if that overlaps no other window, else the free spot
 *  nearest to it, beside or below one of them inside `area` (or below them all, which is always free). */
export function placeIn(rs: Rect[], r: Rect, area: Rect, gap: number): Rect {
  const free = (c: Rect) => !rs.some(o => overlap(c, o, gap))
  if (free(r)) return r
  const bottom = Math.max(area.y, ...rs.map(o => o.y + o.h + gap))
  const spots = [{ x: area.x, y: area.y }, ...rs.flatMap(o => [{ x: o.x + o.w + gap, y: o.y }, { x: o.x, y: o.y + o.h + gap }])]
    .map(p => ({ ...r, ...p })).filter(c => c.x + c.w <= area.x + area.w && free(c))
  spots.push({ ...r, x: area.x, y: bottom })
  const d = (c: Rect) => Math.hypot(c.x - r.x, c.y - r.y)
  return spots.reduce((best, c) => (d(c) < d(best) ? c : best))
}

/** Close the gaps between windows (one was taken out): each slides up, then left, as far as the others and the
 *  corner of `area` let it, top rows first. Returns the rects in the order given. */
export function compact(rs: Rect[], area: Rect, gap: number): Rect[] {
  const out = rs.map(r => ({ ...r })), done: Rect[] = []
  for (const i of rs.map((_, i) => i).sort((i, j) => rs[i].y - rs[j].y || rs[i].x - rs[j].x)) {
    const r = out[i]
    r.y = Math.max(area.y, ...done.filter(o => o.x < r.x + r.w && r.x < o.x + o.w).map(o => o.y + o.h + gap))
    r.x = Math.max(area.x, ...done.filter(o => o.x < r.x && o.y < r.y + r.h && r.y < o.y + o.h).map(o => o.x + o.w + gap)) // only what's to its left
    done.push(r)
  }
  return out
}

export interface Frame { id: string; r: Rect }
/** Push groups apart. Locked groups never move; the groups in `first` (just moved, grown or made) move only off a
 *  locked one; any other group they overlap slides the shortest way out (right, left, down or up), then pushes
 *  whatever it overlaps in turn. Returns each pushed group's total offset. ponytail: greedy and capped at 200
 *  pushes, so a very crowded canvas can keep one overlap until the next move settles it; a real packing pass would
 *  fix that if it shows up. */
export function settle(frames: Frame[], first: string[], locked: string[] = [], gap = GAP): Map<string, { dx: number; dy: number }> {
  const at = new Map(frames.map(f => [f.id, { ...f.r }]))
  // who yields to whom: 0 locked, 1 just moved, 2 the rest (a pushed group pushes the rest too)
  const rank = (id: string) => (locked.includes(id) ? 0 : first.includes(id) ? 1 : 2)
  const queue = [...locked, ...first].filter(id => at.has(id))
  const out = new Map<string, { dx: number; dy: number }>()
  for (let n = 0; queue.length && n < 200; n++) {
    const aid = queue.shift()!, a = at.get(aid)!
    for (const [id, b] of at) {
      if (b === a || !overlap(a, b, gap)) continue
      if (!(rank(id) > rank(aid) || (rank(id) === 2 && out.has(aid)))) continue
      const right = a.x + a.w + gap - b.x, left = b.x + b.w + gap - a.x, down = a.y + a.h + gap - b.y, up = b.y + b.h + gap - a.y
      const m = Math.min(right, left, down, up)
      const d = m === right ? { dx: right, dy: 0 } : m === left ? { dx: -left, dy: 0 } : m === down ? { dx: 0, dy: down } : { dx: 0, dy: -up }
      b.x += d.dx
      b.y += d.dy
      const o = out.get(id) ?? { dx: 0, dy: 0 }
      out.set(id, { dx: o.dx + d.dx, dy: o.dy + d.dy })
      queue.push(id)
    }
  }
  return out
}
