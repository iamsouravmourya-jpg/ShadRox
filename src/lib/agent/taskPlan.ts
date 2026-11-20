export type TaskStatus = 'pending' | 'doing' | 'done' | 'blocked';

export interface TaskItem {
  id: string;
  subject: string;
  status: TaskStatus;
  evidence?: string;
  files?: string[];
  /** What "done" means for this task; marking it done without evidence is challenged. */
  acceptance?: string;
}

export type TaskPlan = TaskItem[];

export interface TaskUpdateResult {
  plan: TaskPlan;
  /** One line the model can act on; the plan stays usable when it is set. */
  error: string | null;
}

const STATUS_ALIASES: Record<string, TaskStatus> = {
  pending: 'pending',
  todo: 'pending',
  to_do: 'pending',
  open: 'pending',
  waiting: 'pending',
  doing: 'doing',
  in_progress: 'doing',
  active: 'doing',
  started: 'doing',
  wip: 'doing',
  done: 'done',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  blocked: 'blocked',
  stuck: 'blocked',
  failed: 'blocked',
  cancelled: 'blocked'
};

const MARKERS: Record<TaskStatus, string> = { pending: ' ', doing: '>', done: 'x', blocked: '!' };

const MAX_SUBJECT_CHARS = 140;

const SHAPE_HINT = 'update_tasks expects {"tasks":[{"id":"read-folder","subject":"read the folder","status":"doing"}]} '
  + 'and the statuses pending, doing, done or blocked.';

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return null;
}

function asStatus(value: unknown): TaskStatus | null {
  const text = asText(value);
  if (!text) return null;
  return STATUS_ALIASES[text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')] ?? null;
}

interface RawTask {
  id: string | null;
  subject: string | null;
  status: TaskStatus | null;
  hadStatus: boolean;
  acceptance: string | null;
  evidence: string | null;
  files: string[] | null;
}

function asFileList(value: unknown): string[] | null {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return null;
  const list = value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim());
  return list.length > 0 ? list : null;
}

