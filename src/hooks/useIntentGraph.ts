import { useCallback, useEffect, useState } from 'react';
import { buildIntentGraph, extractIntentContext } from '../lib/intent/graph';
import { createDecision, deleteDecision, exportIntent, importIntent, listDecisions, saveDecision } from '../lib/intent/store';
import type { DecisionInput, IntentContextRequest, IntentDecision, IntentExport, IntentFile, IntentGraph } from '../lib/intent/types';

export interface UseIntentGraph {
  graph: IntentGraph | null;
  decisions: IntentDecision[];
  loading: boolean;
  refresh: () => Promise<void>;
  addDecision: (input: DecisionInput) => Promise<IntentDecision | null>;
  removeDecision: (id: string) => Promise<void>;
  exportJson: () => IntentExport;
  importJson: (data: unknown) => { imported: number; skipped: number; errors: string[] };
  getContext: (request: IntentContextRequest) => ReturnType<typeof extractIntentContext>;
}

export function useIntentGraph(workspaceRoot: string | null, files: readonly IntentFile[]): UseIntentGraph {
  const [graph, setGraph] = useState<IntentGraph | null>(null);
  const [decisions, setDecisions] = useState<IntentDecision[]>([]);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!workspaceRoot) { setGraph(null); setDecisions([]); return; }
    setLoading(true);
    try {
      const next = await buildIntentGraph(workspaceRoot, files, listDecisions(workspaceRoot));
      setGraph(next);
      setDecisions(next.decisions);
    } finally { setLoading(false); }
  }, [workspaceRoot, files]);
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
  return { graph, decisions, loading, refresh, addDecision, removeDecision, exportJson: () => exportIntent(workspaceRoot ?? ''), importJson, getContext };
}
