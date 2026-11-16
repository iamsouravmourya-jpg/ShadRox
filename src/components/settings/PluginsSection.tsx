import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Loader2, RefreshCw } from 'lucide-react';
import { getDesktopBridge } from '../../lib/desktop';
import {
  hashPluginManifest,
  notifyWorkspaceConfigChanged,
  readPluginConsent,
  setPluginEnabled
} from '../../lib/workspaceConsent';
import {
  discoverPluginManifests,
  loadPlugins,
  type LoadedPlugin,
  type PluginHookWhen,
  type PluginLoadEntry,
  type PluginLoadError
} from '../../lib/plugins';
import {
  Card,
  EmptyState,
  Notice,
  SectionTitle,
  StatusBadge,
  errorMessage,
  ghostButtonClass,
  secondaryButtonClass
} from './shared';

export interface PluginsSectionProps {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

type PluginView = LoadedPlugin & { manifestHash: string; consentChanged: boolean };

const LAYOUT = ['.shadrox/', '  plugins/', '    my-plugin/', '      plugin.json'].join('\n');

/** Absolute paths from the bridge still have to resolve inside the workspace. */
function workspaceRelative(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const marker = '.shadrox/plugins/';
  const index = normalized.indexOf(marker);
  if (index >= 0) return normalized.slice(index);
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function describeWhen(when: PluginHookWhen): string {
  if (when.glob) return when.glob;
  if (when.command) return when.command;
  if (when.intervalMinutes !== undefined) return `every ${when.intervalMinutes} min`;
  return 'always';
}

export function PluginsSection({ workspaceId, workspaceRoot }: PluginsSectionProps) {
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [errors, setErrors] = useState<PluginLoadError[]>([]);
  const [scanIssues, setScanIssues] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setPlugins([]);
      setErrors([]);
      setScanIssues([]);
      setScanError(null);
      setLoading(false);
      return;
    }
    const desktop = getDesktopBridge();
    if (!desktop) {
      setScanError('Plugins are only available in the desktop app.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setScanError(null);
    try {
      const result = await desktop.scanPlugins(workspaceId);
      const entries: PluginLoadEntry[] = (result.files ?? []).map((entry) => ({
        path: workspaceRelative(entry.path),
        content: entry.content
      }));
      const manifestPaths = discoverPluginManifests(entries.map((entry) => entry.path));
      const manifests = entries.filter((entry) => manifestPaths.includes(entry.path));
      const loaded = loadPlugins(manifests);
      const consent = readPluginConsent(workspaceRoot);
      const byPath = new Map(manifests.map((entry) => [entry.path, entry.content]));
      setPlugins(await Promise.all(loaded.plugins.map(async (plugin) => {
        const content = byPath.get(plugin.sourcePath);
        if (content === undefined) {
          throw new Error(`Plugin manifest content was unavailable for ${plugin.sourcePath}.`);
        }
        const manifestHash = await hashPluginManifest(content);
        const storedHash = consent.get(plugin.manifest.id);
        return {
          ...plugin,
          manifestHash,
          enabled: storedHash === manifestHash,
          consentChanged: storedHash !== undefined && storedHash !== manifestHash
        };
      })));
      setErrors(loaded.errors);
      setScanIssues(result.errors ?? []);
    } catch (cause) {
      setScanError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, workspaceRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (plugin: PluginView) => {
    if (!workspaceRoot) {
      setScanError('Open a folder workspace before enabling plugins.');
      return;
    }
    setScanError(null);
    setToggling(plugin.manifest.id);
    try {
      setPluginEnabled(workspaceRoot, plugin.manifest.id, !plugin.enabled, plugin.manifestHash);
      setPlugins((previous) =>
        previous.map((entry) =>
          entry.manifest.id === plugin.manifest.id ? { ...entry, enabled: !entry.enabled } : entry
        )
      );
      notifyWorkspaceConfigChanged();
    } catch (cause) {
      setScanError(errorMessage(cause));
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className="space-y-4">
      <section>
        <div className="flex items-center justify-between gap-2">
          <SectionTitle>Plugins</SectionTitle>
          <button
            type="button"
            onClick={() => void load()}
            className={ghostButtonClass}
            disabled={!workspaceId || loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Rescan
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-4">
          Plugins are declarative JSON under{' '}
          <code className="font-mono text-accent">.shadrox/plugins</code>. Nothing runs until you enable a
          plugin here; enabling is stored per workspace, outside the repository, and commands still go through the
          normal approval path.
        </p>
      </section>

      {scanError && <Notice tone="error">{scanError}</Notice>}

      {scanIssues.length > 0 && (
        <div className="space-y-0.5 rounded-2xl border border-warn/30 bg-warn/10 px-3 py-2">
          {scanIssues.map((issue, index) => (
            <p
              key={`${index}-${issue}`}
              className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-warn"
            >
              {issue}
            </p>
          ))}
        </div>
      )}

      {!workspaceId ? (
        <EmptyState title="No workspace open">
          Open a folder to load its plugins. Each plugin lives in its own folder:
          <pre className="mt-2 whitespace-pre rounded-lg border border-line bg-overlay p-2 font-mono text-[10px] text-accent">
            {LAYOUT}
          </pre>
        </EmptyState>
      ) : loading ? (
        <div className="flex items-center gap-2 text-[11px] text-ink-4">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning workspace...
        </div>
      ) : plugins.length === 0 && errors.length === 0 ? (
        <EmptyState title="No plugins found">
          Add a manifest at <code className="font-mono text-accent">.shadrox/plugins/&lt;id&gt;/plugin.json</code>:
          <pre className="mt-2 whitespace-pre rounded-lg border border-line bg-overlay p-2 font-mono text-[10px] text-accent">
            {LAYOUT}
          </pre>
        </EmptyState>
      ) : (
        <>
          <div className="space-y-2">
            {plugins.map((plugin) => (
              <Card
                key={plugin.manifest.id}
                className={`space-y-1 ${plugin.enabled ? '' : 'opacity-60'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-medium text-ink">
                        {plugin.manifest.name}
                      </span>
                      <span className="font-mono text-[10px] text-accent">v{plugin.manifest.version}</span>
                      <StatusBadge enabled={plugin.enabled} />
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-ink-4">
                      {plugin.sourcePath}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void toggle(plugin)}
                    disabled={toggling === plugin.manifest.id}
                    className={secondaryButtonClass}
                  >
                    {toggling === plugin.manifest.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle className="h-3.5 w-3.5" />
                    )}
                    {plugin.enabled ? 'Disable' : 'Enable'}
                  </button>
                </div>
                {plugin.manifest.description && (
                  <p className="text-[11px] leading-relaxed text-ink-3">{plugin.manifest.description}</p>
                )}
                {plugin.consentChanged && !plugin.enabled && (
                  <p className="text-[11px] text-warn">
                    This manifest changed since you enabled it. Review its updated actions and enable it again to re-consent.
                  </p>
                )}
                <ul className="space-y-1">
                  {plugin.manifest.hooks.map((hook, index) => (
                    <li key={index} className="flex flex-wrap gap-x-1 font-mono text-[10px] text-ink-3">
                      <span className="text-accent">{hook.event}</span>
                      {hook.when && <span>· {describeWhen(hook.when)}</span>}
                      <span>→</span>
                      <span className="break-all">
                        {hook.action.type === 'command'
                          ? hook.action.argv
                          : `prompt: ${hook.action.prompt}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>

          {errors.length > 0 && (
            <div className="space-y-2 rounded-2xl border border-danger/30 bg-danger/10 p-4">
              <p className="text-[11px] uppercase tracking-wider text-danger">
                Manifests that could not load ({errors.length})
              </p>
              {errors.map((entry) => (
                <div key={entry.path} className="space-y-0.5">
                  <p className="break-all font-mono text-[10px] text-danger">{entry.path}</p>
                  {entry.errors.map((message, index) => (
                    <p
                      key={`${entry.path}-${index}`}
                      className="whitespace-pre-wrap break-words font-mono text-[10px] text-danger"
                    >
                      {message}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
