import { buildGraph, extractSignatures, type Signature } from '../repoMap';
import { estimateTokens } from '../contextBudget';
import { scrubWorkspaceText } from '../envSafety';
import { sha256Hex } from '../proof/ledger';
import type {
  DecisionInput,
  DecisionStatus,
  DecisionTarget,
  DependencyAnswer,
  DependencyEvidence,
  FileEdge,
  IntentContextRequest,
  IntentContextResult,
  IntentDecision,
  IntentFile,
  IntentGraph,
  IntentSymbol,
  SelectedDecision
} from './types';

export function normalizeIntentPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function symbolKind(signature: Signature): IntentSymbol['kind'] {
  if (signature.kind === 'class') return 'class';
  if (signature.kind === 'type') return 'type';
  if (signature.kind === 'function' && /^[A-Z]/.test(signature.name)) return 'component';
  return signature.kind === 'function' ? 'function' : 'other';
}

export async function hashIntentFiles(files: readonly IntentFile[]): Promise<Record<string, string>> {
  const entries = await Promise.all(files.map(async (file) => [
    normalizeIntentPath(file.path),
    await sha256Hex(file.content)
  ] as const));
  return Object.fromEntries(entries);
}

/** One file's cached derivation, reusable while the content string is identical. */
interface IntentIndexEntry {
  content: string;
  hash: string;
  signatures: Signature[];
}

/**
 * Reuse bookkeeping for `buildIntentGraph`. SHA-256 of every buffer and the
 * signature scan of every buffer are the only expensive parts of a build, and
 * both are a pure function of one file's content — so an edit to one file
 * should re-derive that file alone, not the workspace.
 */
export interface IntentIndex {
  entries: Map<string, IntentIndexEntry>;
  /** Files whose cached hash and signatures were reused in the last build. */
  reused: number;
  /** Files actually re-hashed and re-scanned in the last build. */
  reindexed: number;
}

export function createIntentIndex(): IntentIndex {
  return { entries: new Map(), reused: 0, reindexed: 0 };
}

async function deriveIndexedFiles(
  files: readonly IntentFile[],
  index: IntentIndex
): Promise<{ hashes: Record<string, string>; signatureMap: Map<string, Signature[]> }> {
  const derived = await Promise.all(files.map(async (file) => {
    const path = normalizeIntentPath(file.path);
    const content = file.content;
    const cached = index.entries.get(path);
    if (cached && cached.content === content) {
      return { path, content, hash: cached.hash, signatures: cached.signatures, reused: true };
    }
    return {
      path,
      content,
      hash: await sha256Hex(content),
      signatures: extractSignatures(path, content),
      reused: false
    };
  }));

  const hashes: Record<string, string> = {};
  const signatureMap = new Map<string, Signature[]>();
  const live = new Set<string>();
  let reused = 0;
  let reindexed = 0;
  for (const entry of derived) {
    live.add(entry.path);
    hashes[entry.path] = entry.hash;
    signatureMap.set(entry.path, entry.signatures);
    index.entries.set(entry.path, { content: entry.content, hash: entry.hash, signatures: entry.signatures });
    if (entry.reused) reused += 1;
    else reindexed += 1;
  }
  for (const path of [...index.entries.keys()]) {
    if (!live.has(path)) index.entries.delete(path);
  }
  index.reused = reused;
  index.reindexed = reindexed;
  return { hashes, signatureMap };
}

/**
 * Freshness of one decision against the live index.
 *
 * A governing file that is simply not in the current index proves nothing: the
 * app indexes open buffers, not the whole tree, so answering `stale` would flag
 * every decision about a closed file for review, and answering `fresh` would
 * vouch for a file nobody looked at. Both are wrong, so it reports `unknown`.
 */
export function decisionFreshness(
  baseHashes: Readonly<Record<string, string>>,
  fileHashes: Readonly<Record<string, string>>
): DecisionStatus {
  const entries = Object.entries(baseHashes);
  if (entries.length === 0) return 'unknown';
  let unverifiable = 0;
  for (const [path, hash] of entries) {
    const current = fileHashes[normalizeIntentPath(path)];
    if (current === undefined) {
      unverifiable += 1;
      continue;
    }
    if (current !== hash) return 'stale';
  }
  return unverifiable > 0 ? 'unknown' : 'fresh';
}

/** The hashes a decision should pin: its own targets, never the whole index. */
export function hashesForTargets(
  fileHashes: Readonly<Record<string, string>>,
  targets: readonly DecisionTarget[]
): Record<string, string> {
  const pinned: Record<string, string> = {};
  for (const target of targets) {
    const path = normalizeIntentPath(target.path);
    if (fileHashes[path] !== undefined) pinned[path] = fileHashes[path];
  }
  return pinned;
}

