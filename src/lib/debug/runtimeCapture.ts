import type { DebugDesktopAPI } from '../desktop';
import type { FailureReceipt } from '../repairProof';
import { globalProofLedger } from '../proofLedger';

/**
 * Runtime truth for the self-healing loop.
 *
 * When the debugger stops on an exception while a failure receipt is open, the
 * stopped frame and its locals are the most precise failure context the app can
 * obtain. They are captured here, in the renderer, because that is where the
 * receipt ledger lives; the values are already bounded by the main-process DAP
 * host, and are bounded again before they enter a receipt.
 */

export const RUNTIME_CAPTURE_LIMITS = Object.freeze({
  frames: 20,
  scopes: 3,
  variablesPerScope: 30,
  valueChars: 500
});

export type DebugRuntime = NonNullable<FailureReceipt['runtime']>;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Snapshot the paused frame plus the first few scopes. Returns null when the
 * session is not paused, or when the adapter refuses the requests.
 */
export async function captureDebugRuntime(
  debug: DebugDesktopAPI,
  workspaceId: string
): Promise<DebugRuntime | null> {
  let frames;
  try {
    frames = await debug.stack(workspaceId);
  } catch {
    return null;
  }
  if (frames.length === 0) return null;

  const runtime: DebugRuntime = {
    frames: frames.slice(0, RUNTIME_CAPTURE_LIMITS.frames).map((frame) => ({
      name: clip(frame.name, 200),
      file: frame.file ?? undefined,
      line: frame.line ?? undefined,
      column: frame.column ?? undefined
    })),
    scopes: []
  };

  const top = frames[0];
  if (!top) return runtime;
  try {
    const scopes = await debug.scopes(workspaceId, top.id);
    for (const scope of scopes.slice(0, RUNTIME_CAPTURE_LIMITS.scopes)) {
      const variables = await debug.variables(workspaceId, scope.variablesReference);
      runtime.scopes!.push({
        name: clip(scope.name, 200),
        variables: variables.slice(0, RUNTIME_CAPTURE_LIMITS.variablesPerScope).map((variable) => ({
          name: clip(variable.name, 200),
          value: clip(variable.value, RUNTIME_CAPTURE_LIMITS.valueChars),
          type: variable.type ? clip(variable.type, 100) : undefined
        }))
      });
    }
  } catch {
    // Scopes are optional evidence; the frame list alone is still useful.
  }
  return runtime;
}

/**
 * Attach a runtime snapshot to the newest receipt that is still open
 * (`captured` or `repair_proposed`). Returns the receipt id, or null when no
 * open receipt exists — the caller must not invent one.
 */
export function attachRuntimeToOpenReceipt(runtime: DebugRuntime | null): string | null {
  if (!runtime || (runtime.frames?.length ?? 0) === 0) return null;
  const open = globalProofLedger
    .getAllFailureReceipts()
    .find((receipt) => receipt.status === 'captured' || receipt.status === 'repair_proposed');
  if (!open) return null;
  globalProofLedger.updateFailureReceipt({ ...open, runtime });
  return open.id;
}
