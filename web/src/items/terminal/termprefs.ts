// The Settings panel's Terminal section: font, size and cursor (applied to open terminals at once) and the shell new
// ones start (from the machine's /etc/shells, which the server also checks). Saved in ~/.drawa/config.json.
import { api } from '../../lib/api';
import { $ } from '../../lib/dom';
import { onPrefs, type Prefs, prefs, setPrefs } from '../../lib/prefs';
import { enhance, segmented } from '../../lib/select';
import { TerminalCursor } from '../../types/terminal';

const SIZES = ['10', '11', '12', '13', '14', '15', '16', '18', '20', '24'];
const fontInput = $<HTMLInputElement>('#term-font'),
  sizeSelect = $<HTMLSelectElement>('#term-size'),
  cursorSelect = $<HTMLSelectElement>('#term-cursor'),
  shellSelect = $<HTMLSelectElement>('#term-shell');

const option = (value: string, textContent: string) =>
  Object.assign(document.createElement('option'), { value, textContent });

sizeSelect.replaceChildren(...SIZES.map(size => option(size, `${size} px`)));
cursorSelect.replaceChildren(
  option(TerminalCursor.Block, 'Block'),
  option(TerminalCursor.Bar, 'Bar'),
  option(TerminalCursor.Underline, 'Underline'),
);
shellSelect.replaceChildren(option('', 'Your login shell'));
enhance(sizeSelect);
segmented(cursorSelect);
enhance(shellSelect);

fontInput.onchange = () => setPrefs({ terminalFont: fontInput.value.trim() });
sizeSelect.onchange = () => setPrefs({ terminalFontSize: sizeSelect.value });
cursorSelect.onchange = () => setPrefs({ terminalCursor: cursorSelect.value as TerminalCursor });
shellSelect.onchange = () => setPrefs({ terminalShell: shellSelect.value });

/** Show the saved values in the controls. */
function sync(settings: Prefs) {
  if (document.activeElement !== fontInput) fontInput.value = settings.terminalFont;
  sizeSelect.value = settings.terminalFontSize;
  cursorSelect.value = settings.terminalCursor;
  shellSelect.value = settings.terminalShell;
}
onPrefs(sync);
sync(prefs());

// the shells this machine lists, asked for once
void api<{ shells?: string[] }>('term')
  .then(answer => {
    shellSelect.append(...(answer.shells ?? []).map(shell => option(shell, shell)));
    sync(prefs());
  })
  .catch(() => {});
