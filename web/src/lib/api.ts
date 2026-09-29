// JSON endpoints served by the Go server.
import { takeOver } from './tabs'

export interface TreeItem { name: string; dir: boolean; more?: number } // more: a folder's last row, standing for N entries not sent
export interface SessionInfo { id: string; title: string; mtime: number; backend?: string }
export interface SavedMessage { role: 'user' | 'assistant'; content: string | ContentBlock[] }
export interface ContentBlock {
  type: string
  id?: string
  name?: string
  text?: string
  thinking?: string
  input?: unknown
  tool_use_id?: string
  content?: string | { text?: string }[]
  is_error?: boolean
}

/** The JSON answer; a failed request throws an Error with the status in its message, and the answer's JSON as `body`
 *  (e.g. `{ missing: true }`). */
async function answer(r: Response) {
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(`${j.error || r.statusText || 'Request failed'} (${r.status})`), { status: r.status, body: j })
  return j
}

export const api = <T>(path: string): Promise<T> => fetch('/api/' + path).then(answer)

export async function post(path: string, body: object) {
  if (path === 'send') takeOver() // replies stream to the tab that owns this server: sending from here takes over
  return fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(answer)
}

export const q = encodeURIComponent
