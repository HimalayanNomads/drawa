// Light / dark mode (toolbar button) and a color scheme for each (Appearance panel). The palettes are in
// styles/schemes.css; this module puts the choice on <html data-theme data-scheme> and remembers it.
// The inline script in index.html applies the saved choice before first paint; keep its defaults in sync.
import { $, ICON } from './dom'
import { enhance } from './select'

type Mode = 'light' | 'dark'
/** [id in schemes.css, label]. First of each list is the default. */
const SCHEMES: Record<Mode, [string, string][]> = {
  light: [['claude-light', 'Drawa'], ['rose-pine-dawn', 'Rosé Pine Dawn'], ['catppuccin-latte', 'Catppuccin Latte'], ['tokyo-night-day', 'Tokyo Night Day'],
    ['gruvbox-light', 'Gruvbox Light'], ['solarized-light', 'Solarized Light'], ['github-light', 'GitHub Light']],
  dark: [['claude-dark', 'Drawa'], ['rose-pine', 'Rosé Pine'], ['rose-pine-moon', 'Rosé Pine Moon'], ['catppuccin-mocha', 'Catppuccin Mocha'],
    ['catppuccin-macchiato', 'Catppuccin Macchiato'], ['catppuccin-frappe', 'Catppuccin Frappé'], ['tokyo-night', 'Tokyo Night'], ['tokyo-night-storm', 'Tokyo Night Storm'],
    ['gruvbox-dark', 'Gruvbox Dark'], ['nord', 'Nord'], ['kanagawa', 'Kanagawa'], ['everforest', 'Everforest']],
}
const KEY = 'drawa:theme'
interface Choice { mode: Mode; light: string; dark: string }
const load = (): Choice => {
  const d: Choice = { mode: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', light: SCHEMES.light[0][0], dark: SCHEMES.dark[0][0] }
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return { ...d, ...(s && typeof s === 'object' ? s : {}) } } catch { return d }
}
const choice = load()

export const isDark = () => choice.mode === 'dark'
const listeners: (() => void)[] = []
/** Called after the mode or scheme changes (for things drawn with theme colors baked in). */
export const onTheme = (f: () => void) => listeners.push(f)

const btn = $('#btn-theme')

function apply(notify = true) {
  const root = document.documentElement
  root.dataset.theme = choice.mode
  root.dataset.scheme = choice[choice.mode]
  btn.innerHTML = choice.mode === 'dark' ? ICON.moon : ICON.sun
  btn.title = `Switch to ${choice.mode === 'dark' ? 'light' : 'dark'} mode`
  btn.setAttribute('aria-label', btn.title)
  try { localStorage.setItem(KEY, JSON.stringify(choice)) } catch {}
  if (notify) listeners.forEach(f => f())
}
btn.onclick = () => { choice.mode = isDark() ? 'light' : 'dark'; apply() }

// one scheme picker per mode; picking one also switches to that mode so you see it
for (const mode of ['light', 'dark'] as Mode[]) {
  const sel = $<HTMLSelectElement>(`#scheme-${mode}`)
  sel.replaceChildren(...SCHEMES[mode].map(([id, label]) => Object.assign(document.createElement('option'), { value: id, textContent: label })))
  if (!SCHEMES[mode].some(([id]) => id === choice[mode])) choice[mode] = SCHEMES[mode][0][0]
  sel.value = choice[mode]
  sel.onchange = () => { choice[mode] = sel.value; choice.mode = mode; apply() }
  enhance(sel)
}
apply(false)
