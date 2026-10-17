// The completion alert, saved through the shared preferences flow (including rollback and cross-tab updates).
import { CompletionMode } from '../types/prefs';
import { $ } from './dom';
import { onPrefs, prefs, setPrefs } from './prefs';
import { enhance } from './select';

const completionOptions = [
  // ponytail: sound playback belongs to #151; keep the choice unavailable until that feature lands.
  { value: 'sound', textContent: 'Play sound', disabled: true },
  { value: CompletionMode.Toast, textContent: 'Show alerts' },
  { value: CompletionMode.None, textContent: 'Do nothing' },
];
const select = $<HTMLSelectElement>('#completion');
select.replaceChildren(...completionOptions.map(option => Object.assign(document.createElement('option'), option)));
select.onchange = () => setPrefs({ completion: select.value as CompletionMode });
enhance(select);
const sync = () => (select.value = prefs().completion);
onPrefs(sync);
sync();
