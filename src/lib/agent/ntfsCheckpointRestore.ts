/**
 * Windows NTFS & OneDrive-safe checkpoint restore primitives.
 *
 * Handles two real-world Windows failures cleanly:
 *   1. Zero-change turns (`changes.length === 0 && !gitChanged && addedPreviews.length === 0`):
 *      restoring gracefully returns `{ ok: true, status: 'noop', message: 'No file changes in this turn to undo.' }`
 *      instead of throwing `"This machine snapshot cannot be restored."`.
 *   2. Transient NTFS/OneDrive/Windows-Defender file locks (`EBUSY`, `EPERM`, `EACCES`):
 *      retries up to 5 attempts with exponential backoff (`50ms -> 100ms -> 200ms -> 400ms -> 800ms`),
 *      clearing Windows read-only attributes (`0o666`) before retrying when `EPERM`/`EACCES` occurs.
 */

export const NTFS_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];

const RETRYABLE_FS_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);

export interface NtfsRetryOptions {
  delaysMs?: readonly number[];
  targetPath?: string;
  clearReadOnly?: (targetPath: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, code: string, delayMs: number) => void;
}

export function extractFsErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string') {
    const match = message.match(/\b(EBUSY|EPERM|EACCES|ENOENT)\b/i);
    if (match) return match[1].toUpperCase();
  }
  return '';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withNtfsRetry<T>(
  operation: () => Promise<T>,
  options: NtfsRetryOptions = {}
): Promise<T> {
  const delays = options.delaysMs ?? NTFS_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const code = extractFsErrorCode(error);
      if (!RETRYABLE_FS_CODES.has(code) || attempt >= delays.length) {
        throw error;
      }
      if ((code === 'EPERM' || code === 'EACCES') && options.targetPath && options.clearReadOnly) {
        try {
          await options.clearReadOnly(options.targetPath);
        } catch {
          /* clearing read-only is best-effort before backoff retry */
        }
      }
      const delayMs = delays[attempt];
      options.onRetry?.(attempt + 1, code, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export interface CheckpointRestoreOutcome {
  ok: boolean;
  status: 'restored' | 'noop' | 'cancelled' | 'partial' | 'failed';
  message: string;
}

export interface SafeRestoreSnapshotSummary {
  filesCount: number;
  gitChanged: boolean;
  addedPreviewsCount: number;
  omissionsCount: number;
  canRestore: boolean;
  overlapped: boolean;
  alreadyRestored: boolean;
  blockedReason?: string | null;
}

export function evaluateZeroChangeRestore(summary: SafeRestoreSnapshotSummary): CheckpointRestoreOutcome | null {
  if (summary.alreadyRestored) {
    return {
      ok: true,
      status: 'noop',
      message: 'This checkpoint was already restored.'
    };
  }
  if (
    !summary.overlapped &&
    summary.omissionsCount === 0 &&
    summary.filesCount === 0 &&
    !summary.gitChanged &&
    summary.addedPreviewsCount === 0
  ) {
    return {
      ok: true,
      status: 'noop',
      message: 'No file changes in this turn to undo.'
    };
  }
  return null;
}
