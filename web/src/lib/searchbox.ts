// A search box over a list of result buttons, as the drawer's panes use: it asks once typing pauses, Enter opens the
// first result of what's typed, arrow keys step through the results, and Escape clears the box, then leaves it.

/** What a search box searches and where its results are. */
export type SearchBoxSpec = {
  /** how long typing must pause before a search */
  delayMs: number;
  /** searches the box's query and draws the results; false when it didn't (it failed, or a newer search took over) */
  search: () => Promise<boolean>;
  /** holds the results */
  results: HTMLElement;
  /** which elements in it are results (default: its buttons) */
  rowSelector?: string;
};

/** Wire a search box. Returns what searches now, cancelling a search still waiting for typing to pause. */
export function searchBox(box: HTMLInputElement, spec: SearchBoxSpec) {
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const searchNow = () => {
    clearTimeout(searchTimer);
    return spec.search();
  };
  /** The results, in order. */
  const rows = () => [...spec.results.querySelectorAll<HTMLElement>(spec.rowSelector ?? 'button')];
  box.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(spec.search, spec.delayMs);
  });
  box.addEventListener('keydown', async event => {
    if (event.key === 'Enter') {
      if (!box.value.trim()) return;
      // what was typed may not have been searched yet; a failed search leaves an older query's results showing
      if (await searchNow()) rows()[0]?.click();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      rows()[0]?.focus();
      return;
    }
    if (event.key !== 'Escape') return;
    if (!box.value) return box.blur(); // the next Escape closes what holds the box
    box.value = '';
    searchNow();
  });
  // arrow keys step through the results, back up to the box from the first
  spec.results.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = rows(),
      at = list.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    const next = at + (event.key === 'ArrowDown' ? 1 : -1);
    (next < 0 ? box : list[Math.min(next, list.length - 1)]).focus();
  });
  return searchNow;
}
