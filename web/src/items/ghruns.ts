// GitHub Actions in the GitHub window: a pull request's checks (logs, re-run failed jobs), the Actions tab (recent
// workflow runs, re-run), and polling while something is still running.
import { make, button, extLink, ago } from '../lib/dom'
import { api, q } from '../lib/api'
import { watched } from '../canvas/canvas'
import { dot, publish, type Check, type Run } from './gh'
import { win, still, topBar, pages, https, type View } from './github'

const POLL = 20_000

/** Run `tick` every 20s while the window still shows view `v` and `pending()` holds; stops by itself after that. Asks
 *  GitHub only while the window can be seen (plain short requests: no stream of its own). */
export function whilePending(v: View, pending: () => boolean, tick: () => Promise<void>) {
  const w = win!
  const loop = () => setTimeout(async () => {
    if (!still(w, v)) return
    if (watched(w.el)) await tick().catch(() => {}) // a failed poll: try again next time
    if (still(w, v) && pending()) loop()
  }, POLL)
  if (pending()) loop()
}

const runOf = (url: string) => /\/actions\/runs\/(\d+)/.exec(url)?.[1]

/** Re-run a workflow run (only its failed jobs, or all of it), after asking. */
async function rerun(run: string, failed: boolean, name: string) {
  const what = failed ? `Re-run the failed jobs of ${name} (workflow run ${run}).` : `Re-run all of ${name} (workflow run ${run}).`
  return !!await publish(failed ? 'Re-run failed jobs?' : 'Re-run this workflow?', what + '\n\nThis starts GitHub Actions jobs again, which uses the repo\'s Actions minutes.', 'Re-run', { op: 'rerun', run, failed }, 'Re-run started. It shows up here in a moment.')
}

const rerunButton = (run: string, failed: boolean, name: string) => {
  const b = button(failed ? 'Re-run failed' : 'Re-run', '', async () => { if (await rerun(run, failed, name)) { b.disabled = true; b.textContent = 'Started' } })
  return b
}

/** A pull request's checks, failures first; an Actions failure can show its log and re-run its failed jobs. */
export function checkList(checks: Check[]) {
  if (!checks.length) return [make('p', 'ghnote', 'No checks ran on this pull request.')]
  const order = { fail: 0, pending: 1, pass: 2, skip: 3 }
  const offered = new Set<string>() // one Re-run per workflow run, on its first failing job
  return [...checks].sort((a, b) => order[a.state] - order[b.state]).map(c => {
    const r = make('div', 'ghcheck')
    r.dataset.state = c.state
    r.append(dot(c.state), https(c.url) ? extLink('ghcheck-n', c.name, c.url) : make('span', 'ghcheck-n', c.name), make('span', 'ghcheck-s', c.state))
    const run = runOf(c.url)
    if (c.state === 'fail' && run) {
      const pre = make('pre', 'ghlog')
      r.append(button('Show log', '', async () => {
        pre.textContent = 'Loading…'
        r.after(pre)
        pre.textContent = await api<{ log: string }>(`gh/log?url=${q(c.url)}`).then(x => x.log || '(empty)', e => (e as Error).message)
      }))
      if (!offered.has(run)) { offered.add(run); r.append(rerunButton(run, true, c.name.split(' / ')[0])) }
    }
    return r
  })
}

/* ---------- the Actions tab ---------- */
export function runList() {
  const w = win!, v = w.view, rows = make('div', 'ghlist')
  w.body.replaceChildren(topBar(), rows)
  let shown: Run[] = []
  const get = (limit: number) => api<Run[]>(`gh/runs?limit=${limit}`).then(r => (shown = r.slice(0, limit), r))
  pages(rows, get, runRow, 'No workflow runs in this repo yet.').then(() =>
    // running ones settle on their own: redraw the list while any still runs (keeping how far you loaded)
    whilePending(v, () => shown.some(r => r.state === 'pending'), () => pages(rows, get, runRow, '')))
}

function runRow(r: Run) {
  const row = make('div', 'ghrun'), top = make('span', 'ghrow-t'), sub = make('span', 'ghrow-m')
  row.dataset.state = r.state
  top.append(dot(r.state), https(r.url) ? extLink('ghti', r.title, r.url) : make('span', 'ghti', r.title))
  sub.append(`${r.workflow} · ${r.branch} · ${r.event} · ${r.state === 'pending' ? 'running' : r.conclusion || r.state} · ${ago(r.created)}${r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}`)
  const text = make('span', 'ghrun-t')
  text.append(top, sub)
  row.append(text)
  if (r.state !== 'pending') row.append(rerunButton(String(r.id), r.state === 'fail', `${r.workflow}: ${r.title}`))
  return row
}
