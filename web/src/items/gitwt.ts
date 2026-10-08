// A repo's worktrees in the Git window: the dropdown that picks which checkout its group shows, and removing one.
import { make, ICON, confirmBox, toast, project } from '../lib/dom'
import { changed } from '../canvas/canvas'
import { enhance } from '../lib/select'
import { gitPost, picks, wtFolder, type GitState, type Host, type RepoView } from './gitrepo'

/** A checkout's branch, or the commit it's on when detached. */
const branchOf = (st: GitState) => !st.branch || /no branch|detached|^HEAD/i.test(st.branch) ? `detached ${st.head?.slice(0, 7) ?? ''}`.trim() : st.branch

/** The repo's checkouts as a dropdown: its own, then those with changes, then by branch. Picking one shows it here. */
export function picker(v: RepoView, host: Host) {
  const own = v.checkouts[0], id = (c: GitState) => c.dir ?? '' // the project's own repo has none
  const list = [own, ...v.checkouts.slice(1).sort((a, b) => +!a.total - +!b.total || branchOf(a).localeCompare(branchOf(b)))]
  // rows look up the latest fill's checkouts: the options are replaced on every refresh
  const find = (o: HTMLOptionElement) => v.checkouts.find(c => id(c) === o.value)
  // paths read from the folder holding the repo, so rows differ where they matter: drawa, drawa-wt-1, drawa/.worktrees/x
  const abs = (d: string) => !d ? project.root : d.startsWith('/') ? d : `${project.root}/${d}`
  const shown = (p: string) => { const up = abs(v.repo).replace(/\/[^/]+$/, ''); return up && p.startsWith(up + '/') ? p.slice(up.length + 1) : p }
  if (!v.pick) {
    v.pick = make('select')
    v.pick.setAttribute('aria-label', 'Checkout shown: the repository or one of its worktrees')
    v.pick.title = 'Checkout shown'
    v.pick.onchange = () => {
      if (v.pick!.value === v.repo) delete picks[v.repo]; else picks[v.repo] = v.pick!.value
      changed()
      host.redraw()
    }
    const sel = v.pick
    const box = make('span', 'gpick')
    box.append(sel)
    enhance(sel, {
      row: o => {
        const c = find(o)
        if (!c) return []
        const top = make('div', 'gpt'), dir = make('div', 'gpf'), mine = c === v.checkouts[0]
        top.append(make('span', 'gpb', branchOf(c)), ...(mine ? [make('span', 'gpl', 'repo')] : []), ...(c.locked ? [make('span', 'gpl', 'locked')] : []),
          ...(c.total ? [make('span', 'gpn', `${c.total} changed`)] : []))
        const path = abs(mine ? v.repo : c.dir!)
        dir.append(make('span', '', shown(path)))
        dir.title = path
        return [top, dir]
      },
      // a worktree's name is its folder (drawa-wt-1), shown on its row; its branch and full path match too
      search: o => { const c = find(o); if (!c) return ''; const p = abs(c === v.checkouts[0] ? v.repo : c.dir!); return `${shown(p)} ${branchOf(c)} ${p}` },
      searchFrom: 1,
      prefix: () => 'Worktree:',
      empty: 'No worktrees match',
      action: o => {
        const c = find(o)
        return !c || c === v.checkouts[0] || c.locked ? null : { icon: ICON.trash, label: `Remove worktree ${branchOf(c)}`, run: () => removeWorktree(c, host) }
      },
    })
  }
  v.pick.replaceChildren(...list.map(c => Object.assign(make('option', '', branchOf(c)), { value: id(c) })))
  v.pick.value = v.dir
  return v.pick.parentElement!
}

// No Undo here, unlike other removals: git deletes the folder, and changes in it that weren't committed are gone.
async function removeWorktree(c: GitState, host: Host) {
  const what = `${c.dir} (branch ${branchOf(c)})`
  if (!await confirmBox('Remove this worktree?', `Deletes the folder ${what}. The branch and its commits are kept.`, 'Remove')) return
  let r = await gitPost({ op: 'worktree-remove', repo: c.dir, force: false })
  // dirty: the server's word; the regex reads git's text for servers from before the field
  if (!r.ok && (r.dirty ?? /modified|untracked|uncommitted|dirty|--force/i.test(r.out ?? r.error ?? ''))) {
    if (!await confirmBox('Remove it anyway?', `${what} has uncommitted or untracked changes that will be lost.`, 'Remove and lose changes')) return
    r = await gitPost({ op: 'worktree-remove', repo: c.dir, force: true })
  }
  if (r.ok) toast(`Removed the worktree ${wtFolder(c.dir!)}.`)
  else toast(r.out || r.error || 'Removing the worktree failed')
  host.refresh() // a picked one that's gone falls back to its repo's own checkout
}
