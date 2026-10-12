// The completion alert, saved through the shared preferences flow (including rollback and cross-tab updates).
import { CompletionMode } from '../types/prefs';
import { $ } from './dom';
import { onPrefs, prefs, setPrefs } from './prefs';
import { enhance } from './select';

const select = $<HTMLSelectElement>('#completion');
select.replaceChildren(
  // ponytail: sound playback belongs to #151; keep the choice unavailable until that feature lands.
  Object.assign(document.createElement('option'), { value: 'sound', textContent: 'Play sound', disabled: true }),
  ...[
    [CompletionMode.Browser, 'Show browser'],
    [CompletionMode.Toast, 'Show toast'],
    [CompletionMode.None, 'Do nothing'],
  ].map(([value, textContent]) => Object.assign(document.createElement('option'), { value, textContent })),
);
select.onchange = () => setPrefs({ completion: select.value as CompletionMode });
enhance(select);
const sync = () => (select.value = prefs().completion);
onPrefs(sync);
sync();
