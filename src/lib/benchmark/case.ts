/**
 * The case file format the benchmark suite is written in.
 *
 * A case is a folder: `case.json` describes the job, `fixture/` is the repo
 * state the agent starts from, `prompt.md` is the user's turn, and `reply.md`
 * is a recorded assistant reply — the golden one, or any reply a run produced.
 * Everything the runner needs to decide pass or fail is declared here, so a
 * case is reviewable as text and reproducible without a model, a key or a
 * network.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const BENCHMARK_KINDS = ['bugfix', 'refactor', 'feature', 'test'] as const;
export type BenchmarkKind = (typeof BENCHMARK_KINDS)[number];

export interface FileCheck {
  /** Shown in the scorecard and in the outcome reason. */
  name: string;
  /** Repo-relative path inside the case fixture. */
  file: string;
  /** Source of the pattern the final file content must match. */
  match?: string;
  /** Set when the pattern must NOT be found — the usual way to pin a fix. */
  absent?: boolean;
}

export interface CommandCheck {
  name: string;
  /** Executed directly, never through a shell, so the case cannot run anything
   *  the file did not literally name. */
  argv: string[];
  /** Defaults to 30000 ms. */
  timeoutMs?: number;
}

export interface CaseDefinition {
  id: string;
  kind: BenchmarkKind;
  title: string;
  /** What a passing run proves, for whoever reads the scorecard. */
  notes?: string;
  checks: FileCheck[];
  commands: CommandCheck[];
  /** Refuse a reply that rewrites a whole file the way the app's guard does. */
  allowDestructive?: boolean;
}

export interface LoadedCase {
  dir: string;
  definition: CaseDefinition;
  prompt: string;
  /** The recorded golden reply; the CLI grades any other reply against it. */
  reply: string;
  fixture: Record<string, string>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Fixture names are joined onto a temp root, so they must be plain relative paths. */
function assertRelative(relative: string): void {
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.includes(':')) throw new Error(`absolute fixture path: ${relative}`);
  if (normalized.split('/').some((segment) => segment === '..' || !SAFE_SEGMENT.test(segment))) {
    throw new Error(`unsafe fixture path: ${relative}`);
  }
}

function parseDefinition(raw: unknown, dir: string): CaseDefinition {
  if (!raw || typeof raw !== 'object') throw new Error(`${dir}: case.json must be an object`);
  const value = raw as Partial<CaseDefinition>;
  if (typeof value.id !== 'string' || !SAFE_SEGMENT.test(value.id)) throw new Error(`${dir}: case.json needs a plain id`);
  if (!BENCHMARK_KINDS.includes(value.kind as BenchmarkKind)) {
    throw new Error(`${dir}: kind must be one of ${BENCHMARK_KINDS.join(', ')}`);
  }
  if (typeof value.title !== 'string' || !value.title.trim()) throw new Error(`${dir}: case.json needs a title`);
  const checks = Array.isArray(value.checks) ? value.checks : [];
  const commands = Array.isArray(value.commands) ? value.commands : [];
  // A case with nothing to assert is a case that always passes, which is worse
  // than no case at all.
  if (checks.length + commands.length === 0) throw new Error(`${dir}: ${value.id} asserts nothing`);
  for (const check of checks) {
    if (typeof check.name !== 'string' || typeof check.file !== 'string') throw new Error(`${dir}: a check needs a name and a file`);
    if (typeof check.match !== 'string') throw new Error(`${dir}: check "${check.name}" needs a match pattern`);
    if (check.absent !== undefined && typeof check.absent !== 'boolean') throw new Error(`${dir}: check "${check.name}" has a non-boolean absent`);
    assertRelative(check.file);
    new RegExp(check.match);
  }
  for (const command of commands) {
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((part) => typeof part !== 'string' || !part)) {
      throw new Error(`${dir}: command "${command.name}" needs a non-empty argv of strings`);
    }
  }
  return {
    id: value.id,
    kind: value.kind as BenchmarkKind,
    title: value.title,
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    checks,
    commands,
    ...(value.allowDestructive === true ? { allowDestructive: true } : {})
  };
}

async function readFixtureTree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else if (entry.isFile()) files[relative] = await fs.readFile(path.join(current, entry.name), 'utf8');
    }
  };
  await walk(root, '');
  return files;
}

/** Every case folder under `benchmark/cases`, in a stable order. */
export async function listCaseDirs(casesRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(casesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(casesRoot, entry.name);
    try {
      await fs.access(path.join(dir, 'case.json'));
      dirs.push(dir);
    } catch {
      // A folder without a case.json is notes, not a case.
    }
  }
  return dirs.sort();
}

export async function loadCase(dir: string): Promise<LoadedCase> {
  const definition = parseDefinition(JSON.parse(await fs.readFile(path.join(dir, 'case.json'), 'utf8')), dir);
  const prompt = await fs.readFile(path.join(dir, 'prompt.md'), 'utf8');
  const reply = await fs.readFile(path.join(dir, 'reply.md'), 'utf8');
  const fixture = await readFixtureTree(path.join(dir, 'fixture'));
  for (const relative of Object.keys(fixture)) assertRelative(relative);
  if (Object.keys(fixture).length === 0) throw new Error(`${dir}: ${definition.id} has an empty fixture/`);
  if (!prompt.trim()) throw new Error(`${dir}: ${definition.id} has an empty prompt.md`);
  if (!reply.trim()) throw new Error(`${dir}: ${definition.id} has an empty reply.md`);
  return { dir, definition, prompt, reply, fixture };
}

export async function loadAllCases(casesRoot: string): Promise<LoadedCase[]> {
  return Promise.all((await listCaseDirs(casesRoot)).map(loadCase));
}
