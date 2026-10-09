// The Git window: branch and sync state, staged / unstaged / untracked files, commit, push and pull, recent commits,
// and the pull request for this branch. Repos in the project's subfolders get a group each (gitrepo.ts draws one
// repo). One per canvas; it refreshes itself every few seconds while it's open and expanded.
import { make, ICON, iconButton, button, confirmBox, ping, project } from '../lib/dom'
import { api, post } from '../lib/api'
import { persist } from '../lib/store'
import { savedRect, centerOn, spotBeside, changed, watched, type Rect } from '../canvas/canvas'
import { makeWindow } from '../canvas/window'
import { forget } from '../canvas/graph'
import { referable } from '../canvas/refs'
import { openGitHub, GH_ICON } from './github'
import { definable, showRefs } from '../panels/defs'
import { repoView, repoName, fill, isOpen, syncText, drafts, folds, picks, type GitState, type RepoView, type Host } from './gitrepo'

let win: { el: HTMLElement; meta: HTMLElement; body: HTMLElement; list: HTMLElement; note: HTMLElement; gh: number; poll: number; delay: number; stop: AbortController; views: Map<string, RepoView>; single: boolean; host: Host; last: string; st?: GitState } | undefined

const FAST = 4000, SLOW = 30_000 // git status polling: FAST after a change, doubling up to SLOW while nothing changes

/** Open (or bring into view) the Git window. */
export function openGit(r?: Rect) {
  if (win) { centerOn(win.el); ping(win.el); return }
  const meta = make('span', 'm')
  const { el, head, body } = makeWindow({
    kind: 'git', cls: 'gnode', title: 'git', minW: 300, minH: 200,
    rect: r ?? spotBeside(null, 380, 520),
    actions: [iconButton(ICON.reload, 'Refresh: read git status and pull requests again', () => reload(), 'grefresh'),
      iconButton(GH_ICON, 'GitHub: pull requests and issues (Shift+G)', () => openGitHub()),
      iconButton(ICON.x, 'Close', () => { clearInterval(win!.gh); clearTimeout(win!.poll); win!.stop.abort(); forget(el); el.remove(); win = undefined; changed() }, 'closebtn')],
  })
  el.dataset.id = 'git' // one per project: arrows and pins find it again after a reload
  head.querySelector('.t')!.after(meta)
  const list = make('div', 'glist'), note = make('p', 'gout gnote')
  body.append(note, list)
  definable(body, showRefs) // a diff's names (a change's, a commit's): click one for where it's used
  // refresh while it's visible and expanded: git status is cheap; GitHub is slow and rate-limited, so its own much
  // slower loop (and after pushes and commits)
  // poll only while you can see it: page visible, window open, and on screen (each poll runs git status on the server)
  const showing = () => watched(el)
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
  // a commit or push in the project's own repo can change its pull request; GitHub knows nothing of the nested ones here
  const host: Host = { refresh, redraw: () => { if (win?.st) draw(win.st) }, open: new Set() }
  // each repo's pull request, while you can see it: the window on screen, and its group open (or no groups)
  const ghTick = () => { if (showing()) for (const v of win!.views.values()) if (win!.single || isOpen(v)) v.gh.tick() }
  win = { el, meta, body, list, note, gh: setInterval(ghTick, 15_000), poll: 0, delay: FAST, stop, views: new Map(), single: true, host, last: '' }
  refresh()
  win.poll = setTimeout(tick, FAST)
  if (!r) centerOn(el) // a free spot can be off-screen: bring the new window into view
  changed()
}

/** A line above the lists for what isn't one repo's: the status couldn't be read, git init failed. */
function note(text: string, bad = false) { if (!win) return; win.note.textContent = text; win.note.classList.toggle('bad', bad) }

/** The refresh button: status read again past the server's few-second cache, drawn even when it's the same (open
 *  diffs are fetched again), and each pull request strip in view asked again. */
async function reload() {
  const w = win
  if (!w || w.el.ariaBusy) return
  w.el.ariaBusy = 'true'
  try {
    w.last = ''
    await refresh(true)
    for (const v of w.views.values()) if (w.single || isOpen(v)) v.gh.refresh()
  } finally { w.el.ariaBusy = null }
}