function toRawTask(entry: unknown): RawTask | null {
  if (typeof entry === 'string') {
    return { id: null, subject: asText(entry), status: null, hadStatus: false, acceptance: null, evidence: null, files: null };
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const statusSource = firstText(record.status, record.state);
  return {
    id: firstText(record.id, record.key),
    subject: firstText(record.subject, record.title, record.name),
    status: asStatus(statusSource),
    hadStatus: Boolean(statusSource),
    acceptance: firstText(record.acceptance, record.acceptance_criteria, record.done_when),
    evidence: firstText(record.evidence, record.proof),
    files: asFileList(record.files)
  };
}

function extractEntries(updates: unknown): unknown[] | null {
  if (Array.isArray(updates)) return updates;
  if (typeof updates === 'string') {
    const text = updates.trim();
    return text.startsWith('{') || text.startsWith('[') ? null : asText(text) ? [text] : null;
  }
  if (!updates || typeof updates !== 'object') return null;
  const record = updates as Record<string, unknown>;
  const list = record.tasks ?? record.todos ?? record.items;
  if (Array.isArray(list)) return list;
  if (list && typeof list === 'object') return [list];
  return toRawTask(record)?.subject ? [record] : null;
}

function sameSubject(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function clip(text: string): string {
  return text.length <= MAX_SUBJECT_CHARS ? text : `${text.slice(0, MAX_SUBJECT_CHARS - 1)}…`;
}

function slug(subject: string): string {
  const base = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return base || 'task';
}

function uniqueId(base: string, plan: TaskPlan): string {
  if (!plan.some((item) => item.id === base)) return base;
  let suffix = 2;
  while (plan.some((item) => item.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function findTarget(plan: TaskPlan, id: string | null, subject: string | null): number {
  if (id) {
    const byId = plan.findIndex((item) => item.id === id);
    if (byId >= 0) return byId;
  }
  if (subject) return plan.findIndex((item) => sameSubject(item.subject, subject));
  return -1;
}

export function applyTaskUpdates(previous: TaskPlan, updates: unknown): TaskUpdateResult {
  const entries = extractEntries(updates);
  if (!entries) return { plan: previous, error: SHAPE_HINT };

  const plan: TaskPlan = previous.map((item) => ({ ...item }));
  let dropped = 0;
  let coerced = 0;

  for (const entry of entries) {
    const task = toRawTask(entry);
    if (!task) {
      dropped += 1;
      continue;
    }
    const index = findTarget(plan, task.id, task.subject);
    if (!task.subject && index < 0) {
      dropped += 1;
      continue;
    }
    if (task.hadStatus && !task.status) coerced += 1;
    const target = index >= 0 ? plan[index] : null;
    const subject = clip(task.subject ?? target?.subject ?? '');
    const id = task.id ?? target?.id ?? uniqueId(slug(subject), plan);
    const status = task.status ?? target?.status ?? 'pending';
    // An update carries only what it says: acceptance, evidence and files are
    // preserved from the earlier entry unless the update replaces them, so a
    // status flip can never silently drop the proof a task was done.
    const next: TaskItem = { id, subject, status };
    const acceptance = task.acceptance ?? target?.acceptance;
    const evidence = task.evidence ?? target?.evidence;
    const files = task.files ?? target?.files;
    if (acceptance) next.acceptance = acceptance;
    if (evidence) next.evidence = evidence;
    if (files && files.length > 0) next.files = files;
    if (target) plan[index] = next;
    else plan.push(next);
  }

  const notes: string[] = [];
  if (dropped > 0) {
    notes.push(`${dropped} ${dropped === 1 ? 'entry was' : 'entries were'} unusable: a task needs a subject, or the id of an existing task plus a status`);
  }
  if (coerced > 0) {
    notes.push(`${coerced} status ${coerced === 1 ? 'value was' : 'values were'} not understood — use pending, doing, done or blocked`);
  }

  if (plan.length === 0) {
    return { plan: previous, error: `${notes.join('; ') || 'That payload held no task'}. ${SHAPE_HINT}` };
  }
  return { plan, error: notes.length > 0 ? `${notes.join('; ')}.` : null };
}

export function renderTaskPlan(plan: TaskPlan): string {
  return plan
    .filter((item) => item.subject.trim())
    .map((item) => `[${MARKERS[item.status]}] ${item.subject}`)
    .join('  ');
}

export function openTasks(plan: TaskPlan): TaskItem[] {
  return plan.filter((item) => item.status !== 'done');
}

export function completionGuard(plan: TaskPlan, wantsToFinish: boolean): string | null {
  if (!wantsToFinish) return null;
  const blockers = openTasks(plan).filter((item) => item.status !== 'blocked');
  // A task with an acceptance criterion is only done when something proves it:
  // "done" with no evidence is a claim, and the guard asks for the proof once.
  const unproven = plan.filter((item) => item.status === 'done' && item.acceptance && !item.evidence);
  if (blockers.length === 0 && unproven.length === 0) return null;
  const parts: string[] = [];
  if (blockers.length > 0) {
    const names = blockers.map((item) => `"${item.subject}" (${item.status})`).join(', ');
    parts.push(`Your task list is not finished — still open: ${names}. `
      + 'Call update_tasks again and mark each one done, or mark it blocked and put the one-line reason in its subject. '
      + `Do not end the turn with a task left pending or doing. Current plan: ${renderTaskPlan(plan)}`);
  }
  if (unproven.length > 0) {
    const names = unproven.map((item) => `"${item.subject}" (acceptance: ${item.acceptance})`).join(', ');
    parts.push(`Marked done without evidence: ${names}. `
      + 'Run the check each acceptance criterion names (verify, problems, a test command or a preview check) and call update_tasks with the result in "evidence", or set the task back to doing.');
  }
  return parts.join(' ');
}
