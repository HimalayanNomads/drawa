// Claude's canvas tools. the Go server serves them over MCP to each card's Claude process and relays every call to
// this page, which carries it out here and posts the answer back. Item kinds register what Claude may create
// (`creatable`); reading reuses what `referable` already knows about each kind.
import { post } from '../lib/api'
import { titleOf, setTitle } from './window'
import { ping } from '../lib/dom'
import { items, rect, spotBeside, changed, shortId, type Rect } from './canvas'
import { link } from './graph'
import { readItem } from './refs'
import { snapshot } from './snapshot'
import { textsOn, inkOn, shapesOn } from './inksel'
import { addLink, userLinks } from './links'
import type { Session } from '../session/session'

type Args = Record<string, any>
interface Creatable {
  /** The argument it can't do without (default text). */
  needs?: string
  size: (a: Args) => { w: number; h: number }
  create: (a: Args, r: Rect) => HTMLElement | Promise<HTMLElement>
  /** canvas_update: change an existing item's content (`a.text`); may throw, the message goes back to Claude. */
  update?: (el: HTMLElement, a: Args) => void | Promise<void>
}
const makers = new Map<string, Creatable>()
/** Let Claude create items of this kind (canvas_create). `create` may throw: the message goes back to Claude. */
export const creatable = (kind: string, c: Creatable) => { makers.set(kind, c) }

/** A call relayed from the server: run it, answer with an MCP tool result. */
export async function canvasCall(S: Session, m: { id: string; tool: string; args?: Args }) {
  let result: object
  try { result = { content: await run(S, m.tool, m.args ?? {}) } }
  catch (e) { result = { content: [{ type: 'text', text: (e as Error).message }], isError: true } }
  // lost, Claude would wait out the server's timeout: try once more, then say which call it was
  const answer = () => post('canvas', { cid: S.cid, id: m.id, result })
  answer().catch(() => answer()).catch(e => console.error(`canvas tool ${m.tool}: couldn't answer Claude:`, e))
}

const short = (el: HTMLElement) => shortId(el.dataset.id ?? '')
/** The item Claude means: its exact id first (readable ids like "git" are prefixes of others), then a UUID prefix,
 *  only when just one item has it: a guess could change the wrong item. */
function find(id: unknown): HTMLElement {
  const want = String(id ?? '').trim(), all = items()
  const exact = want && all.find(e => e.dataset.id === want)
  if (exact) return exact
  const some = want ? all.filter(e => e.dataset.id?.startsWith(want)) : []
  if (some.length > 1) throw new Error(`Id "${want}" matches ${some.length} items: ${some.slice(0, 10).map(e => e.dataset.id).join(', ')}. Use a longer id.`)
  if (!some.length) throw new Error(`No canvas item with id "${want}". Call canvas_list for the current ids.`)
  return some[0]
}

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
const text = (t: string): Block[] => [{ type: 'text', text: t }]

async function run(S: Session, tool: string, a: Args): Promise<Block[]> {
  if (tool === 'canvas_list') {
    return text(JSON.stringify({ items: items().map(el => {
      const r = rect(el)
      return { id: short(el), kind: el.dataset.kind, title: titleOf(el).slice(0, 80), x: Math.round(r.x), y: Math.round(r.y), w: r.w, h: r.h,
        ...(el.classList.contains('min') ? { collapsed: true } : {}), ...(el === S.card ? { you: true } : {}),
        ...(inkOn(el, r) ? { drawnOn: true } : {}) }
    }), arrows: userLinks() })) // arrows the user (or you) drew between items
  }
  if (tool === 'canvas_read') {
    // its content as text, and a picture when someone drew on it (or when asked): ink never shows up in the text
    const el = find(a.id), c = await readItem(el)
    const drawn = await snapshot(el) // null unless there's ink on or over it
    const pic = drawn ?? c?.image ?? (a.image ? await snapshot(el, { always: true }) : null)
    const type = (!drawn && c?.image && c.imageType) || 'image/png'
    const written = textsOn(el, rect(el)), shapes = shapesOn(el, rect(el))
    const out: Block[] = [...text((c?.text ?? `${el.dataset.kind} "${titleOf(el)}"`) + (written.length ? `\n\nThe user wrote on it: ${written.map(t => JSON.stringify(t)).join(', ')}` : '') + (shapes.length ? `\n\nThe user drew on it: ${shapes.join('; ')}.` : ''))]
    if (pic) out.push({ type: 'text', text: drawn ? 'How it looks on the canvas, including what the user drew on it:' : 'How it looks:' },
      { type: 'image', data: pic, mimeType: type })
    return out
  }
  if (tool === 'canvas_create') {
    const m = makers.get(a.kind)
    if (!m) throw new Error(`Can't create "${a.kind}". Kinds: ${[...makers.keys()].join(', ')}.`)
    const need = m.needs ?? 'text'
    if (typeof a[need] !== 'string' || !a[need].trim()) throw new Error(`${need} is required for ${a.kind}.`)
    const size = m.size(a)
    const el = await m.create(a, spotBeside(a.near ? find(a.near) : S.card, size.w, size.h, 80))
    link(S, el, 'made') // an arrow from the session that made it
    ping(el)
    changed() // saved with the layout
    return text(JSON.stringify({ id: short(el), kind: a.kind }))
  }
  if (tool === 'canvas_update') {
    const el = find(a.id), m = makers.get(el.dataset.kind ?? '')
    if (!m?.update) throw new Error(`Can't edit ${el.dataset.kind} items. Editable kinds: ${[...makers].filter(([, v]) => v.update).map(([k]) => k).join(', ')}.`)
    if (a.text == null && a.title == null) throw new Error('Nothing to change: pass text and/or title.')
    if (a.text != null) await m.update(el, a)
    if (a.title != null) setTitle(el, String(a.title))
    link(S, el, 'edit') // an edit arrow from the session, like a file it changed
    ping(el)
    changed()
    return text(JSON.stringify({ id: short(el), updated: [a.text != null && 'text', a.title != null && 'title'].filter(Boolean) }))
  }
  if (tool === 'canvas_link') {
    const from = find(a.from), to = find(a.to)
    if (from === to) throw new Error('An arrow needs two different items.')
    addLink(from, to, String(a.label ?? '').trim(), 'write')
    return text(JSON.stringify({ from: short(from), to: short(to) }))
  }
  throw new Error(`Unknown canvas tool ${tool}.`)
}
