// The interface, picked in the Settings panel or from Ctrl+K and saved in your settings file (lib/prefs.ts): "full"
// shows every window's tab, "minimal" only the tab of the window you reach for (styles/window.css keys off
// <html data-ui>). The inline script in index.html applies the last one seen before first paint.
import { $ } from './dom'
import { segmented } from './select'
import { command } from './keys'
import { prefs, onPrefs, setPrefs } from './prefs'

export const minimalUI = () => prefs().ui === 'minimal'
const listeners: (() => void)[] = []
/** Called after the interface switches between full and minimal (arrows move to the windows' new edges). */
export const onUIMode = (f: () => void) => void listeners.push(f)

const sel = $<HTMLSelectElement>('#ui-mode')
sel.replaceChildren(...([['full', 'Full'], ['minimal', 'Minimal']] as const)
  .map(([value, textContent]) => Object.assign(document.createElement('option'), { value, textContent })))
sel.onchange = () => setPrefs({ ui: sel.value === 'minimal' ? 'minimal' : 'full' })
segmented(sel)
command({ label: 'Switch minimal / full interface', group: 'Canvas', run: () => setPrefs({ ui: minimalUI() ? 'full' : 'minimal' }) })

function apply() {
  const ui = prefs().ui, root = document.documentElement
  sel.value = ui
  if (root.dataset.ui === ui) return
  root.dataset.ui = ui
  listeners.forEach(f => f())
}
onPrefs(apply)
apply()
