// A zoom/pan view for any figure (a diagram's SVG, a picture): wheel or pinch zooms, drag pans, +/-/0 keys.
import Panzoom, { type PanzoomObject } from '@panzoom/panzoom'
import { $ } from './dom'

const dialog = $<HTMLDialogElement>('#zoom')
const stage = dialog.querySelector<HTMLElement>('.stage')!
const content = dialog.querySelector<HTMLElement>('.content')!
let pz: PanzoomObject | undefined

/** Open a copy of `node` (an svg or img) in the zoom dialog. */
export function openZoom(node: Element) {
  const copy = node.cloneNode(true) as Element
  copy.removeAttribute('style') // Mermaid pins a max-width; let it fill the stage instead
  content.replaceChildren(copy)
  dialog.showModal()
  pz = Panzoom(content, { maxScale: 12, minScale: 0.4, step: 0.35, cursor: 'grab' })
}

stage.addEventListener('wheel', e => pz?.zoomWithWheel(e), { passive: false })
dialog.addEventListener('close', () => { pz?.destroy(); pz = undefined; content.replaceChildren() })
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close() }) // backdrop
dialog.addEventListener('keydown', e => {
  if (e.key === '+' || e.key === '=') pz?.zoomIn()
  else if (e.key === '-') pz?.zoomOut()
  else if (e.key === '0') pz?.reset()
})
for (const b of dialog.querySelectorAll<HTMLButtonElement>('[data-z]')) {
  b.onclick = () => {
    const z = b.dataset.z
    if (z === 'in') pz?.zoomIn()
    else if (z === 'out') pz?.zoomOut()
    else if (z === 'fit') pz?.reset()
    else dialog.close()
  }
}
