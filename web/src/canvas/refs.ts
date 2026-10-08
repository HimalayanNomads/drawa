// Canvas items you can reference in a message (type @ in a card, or drop the item onto a card's message box).
// Each item kind registers how it's labelled and what Claude receives for it (text, or text plus an image).
import { items } from './canvas'
import { imageBlock } from '../lib/blobs'

/** A window's title as shown on its tab ('' for items without one). Here, not in window.ts, so this registry
 *  imports nothing that imports it back: kinds can call referable() at their top level. */
export const winTitle = (el: Element) => el.querySelector('.win-h .t')?.textContent ?? ''

/** What Claude receives: text, maybe an image (base64; PNG unless `imageType` says otherwise). */
interface Content { text: string; image?: string; imageType?: string }
export interface Ref { kind: string; label: string; el: HTMLElement }
interface Referable {
  icon: string
  /** What the kind is called (Ctrl+K rows, search by kind); default: the kind itself. */
  name?: string
  /** What a chip and the @ menu call it (default: the window's title). */
  label?: (el: HTMLElement) => string
  /** What the item is doing */
  status?: (el: HTMLElement) => string | undefined
  content: (el: HTMLElement, label: string) => Promise<Content> | Content
  /** The text its window's copy button copies (Markdown source, code); no button without it. */
  copy?: (el: HTMLElement) => string
  /** Its content is a picture: an agent that takes text only can't be sent it. */
  picture?: boolean
}
const kinds = new Map<string, Referable>()

/** Let items of this kind be referenced in messages. */
export const referable = (kind: string, r: Referable) => { kinds.set(kind, r) }
export const refIcon = (kind: string) => kinds.get(kind)?.icon ?? '•'
export const kindName = (kind: string) => kinds.get(kind)?.name ?? kind
/** The kind's copy text, if its windows get a copy button. */
export const copyOf = (kind: string) => kinds.get(kind)?.copy
export const isPicture = (kind: string) => !!kinds.get(kind)?.picture
export const refStatus = (el: HTMLElement) => kinds.get(el.dataset.kind ?? '')?.status?.(el)

export function refOf(el: HTMLElement): Ref | null {
  const kind = el.dataset.kind, r = kind ? kinds.get(kind) : undefined
  if (!kind || !r) return null
  return { kind, el, label: (r.label ?? winTitle)(el).trim() || kind }
}

/** An item's content as Claude would receive it (null if its kind isn't referable). */
export async function readItem(el: HTMLElement) {
  const r = refOf(el)
  return r ? kinds.get(r.kind)!.content(el, r.label) : null
}

export const canvasRefs = () => items().map(refOf).filter((r): r is Ref => !!r)

/** The message content for a prompt plus references: plain text, or text + image blocks when some carry images. */
export async function toContent(prompt: string, refs: Ref[]): Promise<string | object[]> {
  if (!refs.length) return prompt
  const parts: string[] = [], images: { data: string; type: string }[] = []
  for (const r of refs) {
    const c = await kinds.get(r.kind)!.content(r.el, r.label)
    if (c.image) images.push({ data: c.image, type: c.imageType ?? 'image/png' })
    parts.push(c.image ? `${c.text}: attached as image ${images.length}.` : c.text)
  }
  const text = `${prompt}\n\nReferenced from my canvas:\n\n${parts.join('\n\n')}`
  if (!images.length) return text
  return [{ type: 'text', text }, ...images.map(i => imageBlock(i.type, i.data))]
}
