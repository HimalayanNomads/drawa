// One issue in the GitHub window (its conversation, a comment box, close / reopen, labels and assignees), and the
// new issue form.
import { make, button, ago, pressed, toast } from '../lib/dom'
import { api } from '../lib/api'
import { enhanceMarked } from '../lib/markdown'
import { changed } from '../canvas/canvas'
import { getIssue, sendToClaude, sendLabel, publish, type Issue, type Label } from './gh'
import { win, load, header, conversation, writeBox, commentOn, ghLink, show, go, topBar } from './github'

export async function issueDetail(n: number) {
  const i = await load(`issue #${n}`, () => getIssue(n))
  if (!i) return
  const w = win!, acts = make('div', 'ghacts'), open = i.state === 'OPEN'
  const what = `issue #${n} "${i.title}"`
  const setState = (action: string) => async () => {
    if (await publish(`${action === 'close' ? 'Close' : 'Reopen'} this issue?`, `${action === 'close' ? 'Closes' : 'Reopens'} ${what}.`, action === 'close' ? 'Close' : 'Reopen', { op: 'state', kind: 'issue', n, action }, `${action === 'close' ? 'Closed' : 'Reopened'} #${n}.`)) show()
  }
  acts.append(make('span', 'ghsend', sendLabel() + ':'), button('This issue', 'ai', () => sendToClaude('issue', n, i.title)), make('span', 'spacer'),
    button('Labels and assignees', '', () => editor(i, pane)), button(open ? 'Close' : 'Reopen', '', setState(open ? 'close' : 'reopen')), ...ghLink(i.url))
  const pane = make('div', 'ghpane')
  pane.append(...conversation(i.body, i.comments), writeBox('Comment on this issue', [['Comment', 'primary', commentOn('issue', n)]]))
  const facts = [`@${i.author}`, ago(i.created), ...i.labels, ...(i.assignees.length ? [`assigned: ${i.assignees.map(a => '@' + a).join(', ')}`] : [])]
  w.body.replaceChildren(header(i.title, n, 'All issues', i.state.toLowerCase(), facts), acts, pane)
  enhanceMarked(pane)
}

let labelList: Promise<Label[]> | undefined
const repoLabels = () => (labelList ??= api<Label[]>('gh/labels').catch(e => { labelList = undefined; throw e }))

/** Toggle buttons for the repo's labels, `on` pressed. Returns the box and what's picked now. */
function labelPicker(on: string[]) {
  const box = make('div', 'ghlabels'), picked = new Set(on)
  box.setAttribute('role', 'group')
  box.setAttribute('aria-label', 'Labels')
  box.append(make('span', 'ghnote', 'Loading labels…'))
  repoLabels().then(all => {
    box.replaceChildren(...all.map(l => {
      const b = button(l.name, 'ghlabel-b', () => { picked.has(l.name) ? picked.delete(l.name) : picked.add(l.name); pressed(b, picked.has(l.name)) })
      b.type = 'button'
      b.title = l.description || l.name
      b.style.setProperty('--label', /^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : 'transparent') // GitHub's own label color: data, not a theme color
      pressed(b, picked.has(l.name))
      return b
    }), ...(all.length ? [] : [make('span', 'ghnote', 'This repo has no labels.')]))
  }, e => box.replaceChildren(make('span', 'ghnote bad', `Couldn't load labels: ${(e as Error).message}`)))
  return { box, picked }
}

const logins = (s: string) => s.split(/[\s,]+/).map(x => x.replace(/^@/, '')).filter(Boolean)

/** Edit an issue's labels and assignees in place, above its conversation. Saved as one `gh issue edit`. */
function editor(i: Issue, pane: HTMLElement) {
  if (pane.querySelector('.ghedit')) return
  const f = make('form', 'ghedit ghform'), { box, picked } = labelPicker(i.labels), who = make('input'), row = make('div', 'row')
  Object.assign(who, { value: i.assignees.join(', '), placeholder: 'Assignees: logins, comma-separated' })
  who.setAttribute('aria-label', 'Assignees')
  who.addEventListener('keydown', e => e.stopPropagation())
  const cancel = button('Cancel', '', () => f.remove())
  cancel.type = 'button'
  const save = button('Save', 'primary', () => f.requestSubmit())
  save.type = 'submit'
  row.append(make('span', 'spacer'), cancel, save)
  f.append(make('b', 'ghsub-t', 'Labels'), box, make('b', 'ghsub-t', 'Assignees'), who, row)
  f.onsubmit = async e => {
    e.preventDefault()
    const now = logins(who.value)
    const change = {
      add_labels: [...picked].filter(l => !i.labels.includes(l)), remove_labels: i.labels.filter(l => !picked.has(l)),
      add_assignees: now.filter(a => !i.assignees.includes(a)), remove_assignees: i.assignees.filter(a => !now.includes(a)),
    }
    const lines = [['Add labels', change.add_labels], ['Remove labels', change.remove_labels], ['Assign', change.add_assignees], ['Unassign', change.remove_assignees]]
      .filter(([, l]) => l.length).map(([k, l]) => `${k}: ${(l as string[]).join(', ')}`)
    if (!lines.length) return f.remove()
    if (await publish('Change this issue?', `On issue #${i.number} "${i.title}":\n${lines.join('\n')}`, 'Save', { op: 'edit', kind: 'issue', n: i.number, ...change }, 'Issue updated.')) show()
  }
  pane.prepend(f)
  who.focus()
}

/** The new issue form: title, description, labels. Creating it opens it. */
export function newIssue() {
  const w = win!
  w.view = { ...w.view } // loads still running for the list stop drawing
  const f = make('form', 'ghform ghnew'), title = make('input'), body = make('textarea'), row = make('div', 'row')
  const { box, picked } = labelPicker([])
  Object.assign(title, { placeholder: 'Title', required: true })
  title.setAttribute('aria-label', 'Issue title')
  body.rows = 8
  body.placeholder = 'Description (Markdown)'
  body.setAttribute('aria-label', 'Issue description')
  for (const x of [title, body]) x.addEventListener('keydown', e => e.stopPropagation())
  const cancel = button('Cancel', '', () => go({}))
  cancel.type = 'button'
  const create = button('Create issue', 'primary', () => f.requestSubmit())
  create.type = 'submit'
  row.append(make('span', 'spacer'), cancel, create)
  f.append(make('h3', '', 'New issue'), title, body, make('b', 'ghsub-t', 'Labels'), box, row)
  f.onsubmit = async e => {
    e.preventDefault()
    const t = title.value.trim()
    if (!t) return toast('An issue needs a title.')
    const labels = [...picked]
    const r = await publish('Create this issue?', `${t}${labels.length ? `\nLabels: ${labels.join(', ')}` : ''}\n\n${body.value.trim() || '(no description)'}`, 'Create issue', { op: 'newissue', title: t, body: body.value, labels }, 'Issue created.')
    if (!r) return
    const n = Number(/\/issues\/(\d+)/.exec(r.out ?? '')?.[1])
    go(n ? { tab: 'issue', n } : { tab: 'issue' })
  }
  w.body.replaceChildren(topBar(), f)
  title.focus()
  changed()
}
