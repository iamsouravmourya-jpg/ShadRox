/**
 * Who actually pays for a request. `byok` means the caller's own provider key
 * carries it — ShadRox charges nothing and applies no shared-spend cap.
 * `shared` is the path an operator could enable server-side; in this product it
 * is never selected, and it is kept so the request envelope still records which
 * credential answered.
 */
export type ResolvedPayer = 'byok' | 'shared';

/**
 * ShadRox sells no shared-key access, so the client surface is closed at the
 * source rather than hidden behind a flag a user could toggle. The server keeps
 * its own independent gate (api/ai/_access.ts needs SHADROX_ALLOW_SHARED_KEY=1
 * plus that provider's key in its environment), so a request claiming the
 * shared path is refused even here.
 */
export const SHARED_KEY_ENABLED = false;
