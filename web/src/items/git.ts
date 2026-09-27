// The Git window: branch and sync state, staged / unstaged / untracked files (click one for its diff), stage and
// unstage, commit (Claude can write the message), push and pull, recent commits. One per canvas; it refreshes
// itself every few seconds while it's open and expanded.
import { make, ICON, iconButton, button, confirmBox, ping, project } from '../lib/dom'
import { api, post, q } from '../lib/api'
import { persist } from '../lib/store'
import { savedRect, centerOn, spotBeside, changed, type Rect } from '../canvas/canvas'
import { makeWindow } from '../canvas/window'
import { forget } from '../canvas/graph'
import { referable } from '../canvas/refs'
import { unified } from '../panels/diff'
import { openGitHub, GH_ICON } from './github'
import { ghPost, tally, dot, stateOf, REVIEW, sendToClaude, type GhState } from './gh'
import { writer, setWriter, who, installed, blurb, chooser } from '../lib/agents'

interface GitFile { path: string; x: string; y: string; staged: [number, number]; unstaged: [number, number] }
interface GitState { repo: boolean; missing?: boolean; error?: string; branch?: string; upstream?: boolean; ahead?: number; behind?: number; files?: GitFile[]; total?: number; log?: { hash: string; subject: string; when: string; author: string }[] }

let win: { el: HTMLElement; meta: HTMLElement; body: HTMLElement; msg: HTMLTextAreaElement; out: HTMLElement; gh: number; poll: number; delay: number; stop: AbortController; open: Set<string>; last: string } | undefined

const FAST = 4000, SLOW = 30_000 // git status polling: FAST after a change, doubling up to SLOW while nothing changes

type GitReply = { ok?: boolean; out?: string; message?: string; error?: string }
/** A git action. Never throws: a dead server comes back as a failed reply. */
const gitPost = (body: object): Promise<GitReply> =>
  post('git', body).catch(e => ({ ok: false, out: (e as Error).message, error: (e as Error).message }))

/** Open (or bring into view) the Git window. */
export function openGit(r?: Rect) {
  if (win) { centerOn(win.el); ping(win.el); return }
  const meta = make('span', 'm')
  const { el, head, body } = makeWindow({
    kind: 'git', cls: 'gnode', title: 'git', minW: 300, minH: 200,
    rect: r ?? spotBeside(null, 380, 520),
    actions: [iconButton(GH_ICON, 'GitHub: pull requests and issues (Shift+G)', () => openGitHub()),
      iconButton(ICON.x, 'Close', () => { clearInterval(win!.gh); clearTimeout(win!.poll); win!.stop.abort(); forget(el); el.remove(); win = undefined; changed() }, 'closebtn')],
  })
  el.dataset.id = 'git' // one per project: arrows and pins find it again after a reload
  head.querySelector('.t')!.after(meta)
  const list = make('div', 'glist'), foot = make('div', 'gfoot'), msg = make('textarea'), out = make('p', 'gout')
  msg.rows = 2
  msg.placeholder = 'Commit message'
  msg.setAttribute('aria-label', 'Commit message')
  msg.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit() })
  foot.append(msg, out)
  body.append(strip, list, foot)
  // refresh while it's visible and expanded: git status is cheap; GitHub is slow and rate-limited, so its own much
  // slower loop (and after pushes and commits)
  // poll only while you can see it: page visible, window open, and on screen (each poll runs git status on the server)
  const seen = () => { const r = el.getBoundingClientRect(); return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight }
  const showing = () => !document.hidden && !el.classList.contains('min') && seen()
  const tick = async () => {
    if (win?.el !== el) return
    if (showing()) await refresh()
    if (win?.el !== el) return
    clearTimeout(win.poll) // a wake() during the await: one loop, not two
    win.poll = setTimeout(tick, win.delay)
  }
  // back to fast polling (at once) when you might have changed something: focus, a click in the window, a turn ending
  const wake = () => { if (win?.el !== el) return; win.delay = FAST; clearTimeout(win.poll); win.poll = setTimeout(tick, 0) }
  const stop = new AbortController(), signal = stop.signal
  addEventListener('focus', wake, { signal })
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake() }, { signal })
  document.addEventListener('turnend', wake, { signal }) // ponytail: nothing dispatches this yet; the session's result handler should
  el.addEventListener('pointerdown', wake, { signal })
  el.addEventListener('collapse', wake, { signal })
  win = { el, meta, body: list, msg, out, gh: setInterval(() => { if (showing()) ghRefresh() }, 60_000), poll: 0, delay: FAST, stop, open: new Set(), last: '' }
  refresh()
  win.poll = setTimeout(tick, FAST)
  if (!strip.childElementCount) strip.replaceChildren(make('p', 'ghnote', 'Checking GitHub…'))
  ghRefresh()
  if (!r) centerOn(el) // a free spot can be off-screen: bring the new window into view
  changed()
}

