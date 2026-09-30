// Global fonts: interface (--sans) and code (--mono), chosen in the toolbar's Settings panel. Remembered per browser.
import { $ } from './dom'
import { enhance } from './select'

// Fonts Excalidraw ships (self-hosted under /excalidraw/fonts by the postinstall step): single-file faces only.
const faces = document.head.appendChild(document.createElement('style'))
faces.textContent = [['Virgil', 'Virgil/Virgil-Regular'], ['Cascadia Code', 'Cascadia/CascadiaCode-Regular'], ['Assistant', 'Assistant/Assistant-Regular']]
  .map(([name, file]) => `@font-face{font-family:"${name}";src:url(/excalidraw/fonts/${file}.woff2) format("woff2");font-display:swap}`).join('\n')

const UI: [string, string][] = [
  ['Inter', '"Inter Variable",system-ui,sans-serif'],
  ['System', 'system-ui,sans-serif'],
  ['Assistant', '"Assistant",system-ui,sans-serif'],
  ['Serif', 'ui-serif,Georgia,"Times New Roman",serif'],
  ['Hand-drawn (Virgil)', '"Virgil",system-ui,sans-serif'],
  ['Monospace', '"JetBrains Mono Variable",ui-monospace,monospace'],
  ['Custom font…', 'custom'],
]
const CODE: [string, string][] = [
  ['JetBrains Mono', '"JetBrains Mono Variable",ui-monospace,monospace'],
  ['Cascadia Code', '"Cascadia Code",ui-monospace,monospace'],
  ['System mono', 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'],
  ['Custom font…', 'custom'],
]
const KEY = 'drawa:fonts'
interface Choice { ui: string; uiCustom: string; code: string; codeCustom: string }
const load = (): Choice => {
  try { return { ui: UI[0][1], uiCustom: '', code: CODE[0][1], codeCustom: '', ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } }
  catch { return { ui: UI[0][1], uiCustom: '', code: CODE[0][1], codeCustom: '' } }
}
let choice = load()

/** A custom name is any font installed on this machine; fall back to the default stack if it's missing. */
const family = (value: string, custom: string, fallback: string) =>
  value === 'custom' ? (custom.trim() ? `"${custom.trim().replace(/"/g, '')}",${fallback}` : fallback) : value

function apply() {
  const root = document.documentElement.style
  root.setProperty('--sans', family(choice.ui, choice.uiCustom, UI[0][1]))
  root.setProperty('--mono', family(choice.code, choice.codeCustom, CODE[0][1]))
  try { localStorage.setItem(KEY, JSON.stringify(choice)) } catch {}
}

/* ---------- its controls in the Settings panel ---------- */
function wire(sel: HTMLSelectElement, input: HTMLInputElement, list: [string, string][], key: 'ui' | 'code') {
  sel.replaceChildren(...list.map(([label, value]) => Object.assign(document.createElement('option'), { textContent: label, value })))
  const customKey = key === 'ui' ? 'uiCustom' : 'codeCustom'
  sel.value = list.some(([, v]) => v === choice[key]) ? choice[key] : list[0][1]
  input.value = choice[customKey]
  const sync = () => { input.hidden = sel.value !== 'custom' }
  sel.onchange = () => { choice[key] = sel.value; sync(); apply(); if (sel.value === 'custom') input.focus() }
  input.oninput = () => { choice[customKey] = input.value; apply() }
  input.onkeydown = e => e.stopPropagation() // typing a font name isn't a canvas shortcut
  sync()
  enhance(sel)
}
wire($<HTMLSelectElement>('#font-ui'), $<HTMLInputElement>('#font-ui-custom'), UI, 'ui')
wire($<HTMLSelectElement>('#font-code'), $<HTMLInputElement>('#font-code-custom'), CODE, 'code')

apply()
