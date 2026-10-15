# Drawa's design rules

How the frontend looks and why. `PRODUCT.md` at the repo root is the design brief (who it's for, the personality, the anti-references); this file turns it into rules for the CSS and the DOM. `CLAUDE.md` beside it covers where the code goes.

## Principles (from `PRODUCT.md`)

- **Spatial, alive, exact.** The workspace is a canvas: sessions are cards, files are nodes, actions are edges. It should feel like an instrument you fly, not a form you fill in.
- **Content over chrome.** Claude's words, diffs and code get the space and the contrast; controls stay quiet until needed.
- **Calm under load.** Several streaming sessions stay legible, with state (running, failed, blocked) readable at a glance, and carried by text or shape as well as color.
- **Keyboard-close.** Common actions are one key or one click away.
- **Not these:** claude.ai's beige and bubble chat, VS Code's gray IDE chrome, SaaS rounded card grids and pastel gradients, green-on-black or neon.
- **Accessible:** WCAG 2.2 AA contrast in both themes, visible focus rings, a reduced-motion alternative for every animation.

## Styling rules

- **Themes and color schemes:**
  - `lib/theme.ts` puts light/dark on `<html data-theme>` and the chosen scheme on `data-scheme`, saved in your settings file through `lib/prefs.ts`. The inline script in `index.html` does the same before first paint from `lib/prefs.ts`'s last copy, so keep its defaults in sync.
  - A scheme is 13 base colors (`--c-*`) in `styles/schemes.css`. `tokens.css` derives every UI color from them.
  - To add a scheme: one block in `schemes.css` plus one line in `SCHEMES` in `theme.ts`. Keep `--c-muted` at 4.5:1 or better against `--c-bg`, `--sel`, `--hover` and `--code`. `cd web && pnpm run contrast` checks every scheme's text, button, focus-ring and field-border pairs, and fails if one is under its minimum.
  - Feature CSS uses only the derived tokens, never `--c-*` and never a `prefers-color-scheme` query.
  - Anything drawn with colors baked in (Mermaid, Excalidraw previews) reads `isDark()` and redraws in `onTheme()`.
- **All values come from `styles/tokens.css`:**
  - Colors: derived from the active scheme, including the code highlighting colors (`--syn-*`).
  - Radius scale: `--r-tab`, `--r-box`, `--r-ctl`, and `--r-tag` for small labels (inline code, badges, swatches).
  - z scale: `--z-float`, `--z-panel`, `--z-menu` for overlays; `--z-under`, `--z-sticky`, `--z-over` for stacking inside a window or panel.
  - Kind colors: `--k-*`.
  - Palette hues as text (`--read`, `--edit`, `--write`, `--run`, `--add`, `--del`, `--warn`, `--danger`, `--accent-text`, `--syn-*`) have their lightness clamped to stay 4.5:1 on `--bg`. Strokes and fills (arrows, dots, pen colors) use the raw `--*-hue` tokens; text on an accent or danger fill uses `--on-accent` / `--on-danger`.
  - Input borders use `--field-edge` (3:1 on `--bg`), their focus state `--focus`; `--line` and `--line-2` are dividers.
  - Don't write raw colors, radii or z-index numbers in feature CSS.
- **Shape language:**
  - Windows are folders. A tab on the top-left carries the title and buttons, and a concave shoulder joins it to a nearly square body.
  - Surfaces are square-cut (`--r-box`). The tab curve is the only prominent round corner.
  - Don't bring back 8–14px rounded cards, rounded boxes nested in rounded boxes, or pills. The user has rejected these repeatedly.
- **Window states change `--edge` only;** `window.css` draws the outline from it (no blurred shadows on windows). Don't restyle `.win-h` or `.win-b` per feature beyond what's in the kind's own section.
- **In the minimal interface (`ui` in the settings file, `lib/uimode.ts`), a window's tab shows only when you reach for it** (hovered, focused, selected, dragged; always when collapsed, pinned, floating or in full view). A state that waits on the user keeps its tab up, in the kind's own section, as `.card[data-state=asking]` does in `session.css`; don't show tabs for states that don't need the user.
- **Color carries meaning:** read, edit, write and run are the action colors, and everything else is neutral. Mix tints with `color-mix(in oklab, …)`; oklch mixing shifts hues.
- **Input fields must look like input fields:** a visible border, a text cursor, and a clear focus state.
- **No native-looking controls:** `<select>` goes through `enhance()` from `lib/select.ts`.
- **Every animation has a `prefers-reduced-motion` fallback.** CSS ones live at the end of `index.css`; animations started from script check `reducedMotion()` from `lib/dom.ts`.
- **Layouts must work from phone width up.** Check at 390px.