function say(text: string, bad = false) { if (!win) return; win.out.textContent = text; win.out.classList.toggle('bad', bad) }

export async function refresh() {
  if (!win) return
  let st: GitState
  try { st = await api<GitState>('git') } catch (e) { return say(`Could not read git status: ${(e as Error).message}`, true) }
  const sig = JSON.stringify(st)
  if (sig === win.last) { win.delay = Math.min(win.delay * 2, SLOW); return } // nothing changed: keep the DOM (and any open diffs)
  win.last = sig
  win.delay = FAST
  draw(st)
}

function draw(st: GitState) {
  const w = win!
  strip.hidden = !st.repo // pull request status means nothing without a repository
  if (st.missing) {
    w.meta.textContent = 'not installed'
    const box = make('div', 'gempty')
    box.append(make('p', '', st.error!))
    w.body.replaceChildren(box)
    w.msg.parentElement!.hidden = true
    return
  }
  if (!st.repo) {
    w.meta.textContent = 'not a repository'
    const box = make('div', 'gempty')
    box.append(make('p', '', `${project.name} isn't a git repository yet.`), button('Initialize repository', 'primary', async () => {
      if (!await confirmBox('Initialize a git repository?', `Runs git init in ${project.root}. Nothing is committed until you commit.`, 'Initialize')) return
      const r = await gitPost({ op: 'init' })
      say(r.out ?? '', !r.ok)
      refresh()
    }))
    w.body.replaceChildren(box)
    w.msg.parentElement!.hidden = true
    return
  }
  w.msg.parentElement!.hidden = false
  const sync = [st.ahead ? `↑${st.ahead}` : '', st.behind ? `↓${st.behind}` : ''].filter(Boolean).join(' ')
  w.meta.textContent = `${st.branch}${sync ? ' ' + sync : ''}`
  w.meta.title = st.upstream ? `${st.ahead} commit(s) to push, ${st.behind} to pull` : 'No upstream branch yet: Push sets one up'

  const files = st.files ?? []
  const staged = files.filter(f => f.x !== ' ' && f.x !== '?')
  const changedFiles = files.filter(f => f.y !== ' ' && f.x !== '?')
  const untracked = files.filter(f => f.x === '?')
  const section = (title: string, list: GitFile[], isStaged: boolean, action: [string, () => void]) => {
    if (!list.length) return []
    const h = make('div', 'gsec')
    h.append(make('b', '', title), make('span', 'n', String(list.length)), button(action[0], '', action[1]))
    return [h, ...list.map(f => row(f, isStaged))]
  }
  const paths = (l: GitFile[]) => l.map(f => f.path)
  w.body.replaceChildren(
    ...section('Staged', staged, true, ['Unstage all', () => op('unstage', paths(staged))]),
    ...section('Changes', changedFiles, false, ['Stage all', () => op('stage', paths(changedFiles))]),
    ...section('Untracked', untracked, false, ['Stage all', () => op('stage', paths(untracked))]),
    ...(files.length ? [] : [make('p', 'none', 'Working tree clean.')]),
    ...((st.total ?? 0) > files.length ? [make('p', 'none', `…and ${st.total! - files.length} more changed files (the list stops at ${files.length}).`)] : []),
    ...(st.log?.length ? [commitsList(st.log)] : []),
  )
  // commit / push buttons reflect what's possible now
  const row2 = make('div', 'row')
  const { box: writeBox, b: write } = writeWith(writeMessage, n => `${n} reads the staged diff and drafts a message (you can edit it)`)
  write.disabled = !staged.length
  const commitBtn = button(staged.length ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit', 'primary', commit)
  commitBtn.disabled = !staged.length
  row2.append(writeBox)
  if (st.behind) row2.append(button(`Pull ↓${st.behind}`, '', () => op('pull')))
  if (st.ahead || (!st.upstream && st.log?.length)) row2.append(button(st.ahead ? `Push ↑${st.ahead}` : 'Push', '', push))
  row2.append(commitBtn)
  w.msg.parentElement!.querySelector('.row')?.remove()
  w.msg.after(row2)
}

const STATUS: Record<string, [string, string]> = { M: ['M', 'modified'], A: ['A', 'added'], D: ['D', 'deleted'], R: ['R', 'renamed'], C: ['C', 'copied'], U: ['U', 'conflict'], '?': ['U', 'untracked'] }

function row(f: GitFile, isStaged: boolean) {
  const code = isStaged ? f.x : f.y === ' ' ? f.x : f.y
  const [letter, word] = STATUS[code] ?? [code, 'changed']
  const [a, d] = isStaged ? f.staged : f.unstaged
  const key = `${isStaged ? 's' : 'w'}:${f.path}`
  const wrap = make('div', 'gfile'), r = make('div', 'grow')
  wrap.dataset.state = word
  const folder = f.path.endsWith('/') // an untracked folder is one row (git status --untracked-files=normal)
  const p = folder ? f.path.slice(0, -1) : f.path, slash = p.lastIndexOf('/')
  const name = make('button', 'gname')
  name.type = 'button'
  name.title = folder ? `${f.path} (untracked folder). Stage it to see its files.` : `${f.path} (${word}). Click for the diff.`
  name.append(make('span', 'gs', letter), make('span', 'gp', p.slice(slash + 1) + (folder ? '/' : '')), make('span', 'gd', slash > 0 ? p.slice(0, slash + 1) : ''))
  const stat = make('span', 's')
  if (a || d) stat.append(make('span', 'a', `+${a}`), ' ', make('span', 'r', `−${d}`))
  const act = iconButton(isStaged ? '<svg viewBox="0 0 16 16"><path d="M3.5 8h9"/></svg>' : ICON.plus, isStaged ? 'Unstage' : 'Stage', () => op(isStaged ? 'unstage' : 'stage', [f.path]))
  r.append(name, stat, act)
  wrap.append(r)
  const toggle = async () => {
    const open = wrap.querySelector('.diff')
    wrap.classList.toggle('open', !open)
    name.setAttribute('aria-expanded', String(!open))
    if (open) { open.remove(); win!.open.delete(key); return }
    win!.open.add(key)
    const { diff } = await api<{ diff: string }>(`git/diff?path=${q(f.path)}&staged=${isStaged ? 1 : 0}`)
    wrap.append(unified(diff))
  }
  if (folder) return wrap
  name.onclick = toggle
  if (win!.open.has(key)) toggle() // keep a diff you opened open across refreshes
  return wrap
}

function commitsList(log: NonNullable<GitState['log']>) {
  const d = make('details', 'glog'), s = make('summary')
  s.append(make('b', '', 'Recent commits'))
  d.append(s, ...log.map(c => {
    const r = make('div', 'gc')
    r.append(make('code', '', c.hash), make('span', 'gm', c.subject), make('span', 'gw', c.when))
    r.title = `${c.hash} · ${c.author} · ${c.when}`
    return r
  }))
  return d
}

async function op(o: string, paths?: string[]) {
  const r = await gitPost({ op: o, paths })
  say(r.ok ? (o === 'pull' ? r.out || 'Up to date.' : '') : r.out ?? 'Failed', !r.ok)
  refresh()
}

async function commit() {
  const w = win!, message = w.msg.value.trim()
  if (!message) { w.msg.focus(); return say(`Write a commit message first (or let ${who(writer())} write one).`, true) }
  const r = await gitPost({ op: 'commit', message })
  if (r.ok) { w.msg.value = ''; say(r.out?.split('\n')[0] ?? 'Committed.'); ghRefresh() } else say(r.out ?? 'Commit failed', true)
  refresh()
}

async function push() {
  if (!await confirmBox('Push to the remote?', 'Your commits on this branch are uploaded to the remote repository, where others can see them.', 'Push')) return
  say('Pushing…')
  const r = await gitPost({ op: 'push' })
  if (r.ok) ghRefresh()
  say(r.ok ? r.out?.split('\n').pop() || 'Pushed.' : r.out ?? 'Push failed', !r.ok)
  refresh()
}

/** "Write with <agent>", and a ▾ to pick which agent writes when more than one installed can (remembered, this
 *  browser). `tip` says what it reads, given the agent's name. */
function writeWith(run: (b: HTMLButtonElement, agent: string) => void, tip: (name: string) => string) {
  const box = make('span', 'writewith'), b = button('', 'ai', () => run(b, writer()))
  const label = () => { b.textContent = `Write with ${who(writer())}`; b.title = tip(who(writer())) }
  label()
  box.append(b)
  const can = installed().filter(a => a.canWrite)
  if (can.length > 1) box.append(chooser('Who writes it', can.map(a => ({ value: a.name, text: a.title, desc: blurb(a.name) })), writer(), v => { setWriter(v); label() }))
  return { box, b }
}

async function writeMessage(b: HTMLButtonElement, agent: string) {
  b.disabled = true
  const label = b.textContent
  b.textContent = 'Writing…'
  const r = await gitPost({ op: 'message', backend: agent })
  b.textContent = label
  b.disabled = false
  if (r.message) { win!.msg.value = r.message; win!.msg.style.height = 'auto'; win!.msg.style.height = Math.min(160, win!.msg.scrollHeight) + 'px'; say('') }
  else say(r.error ?? `${who(agent)} could not write a message.`, true)
}

/* ---------- GitHub: the pull request for this branch (through gh), or a form to open one ---------- */
const strip = make('div', 'ghstrip')
let ghLast = '', ghSt: GhState | undefined, ghAsk = 0
const form = make('form', 'ghform')
form.hidden = true

async function ghRefresh() {
  const ask = ++ghAsk // a slow answer to an older ask must not replace a newer one
  const st = await api<GhState>('gh').catch(e => ({ ok: false, error: (e as Error).message }) as GhState)
  if (ask !== ghAsk) return
  const sig = JSON.stringify(st)
  if (sig === ghLast) return
  ghLast = sig
  ghSt = st
  drawStrip(st)
}

function drawStrip(st: GhState) {
  strip.dataset.state = st.ok ? (st.pr ? stateOf(st.pr) : 'none') : 'off'
  if (!st.ok) return strip.replaceChildren(make('p', 'ghnote', (st.error ?? '').split('\n')[0] || 'GitHub is not available.'))
  const openBtn = iconButton(GH_ICON, `Pull requests and issues of ${st.repo}`, () => openGitHub())
  const pr = st.pr
  if (!pr) {
    const line = make('div', 'ghline')
    const featureBranch = st.branch && st.branch !== st.default
    line.append(openBtn, make('span', 'ghti', featureBranch ? `No pull request for ${st.branch}` : st.repo!))
    if (featureBranch) line.append(button(form.hidden ? 'Create pull request' : 'Cancel', '', () => { form.hidden = !form.hidden; if (!form.hidden) buildForm(st); drawStrip(st) }))
    else form.hidden = true
    // you switched branches with the form open: it now opens a pull request for the new one (Create pushes HEAD)
    const note = form.querySelector('.gout')
    if (note && form.dataset.branch && form.dataset.branch !== st.branch) note.textContent = `The branch is now ${st.branch}: this pull request will be for it.`
    return strip.replaceChildren(line, form)
  }
  form.hidden = true
  const t = tally(pr.checks), line = make('div', 'ghline'), title = make('button', 'ghti')
  title.type = 'button'
  title.append(make('span', 'ghn', `#${pr.number}`), ' ', pr.title)
  title.title = `Open pull request #${pr.number}`
  title.onclick = () => openGitHub({ tab: 'pr', n: pr.number })
  const badge = make('span', 'ghstate', stateOf(pr))
  badge.dataset.state = stateOf(pr)
  line.append(openBtn, title, badge)
  const facts = make('div', 'ghline ghsub')
  if (REVIEW[pr.review]) facts.append(make('span', '', REVIEW[pr.review]))
  if (pr.checks.length) {
    const sum = make('button', 'ghsum') // the list, with logs, is the GitHub window's Checks tab
    sum.type = 'button'
    sum.title = 'Show the checks'
    sum.append(dot(t.state), [t.pass && `${t.pass} passed`, t.fail && `${t.fail} failed`, t.pending && `${t.pending} running`].filter(Boolean).join(', '))
    sum.onclick = () => openGitHub({ tab: 'pr', n: pr.number, sub: 'checks' })
    facts.append(sum)
  }
  facts.append(make('span', 'spacer'), button('Send to Claude', 'ai', () => sendToClaude('pr', pr.number, pr.title)))
  if (t.fail) facts.append(button('Send failing checks', 'ai', () => sendToClaude('checks', pr.number, pr.title)))
  strip.replaceChildren(line, facts)
}

/** The Create pull request form: title, description (Claude can draft both), base branch, draft. Kept across
 *  refreshes while it's open, so a background refresh never eats what you typed. */
function buildForm(st: GhState) {
  form.dataset.branch = st.branch ?? ''
  if (form.childElementCount) return
  const title = make('input'), body = make('textarea'), base = make('input'), draft = make('input'), row = make('div', 'row'), out = make('p', 'gout')
  Object.assign(title, { placeholder: 'Title', required: true })
  title.setAttribute('aria-label', 'Pull request title')
  body.rows = 5
  body.placeholder = 'Description (Markdown)'
  body.setAttribute('aria-label', 'Pull request description')
  base.value = st.default ?? 'main'
  base.setAttribute('aria-label', 'Base branch')
  draft.type = 'checkbox'
  for (const f of [title, body, base]) f.addEventListener('keydown', e => e.stopPropagation())
  const baseLbl = make('label', 'ghbase'), draftLbl = make('label', 'ghdraft')
  baseLbl.append('into ', base)
  draftLbl.append(draft, ' Draft')
  const { box: writeBox } = writeWith(async (write, agent) => {
    const label = write.textContent
    write.disabled = true
    write.textContent = 'Writing…'
    const r = await ghPost({ op: 'draft', base: base.value.trim(), backend: agent })
    write.disabled = false
    write.textContent = label
    if (r.title) { title.value = r.title; body.value = r.body ?? ''; out.textContent = '' } else out.textContent = r.error ?? `${who(agent)} could not write it.`
  }, n => `${n} reads the commits and diff against the base branch and drafts a title and description`)
  const create = button('Create pull request', 'primary', () => form.requestSubmit())
  create.type = 'submit'
  row.append(writeBox, baseLbl, draftLbl, create)
  form.append(title, body, row, out)
  form.onsubmit = async e => {
    e.preventDefault()
    const b = base.value.trim(), branch = ghSt?.branch ?? 'this branch'
    if (!title.value.trim()) return title.focus()
    if (!await confirmBox('Create the pull request?', `Pushes ${branch} to origin and opens a pull request into ${b} on ${ghSt?.repo}. Everyone with access to the repository can see it.`, 'Create pull request')) return
    create.disabled = true
    out.textContent = 'Pushing and creating…'
    const r = await ghPost({ op: 'create', title: title.value, body: body.value, base: b, draft: draft.checked })
    create.disabled = false
    out.textContent = r.out ?? ''
    out.classList.toggle('bad', !r.ok)
    if (r.ok) { form.replaceChildren(); form.hidden = true; ghLast = ''; ghRefresh(); refresh() }
  }
}

persist('git', () => (win ? savedRect(win.el) : null), (r: Rect | null) => { if (r) openGit(r) })

// drop the Git window on a card: Claude gets the branch and what's changed (it can run git diff itself for details)
referable('git', {
  icon: '⎇',
  label: () => 'git status',
  content: async () => {
    const st = await api<GitState>('git')
    if (!st.repo) return { text: 'Git: this project is not a git repository.' }
    const files = (st.files ?? []).map(f => `- ${f.x === '?' ? 'untracked' : [f.x !== ' ' && 'staged', f.y !== ' ' && 'unstaged'].filter(Boolean).join(' + ')}: ${f.path}`)
    return { text: `Git status of the project: branch ${st.branch}${st.ahead ? `, ${st.ahead} to push` : ''}${st.behind ? `, ${st.behind} to pull` : ''}.\n${files.join('\n') || 'Working tree clean.'}` }
  },
})
