// Code symbols: a project's functions, classes and the like, by name (internal/symbols, read with universal-ctags).
// Ctrl+K lists them and a diff's names lead to their definitions. "auto" uses ctags when it's installed, "off"
// never runs it; picked in the Settings panel and saved in your settings file (lib/prefs.ts). Without ctags every
// lookup is just empty, so callers never need to tell "not installed" from "nothing found".
import { $, make } from './dom'
import { api, q } from './api'
import { segmented } from './select'
import { prefs, onPrefs, setPrefs } from './prefs'

export interface CodeSymbol { name: string; path: string; line: number; kind: string; scope?: string }

let installed = false, install = ''
/** Lookups can answer: ctags is installed and the setting isn't off. */
export const symbolsOn = () => installed && prefs().symbols !== 'off'

const none = (): CodeSymbol[] => []
/** Definitions whose names match `query` loosely, best first (Ctrl+K). */
export const findSymbols = (query: string) =>
  symbolsOn() ? api<CodeSymbol[]>('symbols?q=' + q(query)).catch(none) : Promise.resolve(none())
/** Every definition named exactly `name` (go to definition). */
export const definitions = (name: string) =>
  symbolsOn() ? api<CodeSymbol[]>('symbols?def=' + q(name)).catch(none) : Promise.resolve(none())

const sel = $<HTMLSelectElement>('#symbols'), status = $('#symbols-status')
sel.replaceChildren(...([['auto', 'Auto'], ['off', 'Off']] as const)
  .map(([value, textContent]) => Object.assign(document.createElement('option'), { value, textContent })))
sel.onchange = () => setPrefs({ symbols: sel.value === 'off' ? 'off' : 'auto' })
segmented(sel)

function sync() {
  document.documentElement.dataset.symbols = symbolsOn() ? 'on' : 'off' // CSS shows a diff's definition box only when it can answer
  sel.value = prefs().symbols
  status.replaceChildren(...(prefs().symbols === 'off' ? ['Ctrl+K and diffs leave code symbols out.']
    : installed ? ['Ctrl+K lists functions, classes and more; click a name in a diff to see where it’s defined.']
    : ['universal-ctags not found. ', ...(install ? ['Run ', make('code', '', install), ', then reopen Settings.'] : ['Install it from ctags.io, then reopen Settings.'])]))
}
// asked at boot and each time Settings opens, so installing ctags needs no restart
const check = () => api<{ installed: boolean, install?: string }>('symbols').then(r => { installed = r.installed; install = r.install ?? ''; sync() }, () => {})
$('#btn-settings').addEventListener('click', () => { if (!$('#settings').hidden) check() })
onPrefs(sync)
sync()
check()
