// Shell mode: a message starting with "!" runs as a shell command in the project folder, like the terminal's
// bash mode. Output streams into the card; command and output go to Claude with your next message, in the CLI's own
// <bash-input> / <bash-stdout> format, unless you take them out (×).
import { make, ICON, iconButton, clip } from '../lib/dom'
import { put, follow, type Session } from './session'

interface Run { cmd: string; out: string; code: number | null; box: HTMLElement }
const unsent = new WeakMap<Session, Run[]>() // finished runs waiting to go with the next message
const SHOW = 200_000, SHARE = 30_000 // characters kept on screen / sent to Claude per run
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

/** A shell block in the log (also used to show past runs when a session is reopened). */
function block(S: Session, cmd: string) {
  const box = make('div', 'shell'), head = make('div', 'sh-h'), out = make('pre', 'sh-o'), note = make('span', 'sh-note')
  head.append(make('code', 'sh-cmd', cmd), note)
  box.append(head, out)
  return { box: S.replaying ? (S.log.append(box), box) : put(S, box), head, out, note }
}

export async function runShell(S: Session, cmd: string) {
  S.log.querySelector('.empty')?.remove()
  const { box, head, out, note } = block(S, cmd)
  box.classList.add('live')
  note.textContent = 'running'
  const ctrl = new AbortController()
  const stop = iconButton(ICON.stop, 'Stop this command', () => ctrl.abort(), 'sh-stop')
  head.append(stop)
  const run: Run = { cmd, out: '', code: null, box }
  try {
    const res = await fetch('/api/shell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }), signal: ctrl.signal })
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`)
    const rd = res.body.getReader(), dec = new TextDecoder()
    let raw = ''
    for (;;) {
      const { done, value } = await rd.read()
      if (done) break
      raw += dec.decode(value, { stream: true })
      const end = raw.indexOf('\0')
      run.out = (end < 0 ? raw : raw.slice(0, end)).replace(ANSI, '')
      if (end >= 0) run.code = JSON.parse(raw.slice(end + 1) || '{}').exit ?? null
      out.textContent = run.out.length > SHOW ? '… (earlier output hidden)\n' + run.out.slice(-SHOW) : run.out
      out.scrollTop = out.scrollHeight
      follow(S)
    }
  } catch (e) {
    run.out += (run.out ? '\n' : '') + ((e as Error).name === 'AbortError' ? '(stopped)' : `Could not run: ${(e as Error).message}`)
    out.textContent = run.out
  }
  stop.remove()
  box.classList.remove('live')
  box.classList.add(run.code === 0 ? 'ok' : 'bad')
  if (!out.textContent) out.textContent = '(no output)'
  // pending for the next message; × keeps it out
  note.textContent = `${run.code == null ? 'stopped' : `exit ${run.code}`} · sent with next message`
  const drop = iconButton(ICON.x, 'Don’t send this to Claude', () => {
    drop.remove()
    const list = unsent.get(S) ?? []
    list.splice(list.indexOf(run), 1)
    note.textContent = `${run.code == null ? 'stopped' : `exit ${run.code}`} · not sent to Claude`
    box.classList.add('private')
  }, 'sh-drop')
  head.append(drop)
  unsent.set(S, [...(unsent.get(S) ?? []), run])
}

/** The shell runs to prepend to the message being sent (the CLI's format), marking them sent. '' if none. */
export function takeShell(S: Session): string {
  const runs = unsent.get(S) ?? []
  unsent.delete(S)
  for (const r of runs) {
    r.box.querySelector('.sh-drop')?.remove()
    r.box.querySelector('.sh-note')!.textContent = `${r.code == null ? 'stopped' : `exit ${r.code}`} · sent to Claude`
  }
  return runs.map(r => {
    const o = clip(r.out, SHARE)
    return `<bash-input>${r.cmd}</bash-input>\n<bash-stdout>${o}</bash-stdout><bash-stderr></bash-stderr>\n\n`
  }).join('')
}

/** A reopened session: user text that starts with shell runs shows them as blocks; returns the rest of the text. */
export function replayShell(S: Session, text: string): string {
  const re = /<bash-input>([\s\S]*?)<\/bash-input>\s*(?:<bash-stdout>([\s\S]*?)<\/bash-stdout>)?\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*/y
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(text))) {
    const { box, out, note } = block(S, m[1])
    out.textContent = ((m[2] ?? '') + (m[3] ?? '')) || '(no output)'
    note.textContent = 'sent to Claude'
    box.classList.add('ok')
    text = text.slice(re.lastIndex)
    re.lastIndex = 0
  }
  return text.trim()
}