export function refreshDecisionStatuses(
  decisions: readonly IntentDecision[],
  fileHashes: Readonly<Record<string, string>>
): IntentDecision[] {
  return decisions.map((decision) => ({ ...decision, status: decisionFreshness(decision.baseHashes, fileHashes) }));
}

export async function buildIntentGraph(
  workspaceRoot: string,
  files: readonly IntentFile[],
  decisions: readonly IntentDecision[] = [],
  options: { index?: IntentIndex } = {}
): Promise<IntentGraph> {
  const index = options.index ?? createIntentIndex();
  const { hashes, signatureMap } = await deriveIndexedFiles(files, index);
  const normalized = files.map((file) => ({ name: normalizeIntentPath(file.path), content: file.content }));
  const symbols: IntentSymbol[] = [];
  for (const [path, entries] of signatureMap) {
    for (const signature of entries) {
      if (signature.kind === 'other') continue;
      symbols.push({
        id: `${path}#${signature.name}`,
        name: signature.name,
        kind: symbolKind(signature),
        path,
        line: signature.line,
        signature: signature.text,
        exported: signature.text.trimStart().startsWith('export ')
      });
    }
  }
  const dependencyGraph = buildGraph(normalized, signatureMap);
  const fileEdges: FileEdge[] = [];
  for (const [from, node] of dependencyGraph) {
    for (const [to, weight] of node.out) fileEdges.push({ from, to, weight });
  }
  return {
    workspaceRoot,
    symbols: symbols.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
    decisions: refreshDecisionStatuses(decisions, hashes),
    fileEdges: fileEdges.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from)),
    fileHashes: hashes,
    builtAt: Date.now()
  };
}

function decisionTargets(decision: IntentDecision): string[] {
  return decision.targets.flatMap((target) => [
    normalizeIntentPath(target.path),
    target.symbol ? `${normalizeIntentPath(target.path)}#${target.symbol}` : ''
  ]).filter(Boolean);
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_$]+/).filter((term) => term.length >= 3))];
}

function compactDecision(decision: IntentDecision, distance: number): string {
  const state = decision.status === 'stale'
    ? ' [STALE — NEEDS REVIEW]'
    : decision.status === 'unknown'
      ? ' [NOT INDEXED — UNVERIFIED]'
      : '';
  return `- ${decision.kind.toUpperCase()}${state}: ${decision.title}\n  ${decision.body}\n  targets: ${decision.targets.map((target) => target.symbol ? `${target.path}#${target.symbol}` : target.path).join(', ')} (distance ${distance})`;
}

export function extractIntentContext(
  graph: IntentGraph,
  request: IntentContextRequest
): IntentContextResult {
  const budget = Math.max(0, request.tokenBudget);
  if (budget === 0 || graph.decisions.length === 0) return { text: '', selected: [], tokensUsed: 0, staleCount: 0 };
  const seeds = new Set(request.seeds.map(normalizeIntentPath));
  const terms = queryTerms(request.query);
  const distances = new Map<string, number>();
  const queue = [...seeds].map((seed) => ({ path: seed, distance: 0 }));
  while (queue.length) {
    const current = queue.shift()!;
    if (distances.has(current.path)) continue;
    distances.set(current.path, current.distance);
    for (const edge of graph.fileEdges) {
      if (edge.from === current.path && !distances.has(edge.to)) queue.push({ path: edge.to, distance: current.distance + 1 });
      if (edge.to === current.path && !distances.has(edge.from)) queue.push({ path: edge.from, distance: current.distance + 1 });
    }
  }
  const ranked: SelectedDecision[] = graph.decisions
    .map((decision) => {
      const targetDistances = decisionTargets(decision).map((target) => distances.get(target.split('#')[0]) ?? Number.POSITIVE_INFINITY);
      const distance = Math.min(...targetDistances);
      const overlap = terms.reduce((count, term) => count + (scrubWorkspaceText(`${decision.title} ${decision.body}`).toLowerCase().includes(term) ? 1 : 0), 0);
      return { decision, distance, relevance: (Number.isFinite(distance) ? 100 - distance * 10 : 0) + overlap * 8 };
    })
    .filter((entry) => entry.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || a.distance - b.distance || a.decision.createdAt - b.decision.createdAt);
  const selected: SelectedDecision[] = [];
  let tokensUsed = 0;
  for (const candidate of ranked) {
    if (request.maxDecisions !== undefined && selected.length >= request.maxDecisions) break;
    const block = compactDecision(candidate.decision, candidate.distance);
    const nextTokens = estimateTokens(block);
    if (tokensUsed + nextTokens > budget) continue;
    selected.push(candidate);
    tokensUsed += nextTokens;
  }
  return {
    text: selected.length ? `<living_intent>\n${selected.map((entry) => compactDecision(entry.decision, entry.distance)).join('\n')}\n</living_intent>` : '',
    selected,
    tokensUsed,
    staleCount: selected.filter((entry) => entry.decision.status === 'stale').length
  };
}

