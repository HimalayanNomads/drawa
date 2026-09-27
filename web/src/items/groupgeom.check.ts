// The window-group geometry, checked without a browser. Run: cd web && npx --yes tsx src/items/groupgeom.check.ts
import { frameAround, settle, inner, scaleInto, placeIn, compact } from './groupgeom'

const eq = (got: unknown, want: unknown, what: string) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`)
}
const box = (x: number, y = 0) => ({ x, y, w: 100, h: 100 })

eq(frameAround([], 24, 34), null, 'an empty group has no frame to fit')
eq(frameAround([{ x: 100, y: 100, w: 200, h: 100 }, { x: 400, y: 150, w: 100, h: 100 }], 24, 34),
  { x: 76, y: 42, w: 448, h: 232 }, 'the frame wraps its windows with padding and room for the tab')
eq([...settle([{ id: 'a', r: box(0) }, { id: 'b', r: box(300) }], ['a'])], [], 'apart: nothing moves')
eq([...settle([{ id: 'a', r: box(0) }, { id: 'b', r: box(50) }], ['a'])], [['b', { dx: 74, dy: 0 }]], 'overlap: the shortest push (right)')
eq([...settle([{ id: 'a', r: box(0) }, { id: 'b', r: box(0, 60) }], ['a'])], [['b', { dx: 0, dy: 64 }]], 'overlap: the shortest push (down)')
eq([...settle([{ id: 'a', r: box(0) }, { id: 'b', r: box(50) }, { id: 'c', r: box(180) }], ['a'])],
  [['b', { dx: 74, dy: 0 }], ['c', { dx: 68, dy: 0 }]], 'a chain: a pushes b, b pushes c')
eq([...settle([{ id: 'a', r: box(0) }, { id: 'b', r: box(50) }], ['a', 'b'])], [], 'groups that just moved never move')
eq([...settle([{ id: 'a', r: box(0) }, { id: 'b', r: box(50) }], ['b'], ['a'])], [['b', { dx: 74, dy: 0 }]], 'a locked group stays: the one dropped on it moves off')
eq([...settle([{ id: 'a', r: box(0) }, { id: 'b', r: box(50) }, { id: 'c', r: box(180) }], ['b'], ['a'])],
  [['b', { dx: 74, dy: 0 }], ['c', { dx: 68, dy: 0 }]], 'pushed off a locked group, it pushes the next one')
eq([...settle([{ id: 'a', r: box(0) }, { id: 'b', r: box(50) }], ['a'], ['b'])], [['a', { dx: -74, dy: 0 }]], 'moved onto a locked group: the locked one stays, the moved one yields')
eq(inner({ x: 76, y: 42, w: 448, h: 232 }, 24, 34), { x: 100, y: 100, w: 400, h: 150 }, 'the room inside a frame: minus padding and the tab')
eq(scaleInto([{ x: 10, y: 10, w: 50, h: 40 }], { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 200, h: 50 }, { w: 0, h: 0 }),
  [{ x: 20, y: 5, w: 100, h: 20 }], 'windows stretch and shrink with the frame, positions and sizes alike')
eq(scaleInto([{ x: 10, y: 10, w: 50, h: 40 }], { x: 0, y: 0, w: 100, h: 100 }, { x: -100, y: 0, w: 200, h: 100 }, { w: 0, h: 0 }),
  [{ x: -80, y: 10, w: 100, h: 40 }], 'resized from the left: they spread to the left')
eq(scaleInto([{ x: 0, y: 0, w: 50, h: 40 }], { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 20, h: 20 }, { w: 30, h: 25 }),
  [{ x: 0, y: 0, w: 30, h: 25 }], 'never smaller than a window can be')
// placing a dropped window among the others: its drop spot if free, else the nearest free one
const a0 = { x: 0, y: 0, w: 100, h: 100 }, area = { x: 0, y: 0, w: 400, h: 300 }
eq(placeIn([a0], { x: 200, y: 0, w: 100, h: 100 }, area, 24), { x: 200, y: 0, w: 100, h: 100 }, 'a free drop spot is kept')
eq(placeIn([a0], { x: 30, y: 20, w: 100, h: 100 }, area, 24), { x: 124, y: 0, w: 100, h: 100 }, 'dropped on a window: the nearest free spot beside it')
eq(placeIn([a0, { x: 124, y: 0, w: 276, h: 100 }], { x: 30, y: 20, w: 100, h: 100 }, area, 24), { x: 0, y: 124, w: 100, h: 100 }, 'no room beside: below')
// closing the gap a removed window left: everything slides up, then left, as far as it can
eq(compact([{ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 300, w: 100, h: 50 }], area, 24), [{ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 124, w: 100, h: 50 }], 'a gap above slides up')
eq(compact([{ x: 0, y: 0, w: 100, h: 100 }, { x: 250, y: 0, w: 100, h: 100 }], area, 24), [{ x: 0, y: 0, w: 100, h: 100 }, { x: 124, y: 0, w: 100, h: 100 }], 'a gap beside slides left')
eq(compact([{ x: 50, y: 60, w: 100, h: 100 }], area, 24), [{ x: 0, y: 0, w: 100, h: 100 }], 'into the corner of the room')
eq(compact([{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 0, w: 100, h: 400 }, { x: 0, y: 300, w: 100, h: 50 }], area, 24)[2],
  { x: 0, y: 124, w: 100, h: 50 }, 'a tall window to the right doesn\'t push one on the left further right')
console.log('groupgeom: ok')
