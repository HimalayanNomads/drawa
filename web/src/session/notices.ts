// Messages the CLI adds to a conversation itself, not typed by you: a skill's instructions, and an agent's report to
// this session. Both fold into a quiet row whose Markdown renders only when opened.
import { make } from '../lib/dom'
import { md, enhance } from '../lib/markdown'
import { refIcon } from '../canvas/refs'
import { agentTitle } from '../items/agent'
import { put, type Session } from './session'
import { fold } from './stream'

/** Render `text` as Markdown into the row the first time it's opened (a skill or a report can be pages long). */
function onOpen(d: HTMLDetailsElement, text: string) {
  d.addEventListener('toggle', () => {
    if (!d.open || d.querySelector('.md')) return
    const body = d.appendChild(make('div', 'md io'))
    body.innerHTML = md(text)
    enhance(body)
  })
}

/** Text Claude Code added itself, like a skill's instructions. */
export function meta(S: Session, text: string) {
  const skill = /^Base directory for this skill: (\S+)/.exec(text)
  const d = put(S, fold('meta', skill ? `Skill · ${skill[1].split('/').filter(Boolean).pop()}` : 'Added by Claude Code'))
  onOpen(d, skill ? text.slice(skill[0].length).trim() : text)
}

// "Another Claude session sent a message: <agent-message from=…>…</agent-message>", then a note from the harness
// that isn't part of the report. A hand-back queued while Claude was busy is echoed bare, from <agent-message> on.
const HANDOFF = /^(?:Another Claude session sent a message[^\n]*:\s*)?<agent-message from="([^"]+)">([\s\S]*?)(?:<\/agent-message>|$)/
const reports = new WeakMap<Element, string>()

/** An agent's message to this session, usually its final report in the harness's hand-back frame: shown as the report
 *  itself under who sent it. Returns false when `text` isn't one. `live`: arriving now, so it opens. `meta`: the CLI
 *  flagged it isMeta; without that (the live echo of a queued hand-back has no flag) only one of our agents counts,
 *  so a typed look-alike stays a plain bubble. */
export function handoff(S: Session, text: string, live: boolean, meta = true) {
  const h = HANDOFF.exec(text)
  if (!h) return false
  const [, from, inner] = h, title = agentTitle(from), body = report(inner)
  if (!meta && !title) return false
  const d = put(S, fold('handoff', title ? `Report from the "${title}" agent` : `Message from agent ${from.slice(0, 8)}`))
  d.dataset.kind = 'agent' // colored like the agent's window, chip and Ctrl+K row
  d.querySelector('summary b')!.setAttribute('data-glyph', refIcon('agent'))
  reports.set(d, body)
  onOpen(d, body)
  d.open = live // a report arriving now is worth reading; replayed ones stay folded (and unrendered)
  return true
}
/** The report a hand-back row shows, rendered or not (for passing the conversation on as context). */
export const reportOf = (row: Element) => reports.get(row)

/** An agent's report without the harness's wrapping (the hand-back preface, its id line and usage). */
export function report(t: string) {
  const body = t.replace(/^[\s\S]*?The report follows:\n/, '').replace(/\n?agentId: [\s\S]*$/, '')
  // the harness indents every line by two: undo that only when it did (code and nested lists keep their own indent)
  return (body.split('\n').every(l => !l.trim() || l.startsWith('  ')) ? body.replace(/^ {2}/gm, '') : body).trim()
}
