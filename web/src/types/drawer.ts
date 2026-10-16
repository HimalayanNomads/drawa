// The drawer's panes (panels/drawer.ts): past sessions or the project's files, each opened by its own toolbar button.

/** What the drawer shows. The values are the ids of the panes' elements in index.html. */
export enum DrawerPane {
  History = 'history',
  Files = 'files',
}

/** One pane: what the drawer calls it, what opens it and how it fills itself. */
export type DrawerPaneSpec = {
  title: string;
  /** its toolbar button */
  button: string;
  /** the shortcut that toggles it (a tinykeys combo), shown on its button */
  keys: string;
  /** its search box, focused when it opens */
  search: string;
  load: () => Promise<unknown>;
  /** runs before each opening's load */
  opening?: () => void;
};
