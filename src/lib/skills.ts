/**
 * Project skills: named, parameterised prompts the user keeps in the folder.
 *
 * Same contract as the rules module — pure, synchronous, deterministic, never
 * throwing on a hand-edited file. A skill is `.shadrox/skills/<name>.md` with a
 * leading front matter block; the body is the prompt template.
 */

export interface Skill {
  name: string;
  description: string;
  whenToUse: string;
  appliesTo: string[];
  body: string;
  path: string;
}

export interface SkillInvocation {
  skill: Skill;
  args: string;
}

/** Past this a skill file is a data dump; the body would crowd out the conversation. */
export const MAX_SKILL_FILE_BYTES = 64 * 1024;

const SKILL_FILE = /^\.shadrox\/skills\/([^/]+)\.md$/i;

const IGNORED_SEGMENTS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'dist_staging', 'dist_desktop',
  'build', '.next', 'out', 'coverage', '.cache', '.vercel', '.turbo', 'vendor', '__pycache__'
]);

const NO_FILE_NOTE = '(no file is open in the editor)';
const SLASH_INVOCATION = /^\/([A-Za-z0-9._-]+)([\s\S]*)$/;
const KEY_VALUE_LINE = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/;
const QUOTES = /^["']|["']$/g;
const WORD = /[a-z][a-z0-9_-]{3,}/g;

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'what', 'when', 'your', 'will', 'please',
  'make', 'add', 'fix', 'change', 'into', 'about', 'then', 'than', 'them', 'they',
  'uses', 'using', 'used', 'should', 'would', 'can', 'for', 'the', 'and', 'are'
]);

const FRONT_KEYS: Record<string, 'name' | 'description' | 'whenToUse' | 'appliesTo'> = {
  name: 'name',
  title: 'name',
  description: 'description',
  summary: 'description',
  'when-to-use': 'whenToUse',
  whentouse: 'whenToUse',
  when: 'whenToUse',
  'applies-to': 'appliesTo',
  appliesTo: 'appliesTo',
  applies: 'appliesTo',
  globs: 'appliesTo',
  'apply-to': 'appliesTo'
};

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function normalizeEntryPath(value: string): string | null {
  if (typeof value !== 'string') return null;
  let path = value.trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (path === '' || path.length > 1024 || path.includes('\0')) return null;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return path;
}

function isVendored(path: string): boolean {
  const segments = path.split('/');
  return segments.some((segment, index) =>
    IGNORED_SEGMENTS.has(segment.toLowerCase()) ||
    (segment.startsWith('.') && !(index === 0 && segment === '.shadrox')));
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Skill files worth loading, ordered by path so the list never reshuffles. */
export function findSkillFiles(tree: ReadonlyArray<{ path: string; size: number }>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const entry of tree) {
    const path = normalizeEntryPath(entry.path);
    if (!path || seen.has(path)) continue;
    if (!SKILL_FILE.test(path)) continue;
    if (entry.size > MAX_SKILL_FILE_BYTES || isVendored(path)) continue;
    seen.add(path);
    found.push(path);
  }
  return found.sort(compare);
}

function splitFrontMatter(content: string): { meta: Record<string, string>; body: string } {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return { meta: {}, body: content };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = KEY_VALUE_LINE.exec(line);
    if (!match) continue;
    const field = FRONT_KEYS[match[1].toLowerCase()];
    if (!field) continue;
    meta[field] = match[2].trim().replace(QUOTES, '');
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.md$/i, '');
}

function basenameOf(path: string): string {
  const forward = path.trim().replace(/\\/g, '/');
  return forward.slice(forward.lastIndexOf('/') + 1);
}

function listOf(value: string): string[] {
  const items = value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return [...new Set(items)];
}

/** Lenient by design: a bad front matter line costs that field, never the skill. */
export function parseSkill(path: string, content: string): Skill | null {
  const normalizedPath = normalizeEntryPath(path);
  if (!normalizedPath || !SKILL_FILE.test(normalizedPath)) return null;
  const text = normalizeNewlines(typeof content === 'string' ? content : '');
  const { meta, body } = splitFrontMatter(text);
  const trimmed = body.trim();
  if (trimmed === '') return null;

  return {
    name: (meta.name ?? '').trim() || stemOf(normalizedPath),
    description: (meta.description ?? '').trim(),
    whenToUse: (meta.whenToUse ?? '').trim(),
    appliesTo: listOf(meta.appliesTo ?? ''),
    body: trimmed,
    path: normalizedPath
  };
}

