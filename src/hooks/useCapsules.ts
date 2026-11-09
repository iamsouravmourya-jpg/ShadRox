import { useCallback, useEffect, useState } from 'react';
import { buildCapsule } from '../lib/capsules/capture';
import { resolveReplay, resolveRevert } from '../lib/capsules/sandbox';
import {
  deleteCapsule,
  exportCapsules,
  getCapsule,
  importCapsules,
  listCapsules,
  saveCapsule
} from '../lib/capsules/store';
import type {
  CapsuleCaptureInput,
  CapsuleExport,
  ChangeCapsule,
  ReplayPlan
} from '../lib/capsules/types';

export interface UseCapsules {
  capsules: ChangeCapsule[];
  loading: boolean;
  refresh: () => Promise<void>;
  capture: (input: CapsuleCaptureInput) => Promise<ChangeCapsule | null>;
  planReplay: (id: string, currentFiles: Array<{ path: string; content: string }>) => Promise<ReplayPlan>;
  planRevert: (id: string, currentFiles: Array<{ path: string; content: string }>) => Promise<ReplayPlan>;
  remove: (id: string) => Promise<void>;
  exportJson: () => Promise<CapsuleExport>;
  importJson: (data: unknown) => Promise<{ imported: number; skipped: number; errors: string[] }>;
}

const MISSING_CAPSULE: ReplayPlan = {
  ok: false,
  jobs: [],
  conflicts: [{ path: '', reason: 'FILE_MISSING', detail: 'capsule not found' }]
};

export function useCapsules(workspaceRoot: string | null): UseCapsules {
  const [capsules, setCapsules] = useState<ChangeCapsule[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (workspaceRoot === null) return;
    setLoading(true);
    try {
      setCapsules(await listCapsules(workspaceRoot));
    } finally {
      setLoading(false);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    if (workspaceRoot === null) {
      setCapsules([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listCapsules(workspaceRoot)
      .then((listed) => { if (!cancelled) setCapsules(listed); })
      .catch(() => { if (!cancelled) setCapsules([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  const capture = useCallback(async (captureInput: CapsuleCaptureInput): Promise<ChangeCapsule | null> => {
    if (workspaceRoot === null) return null;
    const capsule = await buildCapsule(captureInput);
    // A turn that changed no files is not a change capsule; skip the timeline noise.
    if (capsule.diffs.length === 0) return null;
    if (!(await saveCapsule(capsule))) return null;
    await refresh();
    return capsule;
  }, [workspaceRoot, refresh]);

  // Plans only — the app applies jobs through the safe write path, so opening
  // a folder never grants implicit disk writes from here.
  const planReplay = useCallback(async (
    id: string,
    currentFiles: Array<{ path: string; content: string }>
  ): Promise<ReplayPlan> => {
    const capsule = await getCapsule(id);
    if (!capsule) return MISSING_CAPSULE;
    return resolveReplay(capsule, currentFiles);
  }, []);

  const planRevert = useCallback(async (
    id: string,
    currentFiles: Array<{ path: string; content: string }>
  ): Promise<ReplayPlan> => {
    const capsule = await getCapsule(id);
    if (!capsule) return MISSING_CAPSULE;
    return resolveRevert(capsule, currentFiles);
  }, []);

  const remove = useCallback(async (id: string): Promise<void> => {
    await deleteCapsule(id);
    await refresh();
  }, [refresh]);

  const exportJson = useCallback(async (): Promise<CapsuleExport> => {
    return exportCapsules(workspaceRoot ?? '');
  }, [workspaceRoot]);

  const importJson = useCallback(async (data: unknown) => {
    if (workspaceRoot === null) return { imported: 0, skipped: 0, errors: ['no workspace open'] };
    const result = await importCapsules(data, workspaceRoot);
    await refresh();
    return result;
  }, [workspaceRoot, refresh]);

  return { capsules, loading, refresh, capture, planReplay, planRevert, remove, exportJson, importJson };
}