const UNREAD = 'Could not read git status: '
export async function refresh(fresh = false) {
  if (!win) return
  let st: GitState
  try { st = await api<GitState>(fresh ? 'git?fresh=1' : 'git') } catch (e) { return note(`${UNREAD}${(e as Error).message}`, true) }
  if (win.note.textContent?.startsWith(UNREAD)) note('') // that was an earlier fetch's error
  const sig = JSON.stringify(st)
  if (sig === win.last) { win.delay = Math.min(win.delay * 2, SLOW); return } // nothing changed: keep the DOM (and any open diffs)
  win.last = sig
  win.delay = FAST
  draw(st)
}

function draw(st: GitState) {
  const w = win!
  w.st = st
  if (st.missing) return empty('not installed', make('p', '', st.error!))
  const repos: [string, GitState][] = (st.nested ?? []).map(n => [n.dir!, n])
  if (st.repo) repos.unshift(['', { ...st, nested: undefined }])
  if (!repos.length) {
    return empty('not a repository', make('p', '', `${project.name} isn't a git repository yet.`), button('Initialize repository', 'primary', async () => {
      if (!await confirmBox('Initialize a git repository?', `Runs git init in ${project.root}. Nothing is committed until you commit.`, 'Initialize')) return
      const r = await post('git', { op: 'init' }).catch(e => ({ ok: false, out: (e as Error).message }))
      if (!r.ok) note(r.out ?? 'git init failed', true)
      refresh()
    }))
  }
  // each repo shows the checkout picked for it: its own, or one of its worktrees. A pick that's gone is forgotten; one
  // missing from a status or worktree list that couldn't be read is kept, and its repo's own shown meanwhile
  const shown = repos.map(([repo, s]): [string, string, GitState] => {
    const t = s.worktrees?.find(t => t.dir === picks[repo])
    if (!t && repo in picks && s.repo && !s.worktreesFailed) { delete picks[repo]; changed() }
    return t ? [t.dir!, repo, t] : [repo, repo, s]
  })
  // picking a worktree swaps the repo's view for another: its picker or fold button keeps the focus it had
  const was = [...w.views.values()].find(v => v.line.contains(document.activeElement))
  const ctl = was && (was.head === document.activeElement ? 'head' : 'pick')
  for (const dir of w.views.keys()) if (!shown.some(([d]) => d === dir)) w.views.delete(dir)
  const views = shown.map(([dir, repo, s]) => {
    let v = w.views.get(dir)
    if (!v) w.views.set(dir, v = repoView(dir, repo, w.host))
    const own = repos.find(([d]) => d === repo)![1]
    v.checkouts = own.worktrees?.length ? [own, ...own.worktrees] : []
    const sig = JSON.stringify([s, v.checkouts.length && own]) // the picker lists the repo's checkouts
    if (sig !== v.sig) { v.sig = sig; fill(v, s, w.host) } // only the repos that changed: the others keep their open diffs
    return v
  })
  const single = !st.nested?.length && !st.worktrees?.length // the project's own repo alone: its lists, no group around them
  if (single) {
    const sync = syncText(st)
    w.meta.textContent = `${st.branch}${sync ? ' ' + sync : ''}`
    w.meta.title = st.upstream ? `${st.ahead} commit(s) to push, ${st.behind} to pull` : 'No upstream branch yet: Push sets one up'
  } else {
    const busy = repos.filter(([, s]) => s.total).length
    const [[one, s1]] = repos, n = s1.worktrees?.length ?? 0
    // short: the tab's title shares its width (never "1 repos")
    w.meta.textContent = repos.length > 1 ? `${repos.length} repos` : `${repoName(one)}${n ? ` · ${n} worktree${n === 1 ? '' : 's'}` : ''}`
    w.meta.title = `${repos.length} git repositories in ${project.name}${st.repo ? ' and' : ''} its subfolders, ${busy} with changes`
  }
  w.single = single
  place(views, single)
  const now = was && !was.line.isConnected && views.find(v => v.repo === was.repo)
  if (now) (ctl === 'head' ? now.head : now.pick?.nextElementSibling as HTMLElement | undefined)?.focus()
  for (const v of w.views.values()) if (single || isOpen(v)) v.gh.wake()
}

