// The agent backends the server has (GET /api/agents): which can run a card, which can write commit messages, and
// each one's models and commands (GET /api/meta?backend=). Loaded once at boot; pages from before backends existed
// behave as if Claude Code were the only one.
import { api } from './api'
import { make } from './dom'
import { enhance } from './select'

export interface Agent { name: string; title: string; installed: boolean; install: string; modes: string[]; canWrite: boolean }
export interface Model { value: string; displayName: string; description: string }
export interface Meta { models: Model[]; commands: { name: string; description: string; argumentHint?: string }[] }

export let agents: Agent[] = []
export const agentsReady: Promise<void> = api<Agent[]>('agents').then(a => { agents = a }, () => {})

const TITLES: Record<string, string> = { claude: 'Claude Code', opencode: 'OpenCode' }
/** What the page calls an agent: "Claude Code". */
export const title = (name: string) => agents.find(a => a.name === name)?.title || TITLES[name] || name
const BLURBS: Record<string, string> = {
  claude: 'Your Claude subscription, through the claude CLI',
  opencode: 'Any provider you set up in OpenCode, or its free models',
}
/** One line on what picking it means, for menus. */
export const blurb = (name: string) => BLURBS[name] ?? ''
/** How copy refers to it: "Claude is working", "OpenCode is working". */
export const who = (name: string) => title(name).replace(/ Code$/, '')
export const installed = () => agents.filter(a => a.installed)
/** The Drawa permission modes an agent supports (all, until the list has loaded). */
export const modesOf = (name: string) => agents.find(a => a.name === name)?.modes

function pref(key: string, ok: (a: Agent) => boolean) {
  const usable = installed().filter(ok)
  try { const v = localStorage.getItem(key); if (v && usable.some(a => a.name === v)) return v } catch {}
  return usable.find(a => a.name === 'claude')?.name ?? usable[0]?.name ?? 'claude'
}
const setPref = (key: string, v: string) => { try { localStorage.setItem(key, v) } catch {} }
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
    m => (metas[name] = { models: m.models ?? [], commands: m.commands ?? [] }),
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
