import type { DebugLaunchConfig } from '../desktop';
import { inferLaunchConfigsFromNames } from '../../../electron/debug-autoconfig.cjs';

/**
 * Renderer-facing wrapper over the shared inference engine in
 * `electron/debug-autoconfig.cjs`. The main process runs the same code against
 * the real filesystem when `shadrox.debug.json` is absent, so a configuration
 * shown here is one `debug:start` can actually resolve and launch.
 *
 * The renderer has no filesystem access, so paths the workspace walk skips
 * (node_modules binaries) can only be confirmed by names already present in
 * the supplied file list.
 */
export function inferAutoDebugConfigs(
  _workspaceRoot: string,
  files: Array<{ name: string; content?: string }>
): DebugLaunchConfig[] {
  const names = new Set(files.map((file) => file.name.replace(/\\/g, '/')));
  return inferLaunchConfigsFromNames(names, () => false, null) as DebugLaunchConfig[];
}
