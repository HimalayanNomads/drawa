// Shapes' geometry (rectangle, ellipse, diamond, line): their outlines as points, their fills, Shift's constraints.
// Pure math, no DOM: canvas/ink.ts draws with it and canvas/shapes.ts moves and resizes the result.
export type Shape = 'rect' | 'ellipse' | 'diamond' | 'line'
export const SHAPES: Shape[] = ['rect', 'ellipse', 'diamond', 'line']
export const SHAPE_NAME: Record<Shape, string> = { rect: 'rectangle', ellipse: 'ellipse', diamond: 'diamond', line: 'line' }

/** Points along a shape's outline between two corners (a line's two ends). Closed shapes run a little past where they
 *  started, the way a hand-drawn loop overlaps itself. `step`: spacing between points, so corners stay sharp. */
export function outlinePoints(sh: Shape, [x0, y0]: number[], [x1, y1]: number[], step: number): number[][] {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2
  if (sh === 'ellipse') {
    const n = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / step))
    return Array.from({ length: n + Math.ceil(n / 16) + 1 }, (_, i) => [cx + rx * Math.cos((i / n) * 2 * Math.PI - Math.PI / 2), cy + ry * Math.sin((i / n) * 2 * Math.PI - Math.PI / 2)])
  }
  const corners = sh === 'line' ? [[x0, y0], [x1, y1]]
    : sh === 'rect' ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    : [[cx, Math.min(y0, y1)], [Math.max(x0, x1), cy], [cx, Math.max(y0, y1)], [Math.min(x0, x1), cy], [cx, Math.min(y0, y1)]]
  if (sh !== 'line') { const [a, b] = [corners[0], corners[1]]; corners.push([a[0] + (b[0] - a[0]) * 0.08, a[1] + (b[1] - a[1]) * 0.08]) } // the overlap
  const out: number[][] = [corners[0]]
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1], [bx, by] = corners[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
    for (let j = 1; j <= n; j++) out.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n])
  }
  return out
}
/** The area a filled shape covers (its closed outline). */
export function fillPath(sh: Shape, a: number[], b: number[]) {
  if (sh === 'line') return ''
  const step = sh === 'ellipse' ? (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])) / 60 || 1 : Infinity
  return 'M' + outlinePoints(sh, a, b, step).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z'
}
/** Shift while drawing: a square / circle, or a line at a multiple of 45°. */
export function constrain(sh: Shape, [x0, y0]: number[], [x, y]: number[]): number[] {
  const dx = x - x0, dy = y - y0
  if (sh !== 'line') { const d = Math.max(Math.abs(dx), Math.abs(dy)); return [x0 + Math.sign(dx || 1) * d, y0 + Math.sign(dy || 1) * d] }
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), r = Math.hypot(dx, dy)
  return [x0 + r * Math.cos(a), y0 + r * Math.sin(a)]
}
