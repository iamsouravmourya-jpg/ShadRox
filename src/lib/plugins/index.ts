/**
 * Local plugin system: declarations in, selected actions out.
 *
 * See `types.ts` for the security model: plugins are JSON, never executable
 * code, and the engine only selects actions for the app's existing
 * approval-gated command path and normal chat path to perform.
 */

export * from './types';
export * from './manifest';
export * from './loader';
export * from './hook-engine';
