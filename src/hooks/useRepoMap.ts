import { useEffect, useMemo, useRef, useState } from 'react';
import { getDesktopBridge } from '../lib/desktop';
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

/**
 * Reads the folder once per tree change and keeps those bytes in memory for the
 * signature map. A folder is opened for a whole session, so one bounded read
 * beats re-deriving the map from whichever tabs happen to be open.
 */
export function useRepoMapFiles(
  workspaceId: string | null,
  tree: readonly MapTreeEntry[]
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

  useEffect(() => {
    const desktop = getDesktopBridge();
    if (!desktop?.loadFiles || !workspaceId || tree.length === 0) {
      generation.current += 1;
      setFiles([]);
      setLoading(false);
      return;
    }
    const id = ++generation.current;
    const paths = mapCandidates(tree);
    let cancelled = false;
    setLoading(true);
    void (async () => {
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
    })();
    return () => { cancelled = true; };
    // `revision` stands in for the tree contents, so the effect must not re-run
    // because a parent rendered a new array for the same folder.
  }, [workspaceId, revision]);

  return { files, signatures, loading };
}
