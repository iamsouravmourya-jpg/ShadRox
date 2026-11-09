import { buildGraph, extractSignatures, type Signature } from '../repoMap';
import { estimateTokens } from '../contextBudget';
import { scrubWorkspaceText } from '../envSafety';
import { sha256Hex } from '../proof/ledger';
import type {
  DecisionInput,
  DecisionTarget,
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

export function refreshDecisionStatuses(
  decisions: readonly IntentDecision[],
  fileHashes: Readonly<Record<string, string>>
): IntentDecision[] {
  return decisions.map((decision) => ({
    ...decision,
    status: Object.entries(decision.baseHashes).every(([path, hash]) => fileHashes[normalizeIntentPath(path)] === hash)
      ? 'fresh'
      : 'stale'
  }));
}

export async function buildIntentGraph(
  workspaceRoot: string,
  files: readonly IntentFile[],
  decisions: readonly IntentDecision[] = []
): Promise<IntentGraph> {
  const normalized = files.map((file) => ({ name: normalizeIntentPath(file.path), content: file.content }));
  const hashes = await hashIntentFiles(files);
  const signatures = normalized.map((file) => [file.name, extractSignatures(file.name, file.content)] as const);
  const signatureMap = new Map(signatures);
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
  const state = decision.status === 'stale' ? ' [STALE — NEEDS REVIEW]' : '';
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
