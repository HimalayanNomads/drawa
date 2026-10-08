// Light / dark mode (the toolbar button, or System to follow the computer's) and a color scheme for each, picked in
// the Settings panel and saved in your settings file (lib/prefs.ts). The palettes are in styles/schemes.css; this
// module puts the choice on <html data-theme data-scheme>. The inline script in index.html applies the last one seen
// before first paint; keep its defaults in sync.
import { $, ICON } from './dom'
import { enhance, segmented } from './select'
import { command } from './keys'
import { prefs, onPrefs, setPrefs, type Prefs } from './prefs'

type Mode = 'light' | 'dark'
/** [id in schemes.css, label]. First of each list is the default. */
const SCHEMES: Record<Mode, [string, string][]> = {
  light: [['claude-light', 'Drawa'], ['rose-pine-dawn', 'Rosé Pine Dawn'], ['catppuccin-latte', 'Catppuccin Latte'], ['tokyo-night-day', 'Tokyo Night Day'],
    ['gruvbox-light', 'Gruvbox Light'], ['solarized-light', 'Solarized Light'], ['github-light', 'GitHub Light']],
  dark: [['claude-dark', 'Drawa'], ['rose-pine', 'Rosé Pine'], ['rose-pine-moon', 'Rosé Pine Moon'], ['catppuccin-mocha', 'Catppuccin Mocha'],
    ['catppuccin-macchiato', 'Catppuccin Macchiato'], ['catppuccin-frappe', 'Catppuccin Frappé'], ['tokyo-night', 'Tokyo Night'], ['tokyo-night-storm', 'Tokyo Night Storm'],
    ['gruvbox-dark', 'Gruvbox Dark'], ['nord', 'Nord'], ['kanagawa', 'Kanagawa'], ['everforest', 'Everforest']],
}
const option = (value: string, textContent: string) => Object.assign(document.createElement('option'), { value, textContent })
const system = matchMedia('(prefers-color-scheme: dark)')
const mode = (): Mode => { const t = prefs().theme; return t === 'light' || t === 'dark' ? t : system.matches ? 'dark' : 'light' }
/** The scheme picked for a mode, or its first when the settings file names one this version doesn't have. */
const scheme = (m: Mode) => { const s = m === 'dark' ? prefs().darkScheme : prefs().lightScheme; return SCHEMES[m].some(([id]) => id === s) ? s : SCHEMES[m][0][0] }

export const isDark = () => mode() === 'dark'
const listeners: (() => void)[] = []
/** Called after the mode or scheme changes (for things drawn with theme colors baked in). */
export const onTheme = (f: () => void) => listeners.push(f)

const btn = $('#btn-theme'), pick = $<HTMLSelectElement>('#theme-mode')
const pickers: Record<Mode, HTMLSelectElement> = { light: $('#scheme-light'), dark: $('#scheme-dark') }
let shown = '' // the mode and scheme on the page: only a real change redraws what has colors baked in

function apply() {
  const m = mode(), s = scheme(m), root = document.documentElement
  root.dataset.theme = m
  root.dataset.scheme = s
  btn.innerHTML = m === 'dark' ? ICON.moon : ICON.sun
  btn.title = `Switch to ${m === 'dark' ? 'light' : 'dark'} mode`
  btn.setAttribute('aria-label', btn.title)
  pick.value = prefs().theme
  for (const k of ['light', 'dark'] as Mode[]) pickers[k].value = scheme(k)
  if (shown && shown !== `${m} ${s}`) listeners.forEach(f => f())
  shown = `${m} ${s}`
}
btn.onclick = () => setPrefs({ theme: isDark() ? 'light' : 'dark' })
command({ label: 'Switch light / dark mode', group: 'Canvas', run: () => btn.click() })

pick.replaceChildren(option('system', 'System'), option('light', 'Light'), option('dark', 'Dark'))
pick.onchange = () => setPrefs({ theme: pick.value as Prefs['theme'] })
segmented(pick)
// one scheme picker per mode; picking one also switches to that mode so you see it
for (const m of ['light', 'dark'] as Mode[]) {
  const sel = pickers[m]
  sel.replaceChildren(...SCHEMES[m].map(([id, label]) => option(id, label)))
  sel.onchange = () => setPrefs(m === 'dark' ? { theme: m, darkScheme: sel.value } : { theme: m, lightScheme: sel.value })
  enhance(sel)
}
system.addEventListener('change', apply) // on System: follow the computer when it switches
onPrefs(apply)
apply()
