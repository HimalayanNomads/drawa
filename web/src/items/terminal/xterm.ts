// The terminal emulator inside a terminal window: xterm.js (loaded on first use), colored from the theme, with
// Neovim's two modes. Terminal mode is the emulator having focus: every key goes to the shell (the window's
// data-own-keys keeps Drawa's shortcuts out of it), and Ctrl+\ leaves it. Normal mode is focus on the window
// around it: j/k, Ctrl+D/U and gg/G scroll, i, a or Enter go back, and every other key is the canvas's.

import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { toast, truncate } from '../../lib/dom';
import { prefs } from '../../lib/prefs';
import { isDark } from '../../lib/theme';

// The icons terminal programs draw (nvim-tree, lualine, starship, eza) are Nerd Font glyphs, which Drawa's own mono
// font doesn't have: an installed Nerd Font goes first (JetBrains Mono's looks the same as Drawa's), and a symbols-only
// one fills in the icons around Drawa's font. ponytail: without any installed they're boxes; bundling the ~1 MB
// symbols font, loaded with the emulator, would fix that for everyone.
const NERD_FONTS =
  '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrainsMono NF", "Symbols Nerd Font Mono", "Symbols Nerd Font"';

/** The Settings panel's font, size and cursor, as xterm options (a chosen font still falls back to the Nerd Fonts,
 *  for the icons). */
export function looks() {
  const settings = prefs(),
    mono = getComputedStyle(document.documentElement).getPropertyValue('--mono');
  return {
    fontFamily: [settings.terminalFont, NERD_FONTS, mono].filter(Boolean).join(', '),
    fontSize: Number(settings.terminalFontSize) || 13,
    cursorStyle: settings.terminalCursor,
  };
}

export interface Emulator {
  term: Terminal;
  fit: FitAddon;
}

// ponytail: reads the scheme's base colors (--c-*), which feature CSS never does: an ANSI palette is exactly those
// hues, and xterm needs them as plain colors. Resolved through a probe and a 1px canvas, so oklch and color-mix work.
const probe = document.createElement('i');
const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
function color(token: string) {
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = getComputedStyle(probe).color;
  probe.remove();
  pixel.fillRect(0, 0, 1, 1);
  const [red, green, blue] = pixel.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}
/** xterm's colors for the current theme and scheme. */
export function palette() {
  const dark = isDark();
  const hues = {
    red: color('--c-red'),
    green: color('--c-green'),
    yellow: color('--c-yellow'),
    blue: color('--c-blue'),
    magenta: color('--c-purple'),
    cyan: color('--c-cyan'),
  };
  return {
    background: color('--bg'),
    foreground: color('--ink'),
    cursor: color('--accent'),
    cursorAccent: color('--bg'),
    selectionBackground: color('--sel'),
    black: color(dark ? '--c-canvas' : '--c-text'),
    white: color(dark ? '--c-sub' : '--c-canvas'),
    brightBlack: color('--c-muted'),
    brightWhite: color(dark ? '--c-text' : '--c-bg'),
    ...hues,
    brightRed: hues.red,
    brightGreen: hues.green,
    brightYellow: hues.yellow,
    brightBlue: hues.blue,
    brightMagenta: hues.magenta,
    brightCyan: hues.cyan,
  };
}

/** A new emulator in `box`, which `normal` (the element normal mode focuses) wraps. `send` types into the shell. */
export async function emulator(box: HTMLElement, normal: HTMLElement, send: (data: string) => void): Promise<Emulator> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  const term = new Terminal({
    ...looks(),
    scrollback: 5000,
    theme: palette(),
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box);
  box.dataset.ownKeys = '';
  term.onData(send);
  // the shell copying (OSC 52, as vim and tmux do over ssh): onto the system clipboard
  term.parser.registerOscHandler(52, data => {
    const encoded = data.slice(data.indexOf(';') + 1);
    if (encoded === '?') return true; // reading the clipboard back: refused
    try {
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      // said out loud: any output can carry this (a file you cat), and a swapped clipboard pasted into a shell runs
      navigator.clipboard
        ?.writeText(text)
        .then(() =>
          toast(
            `Terminal copied ${text.length.toLocaleString()} characters to the clipboard: ${truncate(text.replace(/\s+/g, ' '), 60, '…')}`,
          ),
        )
        .catch(() => {});
    } catch {
      /* not base64: ignored */
    }
    return true;
  });
  // Ctrl+\ alone leaves terminal mode (one key, unlike Neovim's Ctrl+\ Ctrl+N: browsers never let a page keep
  // Ctrl+N). ponytail: so the shell never gets Ctrl+\ (SIGQUIT); `kill -QUIT` still does it
  term.attachCustomKeyEventHandler(event => {
    if (!(event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Backslash')) return true;
    if (event.type === 'keydown') {
      event.preventDefault();
      normal.focus();
      if (document.fullscreenElement?.contains(normal)) document.exitFullscreen().catch(() => {}); // the way out of a locked keyboard
    }
    return false;
  });
  normalKeys(term, normal);
  return { term, fit };
}

/** Normal mode's keys, on the element around the emulator; anything else goes on to the canvas's shortcuts. */
function normalKeys(term: Terminal, normal: HTMLElement) {
  let lastG = -1e9;
  normal.tabIndex = -1;
  normal.addEventListener('keydown', event => {
    if (event.target !== normal || event.altKey || event.metaKey) return;
    const page = Math.max(1, Math.floor(term.rows / 2));
    const actions: Record<string, () => void> = {
      j: () => term.scrollLines(1),
      k: () => term.scrollLines(-1),
      ArrowDown: () => term.scrollLines(1),
      ArrowUp: () => term.scrollLines(-1),
      G: () => term.scrollToBottom(),
      i: () => term.focus(),
      a: () => term.focus(),
      Enter: () => term.focus(),
    };
    const ctrl: Record<string, () => void> = {
      d: () => term.scrollLines(page),
      u: () => term.scrollLines(-page),
    };
    let action = event.ctrlKey ? ctrl[event.key] : actions[event.key];
    if (!event.ctrlKey && event.key === 'g') {
      if (event.timeStamp - lastG < 500) action = () => term.scrollToTop();
      else {
        lastG = event.timeStamp;
        action = () => {};
      }
    }
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  });
}
