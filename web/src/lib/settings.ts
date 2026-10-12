// The toolbar's Settings panel (the gear): appearance, editor, completion alerts and fonts.
// Each setting's module fills in its own controls; this one opens and
// closes the panel.
import './completion';
import { $ } from './dom';
import { command } from './keys';

const panel = $('#settings'),
  btn = $('#btn-settings');
/** Open or close the Settings panel. */
const setOpen = (open: boolean) => {
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
};
btn.onclick = () => setOpen(panel.hidden === true);
command({ label: 'Settings: theme, interface, fonts', group: 'Canvas', run: () => setOpen(true) });
addEventListener('pointerdown', e => {
  if (!panel.hidden && !(e.target as Element).closest('#settings, #btn-settings, .xsel-menu')) setOpen(false);
});
command({
  label: 'Close Settings',
  group: 'Canvas',
  keys: ['Escape'],
  when: () => !panel.hidden,
  key: () => {
    setOpen(false);
    btn.focus();
  },
});
