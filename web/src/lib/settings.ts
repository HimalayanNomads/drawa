// The toolbar's Settings panel (the gear): theme, interface, fonts, and which key sends a message. Each setting's
// module fills in its own controls (theme, uimode, fonts, sendkey); this one opens and closes the panel.
import { $ } from './dom'
import { command } from './keys'

const panel = $('#settings'), btn = $('#btn-settings')
const setOpen = (open: boolean) => { panel.hidden = !open; btn.setAttribute('aria-expanded', String(open)) }
btn.onclick = () => setOpen(panel.hidden === true)
command({ label: 'Settings: theme, interface, fonts', group: 'Canvas', run: () => setOpen(true) })
addEventListener('pointerdown', e => {
  if (!panel.hidden && !(e.target as Element).closest('#settings, #btn-settings, .xsel-menu')) setOpen(false)
})
addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !e.defaultPrevented) { e.preventDefault(); setOpen(false); btn.focus() } })
