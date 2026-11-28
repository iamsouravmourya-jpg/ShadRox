import { useEffect, useMemo, useRef, useState } from 'react';
import { getDesktopBridge } from '../lib/desktop';
import { hydrateFileTagsCache, LARGE_REPO_THRESHOLD, persistFileTagsCache } from '../lib/agent/repoMap';
import { hydrateSemanticIndex, warmSemanticIndexFromFiles } from '../lib/agent/semanticIndex';
import {
  indexSignatures,
  mapCandidates,
  MAX_MAP_FILE_BYTES,
  MAX_MAP_TOTAL_BYTES,
  type MapInputFile,
  type MapTreeEntry,
  type Signature
} from '../lib/repoMap';

const BATCH = 150;

export type { MapTreeEntry };

export interface UseRepoMapOptions {
  activeFilePath?: string | null;
  openTabPaths?: readonly string[];
}

function derivePriorityPrefixes(options?: UseRepoMapOptions): string[] {
  const prefixes = new Set<string>();
  const seeds = [options?.activeFilePath ?? '', ...(options?.openTabPaths ?? [])].filter(Boolean);
  for (const raw of seeds) {
    const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = norm.split('/').filter(Boolean);
    if (parts.length <= 1) continue;
    if (/^(?:packages|apps|services|modules|libs)$/i.test(parts[0]) && parts.length >= 2) {
      prefixes.add(`${parts[0]}/${parts[1]}/`);
    } else {
      prefixes.add(`${parts[0]}/`);
    }
  }
  return [...prefixes];
}

/**
 * Reads the folder once per tree change and keeps those bytes in memory for the
 * signature map. Hydrates persisted OryTree FileTags + semantic indexes from
 * Electron userData cache / IndexedDB so cold startups on huge repos are fast,
 * and prioritizes active packages on enterprise (>3,000-file) trees.
 */
export function useRepoMapFiles(
  workspaceId: string | null,
  tree: readonly MapTreeEntry[],
  options?: UseRepoMapOptions
): { files: MapInputFile[]; signatures: ReadonlyMap<string, Signature[]>; loading: boolean } {
  const [files, setFiles] = useState<MapInputFile[]>([]);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const signatures = useMemo(() => indexSignatures(files), [files]);
  // Sizes as well as count: a file that grew tenfold changes the map.
  const revision = useMemo(
    () => `${tree.length}:${tree.reduce((sum, entry) => sum + entry.size + entry.path.length, 0)}`,
    [tree]
  );
  const priorityPrefixes = useMemo(
    () => derivePriorityPrefixes(options),
    [options?.activeFilePath, options?.openTabPaths?.join('|')]
  );
  const priorityKey = tree.length > LARGE_REPO_THRESHOLD ? priorityPrefixes.join('|') : '';

  useEffect(() => {
    const desktop = getDesktopBridge();
    if (!desktop?.loadFiles || !workspaceId || tree.length === 0) {
      generation.current += 1;
      setFiles([]);
      setLoading(false);
      return;
    }
    const id = ++generation.current;
    const paths = mapCandidates(tree, { priorityPrefixes });
    let cancelled = false;
    setLoading(true);
    void (async () => {
      // Hydrate persisted >1.5MB FileTags + semantic index snapshots early for instant Round-0 queries.
      await Promise.all([
        hydrateFileTagsCache(workspaceId),
        hydrateSemanticIndex(workspaceId)
      ]);
      if (cancelled || generation.current !== id) return;

      const collected: MapInputFile[] = [];
      let read = 0;
      for (let index = 0; index < paths.length && read < MAX_MAP_TOTAL_BYTES; index += BATCH) {
        try {
          const page = await desktop.loadFiles(workspaceId, paths.slice(index, index + BATCH), {
            maxBytesPerFile: MAX_MAP_FILE_BYTES,
            maxTotalBytes: MAX_MAP_TOTAL_BYTES - read
          });
          if (cancelled || generation.current !== id) return;
          for (const file of page.files) {
            read += file.content.length;
            collected.push({ name: file.name, content: file.content });
          }
        } catch {
          // A folder that went away mid-read keeps the partial map; the next
          // tree change re-runs this effect from scratch.
          break;
        }
      }
      if (cancelled || generation.current !== id) return;
      setFiles(collected);
      setLoading(false);
      // Warm cached semantic index + persist updated FileTags snapshot off localStorage.
      warmSemanticIndexFromFiles(workspaceId, collected);
      void persistFileTagsCache(workspaceId);
    })();
    return () => { cancelled = true; };
    // `revision` stands in for the tree contents, so the effect must not re-run
    // because a parent rendered a new array for the same folder.
  }, [workspaceId, revision, priorityKey]);

  return { files, signatures, loading };
}
