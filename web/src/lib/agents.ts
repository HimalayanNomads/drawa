// The agent backends the server has (GET /api/agents): which can run a card, which can write commit messages, and
// each one's models and commands (GET /api/meta?backend=). Loaded once at boot; pages from before backends existed
// behave as if Claude Code were the only one.
import { api } from './api'
import { make } from './dom'
import { enhance } from './select'

export interface Agent { name: string; title: string; blurb?: string; installed: boolean; install: string; modes: string[]; canWrite: boolean; canUnsend?: boolean; resume?: string; noEffort?: string; textOnly?: boolean }
export interface Model { value: string; displayName: string; description: string; efforts?: string[] } // efforts: levels it accepts (other agents; Claude's are EFFORTS)
export interface Meta { models: Model[]; commands: { name: string; description: string; argumentHint?: string }[]; usageUtil?: number; usageResetAt?: number; weeklyUtil?: number; weeklyResetAt?: number }

export let agents: Agent[] = []
export const agentsReady: Promise<void> = api<Agent[]>('agents').then(a => { agents = a }, () => {})

const TITLES: Record<string, string> = { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex', agy: 'Antigravity' }
/** What the page calls an agent: "Claude Code". */
export const title = (name: string) => agents.find(a => a.name === name)?.title || TITLES[name] || name
/** One line on what picking it means, for menus. */
export const blurb = (name: string) => agents.find(a => a.name === name)?.blurb ?? ''
/** How copy refers to it: "Claude is working", "OpenCode is working". */
export const who = (name: string) => title(name).replace(/ Code$/, '')
/** The copy button's tip for a session's id: how to open it in a terminal, when the agent says how. */
export function copySidTip(name: string, id: string) {
  const cmd = agents.find(a => a.name === name)?.resume ?? (name === 'claude' ? 'claude --resume' : '')
  return cmd ? `Copy session ID (open it with ${cmd} ${id})` : `Copy session ID (${id})`
}
export const installed = () => agents.filter(a => a.installed)
/** Whether a queued message can still be taken back (deleted, or edited) until the agent reads it. */
export const canUnsend = (name: string) => !!agents.find(a => a.name === name)?.canUnsend
/** Why an agent takes no effort from Drawa: a link, or '' when it takes one. */
export const noEffort = (name: string) => agents.find(a => a.name === name)?.noEffort ?? ''
/** Whether an agent takes text only (no pictures in a message). */
export const textOnly = (name: string) => !!agents.find(a => a.name === name)?.textOnly
/** The Drawa permission modes an agent supports (all, until the list has loaded). */
export const modesOf = (name: string) => agents.find(a => a.name === name)?.modes

/** A choice remembered in this browser ('' if none, or storage is off). */
export const getPref = (key: string) => { try { return localStorage.getItem(key) ?? '' } catch { return '' } }
export const setPref = (key: string, v: string) => { try { localStorage.setItem(key, v) } catch {} }
function pref(key: string, ok: (a: Agent) => boolean) {
  const usable = installed().filter(ok), v = getPref(key)
  if (v && usable.some(a => a.name === v)) return v
  return usable.find(a => a.name === 'claude')?.name ?? usable[0]?.name ?? 'claude'
}
/** The agent new sessions start with: the last one you picked (this browser). */
export const lastAgent = () => pref('drawa:agent', () => true)
export const setLastAgent = (v: string) => setPref('drawa:agent', v)
/** Who writes commit messages and pull request descriptions (Write with). */
export const writer = () => pref('drawa:writer', a => a.canWrite)
export const setWriter = (v: string) => setPref('drawa:writer', v)

const metas: Record<string, Meta> = {}, asked: Record<string, Promise<Meta>> = {}
/** An agent's models and commands, asked once (slow the first time: the server asks a fresh process). */
export function meta(name: string): Promise<Meta> {
  return asked[name] ??= api<Meta>('meta?backend=' + encodeURIComponent(name)).then(
    m => (metas[name] = { ...m, models: m.models ?? [], commands: m.commands ?? [] }),
    () => { delete asked[name]; return { models: [], commands: [] } })
}
/** What's loaded of it so far. */
export const metaNow = (name: string): Meta => metas[name] ?? { models: [], commands: [] }

/** A chevron that opens a list to pick from (New session ▾, Write with ▾). `repick`: picking the current one acts
 *  again. */
export function chooser(label: string, list: { value: string; text: string; desc?: string }[], value: string, onPick: (v: string) => void, repick = false) {
  const box = make('span', 'chooser'), sel = make('select')
  sel.setAttribute('aria-label', label)
  sel.title = label
  if (repick) sel.dataset.repick = ''
  sel.append(...list.map(o => Object.assign(make('option', '', o.text), { value: o.value, title: o.desc ?? '' })))
  sel.value = value
  sel.onchange = () => onPick(sel.value)
  box.append(sel)
  enhance(sel)
  return box
}
