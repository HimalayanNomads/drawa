// What a session card is: its live process, its conversation's state, and the elements it's drawn with.
import type { Ref } from '../canvas/core/refs';
import type { Change } from '../panels/diff';
import type { Pasted } from '../session/composer/images';

export type ToolRow = HTMLDetailsElement & { chg?: Change };
export interface Block {
  type: string;
  buf: string;
  el?: HTMLElement;
  d?: ToolRow;
  raf?: number;
  name?: string;
  id?: string;
  done?: number;
  tail?: HTMLElement; // streaming text: chars already rendered for good, and the element redrawn each frame
}
export interface Session {
  cid: string; // this card's live process on the server
  sid: string | null; // the agent's session id (transcript), known after the first reply
  backend: string; // which agent runs this card (lib/agents.ts); fixed for its life, the transcript can't move
  title: string;
  reportedModel: string; // the model Claude's process actually reports running (for the tab; set from its own output)
  model: string; // the model picked in this card's message bar for its next message ('' = Claude's own default)
  modelSel?: HTMLSelectElement;
  effort: string; // the effort level picked in this card's message bar ('' = default; see gen.ts)
  effortSel?: HTMLSelectElement;
  infoEl?: HTMLElement; // tools/context/usage-window status line below the message bar (see gen.ts)
  infoText?: HTMLElement; // its "N tools · X% context" part
  ring5h?: HTMLElement; // its 5-hour usage-window ring badge
  ring5hPct?: HTMLElement; // the "49%" label beside it
  ring7d?: HTMLElement; // its 7-day usage-window ring badge
  ring7dPct?: HTMLElement; // the "4%" label beside it
  toolCount: number; // tools this card's Claude can call, from its own init line (0 until its process has started)
  mcpTotal: number;
  mcpConnected: number;
  usageResetAt?: number; // unix seconds: when the current 5-hour usage window ends (from rate_limit_event)
  usageUtil?: number; // 0..1 of that window used so far
  weeklyResetAt?: number;
  weeklyUtil?: number;
  cost: number;
  done: boolean;
  card: HTMLElement;
  log: HTMLDivElement;
  ta: HTMLTextAreaElement;
  stopBtn: HTMLButtonElement;
  blocks: Record<number, Block>;
  tools: Record<string, ToolRow>;
  pending: number; // messages sent and not yet answered
  bg: number; // background agents still running
  queued: HTMLElement[]; // bubbles waiting for Claude to pick them up
  picked: boolean; // Claude echoed a message back during the current turn
  mode: string; // permission mode for this card's Claude (see mode.ts)
  modeSel?: HTMLSelectElement; // its picker in the message bar
  confirmedMode?: string; // the mode Claude last reported (or the card was restored with)
  reader?: string; // this page's reader id on the server stream (canvas tool calls name the page to run them)
  atEnd: boolean; // new output scrolls into view: off once you scroll up to read, on again back at the bottom
  replaying?: boolean; // rebuilding a saved transcript: no per-message scroll pinning or header updates (see history.ts)
  asks: Set<string>; // approval requests waiting on you
  refs: Ref[]; // canvas items attached to the next message
  images: Pasted[]; // images pasted or dropped into the message box, sent with the next message
  sentRefs: Set<HTMLElement>; // items referenced in messages already sent (their arrows stay)
  chips: HTMLElement;
  n: number; // next output line to read (for re-attaching)
  gen?: string; // which of the card's processes `n` counts lines of
  gone?: boolean; // the server has no process for it (so nothing of it runs, agents included)
  stale?: string; // /clear: the old process's gen, whose lines still in flight are dropped (see live.ts)
  ctx: { used: number; max: number; real?: boolean }; // context window use, from the latest reply's token counts (real: size reported by the CLI)
}
