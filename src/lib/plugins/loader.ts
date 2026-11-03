/**
 * Plugin discovery and loading, as pure functions over a file list.
 *
 * The app already has a workspace file listing and a file reader; this module
 * turns those into manifests without touching the disk itself, which keeps it
 * testable and keeps I/O in the Electron layer. A manifest is accepted only
 * when it parses cleanly; the first plugin to claim an id wins and later
 * claims become explicit errors rather than silent shadowing.
 */

import { parsePluginManifest } from './manifest';
import type { LoadedPlugin, PluginLoadError } from './types';

const MANIFEST_PATTERN = /^\.shadrox\/plugins\/([^/]+)\/plugin\.json$/;
const MAX_PATH_LENGTH = 1024;

export interface PluginLoadEntry {
  path: string;
  content: string;
}

/** Workspace-relative, forward-slash form; null for anything that escapes. */
function normalizeWorkspacePath(file: string): string | null {
  if (typeof file !== 'string') return null;
  let path = file.trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (!path || path.length > MAX_PATH_LENGTH || path.includes('\0')) return null;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

/** Manifests exactly at `.shadrox/plugins/<id>/plugin.json`, sorted and unique. */
export function discoverPluginManifests(files: readonly string[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const normalized = normalizeWorkspacePath(file);
    if (!normalized) continue;
    if (MANIFEST_PATTERN.test(normalized)) found.add(normalized);
  }
  return [...found].sort();
}

export function loadPlugins(entries: readonly PluginLoadEntry[]): {
  plugins: LoadedPlugin[];
  errors: PluginLoadError[];
} {
  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];
  const owners = new Map<string, string>();

  for (const entry of entries) {
    const path = typeof entry?.path === 'string' ? entry.path : '';
    const content = typeof entry?.content === 'string' ? entry.content : '';
    if (!path) {
      errors.push({ path, errors: ['path: manifest path is missing'] });
      continue;
    }
    const parsed = parsePluginManifest(content, path);
    if (!parsed.manifest) {
      errors.push({ path, errors: parsed.errors });
      continue;
    }
    const owner = owners.get(parsed.manifest.id);
    if (owner) {
      errors.push({ path, errors: [`id: "${parsed.manifest.id}" is already declared by ${owner}`] });
      continue;
    }
    owners.set(parsed.manifest.id, path);
    plugins.push({ manifest: parsed.manifest, sourcePath: path, enabled: parsed.manifest.enabled });
  }

  plugins.sort((a, b) => {
    if (a.manifest.id < b.manifest.id) return -1;
    if (a.manifest.id > b.manifest.id) return 1;
    return 0;
  });
  return { plugins, errors };
}
