// JSON endpoints served by the Go server.

export interface TreeItem { name: string; dir: boolean }
export interface SessionInfo { id: string; title: string; mtime: number }
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

export async function api<T>(path: string): Promise<T> {
  const r = await fetch('/api/' + path)
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || r.status)
  return j
}

export const post = (path: string, body: object) =>
  fetch('/api/' + path, { method: 'POST', body: JSON.stringify(body) }).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json() })

export const q = encodeURIComponent