function ordered(skills: readonly Skill[]): Skill[] {
  return [...skills].sort((a, b) => compare(a.name, b.name) || compare(a.path, b.path));
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `release-checklist`, `release checklist` and `release_checklist` all name the same skill. */
function mentionPattern(name: string): RegExp | null {
  const lower = name.trim().toLowerCase();
  if (lower.length < 2) return null;
  const variants = [...new Set([lower, lower.replace(/[-_.]+/g, ' '), lower.replace(/[-_.]+/g, '_')])]
    .filter((variant) => variant.length >= 2);
  if (variants.length === 0) return null;
  return new RegExp(`(?:^|[^a-z0-9])(?:${variants.map(escapeForRegex).join('|')})(?:$|[^a-z0-9])`, 'i');
}

function keywords(value: string): string[] {
  const found = new Set<string>();
  for (const match of value.toLowerCase().matchAll(WORD)) {
    if (!STOPWORDS.has(match[0])) found.add(match[0]);
  }
  return [...found];
}

function bySlash(input: string, skills: Skill[]): Skill | null {
  const match = SLASH_INVOCATION.exec(input.trim());
  if (!match) return null;
  const wanted = normalizeName(match[1]);
  return skills.find((skill) => normalizeName(skill.name) === wanted) ?? null;
}

function byMention(input: string, skills: Skill[]): Skill | null {
  for (const skill of skills) {
    const pattern = mentionPattern(skill.name);
    if (pattern && pattern.test(input)) return skill;
  }
  return null;
}

function byWhenToUse(input: string, skills: Skill[]): Skill | null {
  const lower = input.toLowerCase();
  let best: Skill | null = null;
  let bestScore = 0;
  for (const skill of skills) {
    const terms = keywords(skill.whenToUse);
    if (terms.length === 0) continue;
    const score = terms.filter((term) => lower.includes(term)).length;
    if (score >= 2 && score > bestScore) {
      best = skill;
      bestScore = score;
    }
  }
  return best;
}

/** Explicit `/name` first, then a mention of the name, then `when-to-use` overlap. */
export function matchSkill(input: string, skills: readonly Skill[]): Skill | null {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || skills.length === 0) return null;
  const candidates = ordered(skills);
  return bySlash(text, candidates) ?? byMention(text, candidates) ?? byWhenToUse(text, candidates);
}

/** The skill and the arguments that followed it, for a `/name args` style input. */
export function skillInvocation(input: string, skills: readonly Skill[]): SkillInvocation | null {
  const text = typeof input === 'string' ? input.trim() : '';
  const skill = matchSkill(text, skills);
  if (!skill) return null;
  const match = SLASH_INVOCATION.exec(text);
  const args = match && normalizeName(match[1]) === normalizeName(skill.name) ? match[2].trim() : text;
  return { skill, args };
}

/** Unknown placeholders stay verbatim: a skill may legitimately mean the braces. */
export function renderSkill(
  skill: Skill,
  args: string,
  activeFile?: { path: string; content: string }
): string {
  const fileText = activeFile ? `${activeFile.path}\n${activeFile.content}` : NO_FILE_NOTE;
  const fileName = activeFile ? basenameOf(activeFile.path) || NO_FILE_NOTE : NO_FILE_NOTE;
  return skill.body.replace(/\{(?:args|file|filename)\}/g, (token) => {
    if (token === '{args}') return args;
    if (token === '{file}') return fileText;
    return fileName;
  });
}

/** One line per skill, so the model knows what it can ask for without seeing any body. */
export function describeSkills(skills: readonly Skill[]): string[] {
  return ordered(skills).map((skill) => {
    const detail = skill.description || 'no description';
    const when = skill.whenToUse ? `Use when: ${skill.whenToUse}. ` : '';
    const applies = skill.appliesTo.length > 0 ? `Applies to: ${skill.appliesTo.join(', ')}. ` : '';
    return `- /${normalizeName(skill.name)}: ${detail} ${when}${applies}`.trimEnd();
  });
}