export function decisionInputTargets(input: DecisionInput): DecisionTarget[] {
  return input.targets.map((target) => ({ path: normalizeIntentPath(target.path), ...(target.symbol ? { symbol: target.symbol } : {}) }));
}

const MAX_DEPENDENCY_EVIDENCE = 12;

function questionTokens(question: string): string[] {
  return [...new Set(question.toLowerCase().split(/[^a-z0-9_$./-]+/).filter((token) => token.length >= 3))];
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** The subject of a dependency question, and how surely it was identified. */
interface DependencySubject {
  path: string;
  confidence: number;
  reason: string;
}

function resolveSubject(graph: IntentGraph, question: string): DependencySubject | null {
  const lower = question.toLowerCase().replace(/\\/g, '/');
  const indexed = Object.keys(graph.fileHashes);
  for (const path of indexed.sort((a, b) => b.length - a.length)) {
    if (lower.includes(path)) {
      return { path, confidence: 0.9, reason: `the question names the indexed file ${path}` };
    }
  }
  const tokens = questionTokens(question);
  const bySymbol = graph.symbols.find((symbol) => tokens.includes(symbol.name.toLowerCase()));
  if (bySymbol) {
    return { path: bySymbol.path, confidence: 0.8, reason: `the question names ${bySymbol.name}, declared in ${bySymbol.path}` };
  }
  for (const path of indexed) {
    const stem = basename(path).replace(/\.[^.]+$/, '').toLowerCase();
    if (stem.length >= 3 && tokens.includes(stem)) {
      return { path, confidence: 0.6, reason: `the question matches the file name ${basename(path)}` };
    }
  }
  return null;
}

function evidenceOf(graph: IntentGraph, from: string, direction: 'depends-on' | 'depended-by'): DependencyEvidence[] {
  const rows = graph.fileEdges
    .filter((edge) => (direction === 'depends-on' ? edge.from === from : edge.to === from))
    .map((edge) => ({
      path: direction === 'depends-on' ? edge.to : edge.from,
      weight: edge.weight,
      indexed: graph.fileHashes[direction === 'depends-on' ? edge.to : edge.from] !== undefined
    }))
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
  return rows.slice(0, MAX_DEPENDENCY_EVIDENCE);
}

/**
 * Answer "what does this file touch / what touches it" from the index alone.
 *
 * Every claim is an edge that `buildGraph` actually found, and the confidence
 * says how well the subject was identified and how much of the workspace the
 * index covers — because ShadRox indexes the files it has open, an empty
 * `dependedBy` list genuinely may mean "an unimported file I never read imports
 * it". The answer never asserts more than the indexed edges support.
 */
export function answerDependencyQuestion(graph: IntentGraph, question: string): DependencyAnswer {
  const askedFor = /\bwho (imports|uses|depends)|what depends|dependents?\b/i.test(question)
    ? 'depended-by'
    : /\b(imports|depends on|uses)\b/i.test(question)
      ? 'depends-on'
      : 'both';
  const subject = resolveSubject(graph, question);
  if (!subject) {
    return {
      question,
      resolved: false,
      subject: null,
      askedFor,
      dependsOn: [],
      dependedBy: [],
      symbols: [],
      confidence: 0,
      reasons: [`no indexed file or symbol matches this question; the index holds ${Object.keys(graph.fileHashes).length} file(s)`],
      truncated: false
    };
  }

  const dependsOn = evidenceOf(graph, subject.path, 'depends-on');
  const dependedBy = evidenceOf(graph, subject.path, 'depended-by');
  const reasons = [subject.reason];
  let confidence = subject.confidence;
  const indexed = Object.keys(graph.fileHashes).length;
  if (askedFor !== 'both' && (askedFor === 'depends-on' ? dependsOn : dependedBy).length === 0) {
    confidence = Math.min(confidence, 0.45);
    reasons.push(
      `no ${askedFor} edge found in ${indexed} indexed file(s) — ShadRox indexes the files it has open, so this is "not seen", not "none exist"`
    );
  }
  if (dependsOn.length >= MAX_DEPENDENCY_EVIDENCE || dependedBy.length >= MAX_DEPENDENCY_EVIDENCE) {
    reasons.push(`the longer list is capped at ${MAX_DEPENDENCY_EVIDENCE} edges`);
  }
  return {
    question,
    resolved: true,
    subject: subject.path,
    askedFor,
    dependsOn,
    dependedBy,
    symbols: graph.symbols.filter((symbol) => symbol.path === subject.path).map((symbol) => symbol.name),
    confidence,
    reasons,
    truncated:
      graph.fileEdges.filter((edge) => edge.from === subject.path || edge.to === subject.path).length > MAX_DEPENDENCY_EVIDENCE
  };
}

