// Claude's task list, as a live checklist pinned above the message box. Fed by the TodoWrite tool (the whole list
// at once) and by TaskCreate / TaskUpdate (one task at a time; a created task's number comes back in the result).
import { make } from '../../lib/dom';
import type { Session } from '../../types/session';

type Status = 'pending' | 'in_progress' | 'completed';
interface Task {
  text: string;
  active?: string;
  status: Status;
}
interface State {
  tasks: Map<string, Task>;
  el: HTMLDetailsElement;
  pendingCreates: Map<string, string>;
}
const states = new WeakMap<Session, State>();

export const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);

/** A card's task list, made once, above its message box. */
function taskState(S: Session): State {
  let st = states.get(S);
  if (!st) {
    const el = make('details', 'tasks');
    el.open = true;
    S.card.querySelector('.dock')!.prepend(el);
    states.set(S, (st = { tasks: new Map(), el, pendingCreates: new Map() }));
  }
  return st;
}

/** A task tool call finished streaming (live or replayed). Returns a one-line summary for its row in the log. */
export function taskCall(S: Session, toolId: string, name: string, inp: Record<string, any>): string {
  const st = taskState(S);
  if (name === 'TodoWrite') {
    st.tasks.clear();
    for (const [i, t] of (inp.todos ?? []).entries())
      st.tasks.set(String(i), { text: t.content ?? '', active: t.activeForm, status: t.status ?? 'pending' });
  } else if (name === 'TaskCreate') {
    st.tasks.set(toolId, { text: inp.subject ?? inp.description ?? 'Task', active: inp.activeForm, status: 'pending' });
    st.pendingCreates.set(toolId, toolId);
  } else if (name === 'TaskUpdate') {
    const t = st.tasks.get(String(inp.taskId));
    if (inp.status === 'deleted') st.tasks.delete(String(inp.taskId));
    else if (t)
      Object.assign(
        t,
        inp.status ? { status: inp.status } : {},
        inp.subject ? { text: inp.subject } : {},
        inp.activeForm ? { active: inp.activeForm } : {},
      );
  }
  drawTasks(S, st);
  const done = [...st.tasks.values()].filter(t => t.status === 'completed').length;
  return name === 'TaskUpdate' && inp.status
    ? `#${inp.taskId} ${String(inp.status).replace('_', ' ')}`
    : `${done}/${st.tasks.size} done`;
}

/** TaskCreate's result carries the task's number ("Task #3 created..."): later updates refer to it. */
export function taskResult(S: Session, toolId: string, text: string) {
  const st = states.get(S),
    key = st?.pendingCreates.get(toolId);
  if (!st || !key) return;
  st.pendingCreates.delete(toolId);
  const n = /#(\d+)/.exec(text)?.[1],
    t = st.tasks.get(key);
  if (!n || !t) return;
  st.tasks.delete(key);
  st.tasks.set(n, t);
  drawTasks(S, st);
}

/** Draw the task checklist: done out of total in its summary, and each task. */
function drawTasks(S: Session, st: State) {
  const all = [...st.tasks.values()],
    done = all.filter(t => t.status === 'completed').length;
  const now = all.find(t => t.status === 'in_progress');
  st.el.hidden = !all.length;
  const sum = make('summary');
  sum.append(
    make('b', '', done === all.length ? `All ${all.length} tasks done` : `Tasks ${done}/${all.length}`),
    make('span', 'now', now ? now.active || now.text : ''),
  );
  const bar = make('i', 'bar');
  bar.style.setProperty('--p', `${all.length ? (done / all.length) * 100 : 0}%`);
  sum.append(bar);
  const list = make('ol');
  list.append(
    ...all.map(t => {
      const li = make('li', t.status, t.status === 'in_progress' ? t.active || t.text : t.text);
      return li;
    }),
  );
  if (done === all.length && all.length) st.el.open = false; // finished: fold down to the one-line summary
  st.el.replaceChildren(sum, list);
  S.card.dataset.tasks = String(all.length);
}
