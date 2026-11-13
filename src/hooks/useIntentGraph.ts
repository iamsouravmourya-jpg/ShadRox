import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { answerDependencyQuestion, buildIntentGraph, createIntentIndex, extractIntentContext } from '../lib/intent/graph';
import { createDecision, deleteDecision, exportIntent, importIntent, listDecisions, saveDecision } from '../lib/intent/store';
import type {
  DecisionInput,
  DependencyAnswer,
  IntentContextRequest,
  IntentDecision,
  IntentExport,
  IntentFile,
  IntentGraph
} from '../lib/intent/types';

export interface UseIntentGraph {
  graph: IntentGraph | null;
  decisions: IntentDecision[];
  loading: boolean;
  /** Files the current index actually covers; the rest of the tree is unverified. */
  indexedFiles: number;
  refresh: () => Promise<void>;
  addDecision: (input: DecisionInput) => Promise<IntentDecision | null>;
  removeDecision: (id: string) => Promise<void>;
  exportJson: () => IntentExport;
  importJson: (data: unknown) => { imported: number; skipped: number; errors: string[] };
  getContext: (request: IntentContextRequest) => ReturnType<typeof extractIntentContext>;
  answer: (question: string) => DependencyAnswer | null;
}

export function useIntentGraph(workspaceRoot: string | null, files: readonly IntentFile[]): UseIntentGraph {
  const [graph, setGraph] = useState<IntentGraph | null>(null);
  const [decisions, setDecisions] = useState<IntentDecision[]>([]);
  const [loading, setLoading] = useState(false);
  // Hashes and signatures are pure functions of one file's content, so the same
  // index object is reused across refreshes and only edited files are re-derived.
  const index = useMemo(() => createIntentIndex(), []);
  // Two refreshes can overlap (a save and a decision add); the older one must not
  // publish its graph after the newer one already did.
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!workspaceRoot) { setGraph(null); setDecisions([]); return; }
    const attempt = ++generation.current;
    setLoading(true);
    try {
      const next = await buildIntentGraph(workspaceRoot, files, listDecisions(workspaceRoot), { index });
      if (generation.current !== attempt) return;
      setGraph(next);
      setDecisions(next.decisions);
    } finally {
      if (generation.current === attempt) setLoading(false);
    }
  }, [workspaceRoot, files, index]);
  useEffect(() => { void refresh(); }, [refresh]);
  const addDecision = useCallback(async (input: DecisionInput) => {
    if (!workspaceRoot) return null;
    const decision = createDecision(input);
    if (!saveDecision(decision)) return null;
    await refresh();
    return decision;
  }, [workspaceRoot, refresh]);
  const removeDecision = useCallback(async (id: string) => {
    if (workspaceRoot) { deleteDecision(id, workspaceRoot); await refresh(); }
  }, [workspaceRoot, refresh]);
  const importJson = useCallback((data: unknown) => {
    if (!workspaceRoot) return { imported: 0, skipped: 0, errors: ['no workspace open'] };
    const result = importIntent(data, workspaceRoot);
    void refresh();
    return result;
  }, [workspaceRoot, refresh]);
  const getContext = useCallback((request: IntentContextRequest) => graph ? extractIntentContext(graph, request) : { text: '', selected: [], tokensUsed: 0, staleCount: 0 }, [graph]);
  const answer = useCallback((question: string) => (graph ? answerDependencyQuestion(graph, question) : null), [graph]);
  return {
    graph,
    decisions,
    loading,
    indexedFiles: graph ? Object.keys(graph.fileHashes).length : 0,
    refresh,
    addDecision,
    removeDecision,
    exportJson: () => exportIntent(workspaceRoot ?? ''),
    importJson,
    getContext,
    answer
  };
}