/** Put the views in the window. Single: the repo's lists fill it and its commit box is the window's footer. Grouped:
 *  each repo is a group holding its own. Elements are moved only when they're out of place, so a commit message being
 *  typed keeps its focus through refreshes. */
function place(views: RepoView[], single: boolean) {
  const w = win!
  w.list.classList.toggle('grouped', !single)
  if (single && views[0].foot.parentElement !== w.body) w.body.append(views[0].foot)
  if (single && views[0].gh.el.parentElement !== w.body) w.body.prepend(views[0].gh.el)
  // a group's parts back in it, in order (only after the window had a single repo: this moves a focused field)
  if (!single) for (const v of views) if (v.el.childElementCount !== 4) v.el.replaceChildren(v.line, v.gh.el, v.files, v.foot)
  // the strip and footer of a repo that's gone, or now in a group
  for (const f of w.body.querySelectorAll(':scope > .gfoot, :scope > .ghstrip')) if (!single || (f !== views[0].foot && f !== views[0].gh.el)) f.remove()
  const want = single ? [views[0].files] : views.map(v => v.el)
  if (want.length !== w.list.childElementCount || want.some((e, i) => w.list.children[i] !== e)) w.list.replaceChildren(...want)
}

function empty(meta: string, ...content: (string | Node)[]) {
  const w = win!
  w.meta.textContent = meta
  w.meta.title = ''
  w.views.clear()
  for (const f of w.body.querySelectorAll(':scope > .gfoot, :scope > .ghstrip')) f.remove()
  const box = make('div', 'gempty')
  box.append(...content)
  w.list.classList.remove('grouped')
  w.list.replaceChildren(box)
}

type Saved = Partial<Rect> & { msg?: string; msgs?: Record<string, string>; folds?: Record<string, boolean>; wts?: Record<string, string> }

// the window's place (older layouts: that alone), the commit messages being written, even with the window closed
// (msg: the project's own repo; msgs: nested ones by folder), the repo groups you opened or closed, and the worktree
// each repo shows (wts)
persist('git', () => {
  const { '': msg, ...msgs } = drafts
  const saved: Saved = { ...(win ? savedRect(win.el) : {}), ...(msg ? { msg } : {}), ...(Object.keys(msgs).length ? { msgs } : {}), ...(Object.keys(folds).length ? { folds: { ...folds } } : {}), ...(Object.keys(picks).length ? { wts: { ...picks } } : {}) }
  return win || Object.keys(saved).length ? saved : null
}, (r: Saved | null) => {
  for (const k of Object.keys(drafts)) delete drafts[k]
  for (const k of Object.keys(folds)) delete folds[k]
  for (const k of Object.keys(picks)) delete picks[k]
  if (r?.msgs && typeof r.msgs === 'object') Object.assign(drafts, r.msgs)
  if (r?.msg) drafts[''] = r.msg
  if (r?.folds && typeof r.folds === 'object') Object.assign(folds, r.folds)
  if (r?.wts && typeof r.wts === 'object') Object.assign(picks, r.wts)
  if (r?.w) openGit(r as Rect)
})

// drop the Git window on a card: Claude gets the branch and what's changed in each repo (it can run git diff itself)
referable('git', {
  icon: '⎇',
  label: () => 'git status',
  content: async () => {
    const st = await api<GitState>('git')
    const repos = [...(st.repo ? [st] : []), ...(st.nested ?? []).filter(n => n.repo)]
    if (!repos.length) return { text: 'Git: this project is not a git repository.' }
    return { text: repos.map(describe).join('\n\n') }
  },
})

function describe(st: GitState) {
  const files = (st.files ?? []).map(f => `- ${f.x === '?' ? 'untracked' : [f.x !== ' ' && 'staged', f.y !== ' ' && 'unstaged'].filter(Boolean).join(' + ')}: ${f.path}`)
  const which = st.dir ? `the repository in ${st.dir}/` : 'the project'
  return `Git status of ${which}: branch ${st.branch}${st.ahead ? `, ${st.ahead} to push` : ''}${st.behind ? `, ${st.behind} to pull` : ''}.\n${files.join('\n') || 'Working tree clean.'}`
}
