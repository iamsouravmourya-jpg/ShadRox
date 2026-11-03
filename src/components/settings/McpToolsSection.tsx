import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { getDesktopBridge, type McpServerConfig, type McpToolInfo } from '../../lib/desktop';
import { confirmAction } from '../../lib/confirm';
import { McpServerForm } from './McpServerForm';
import { McpToolPanel } from './McpToolPanel';
import {
  Card,
  EmptyState,
  Notice,
  SectionTitle,
  StatusBadge,
  dangerIconButtonClass,
  errorMessage,
  ghostButtonClass,
  secondaryButtonClass
} from './shared';

export interface McpToolsSectionProps {
  workspaceId?: string | null;
}

export function McpToolsSection(_props: McpToolsSectionProps) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServerConfig | 'new' | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connected, setConnected] = useState<Record<string, McpToolInfo[]>>({});
  const [connectErrors, setConnectErrors] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState('');

  const load = useCallback(async () => {
    const desktop = getDesktopBridge();
    if (!desktop) {
      setError('MCP servers are only available in the desktop app.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setServers(await desktop.listMcpServers());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (config: McpServerConfig) => {
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error('The desktop bridge is not available.');
    await desktop.saveMcpServer(config);
    setEditing(null);
    await load();
    setSavedMessage(`Saved "${config.name}".`);
    setError(null);
  };

  const remove = async (server: McpServerConfig) => {
    const confirmed = await confirmAction({
      title: `Delete MCP server "${server.name}"?`,
      body: 'Tools from this server become unavailable until it is added again.',
      confirmLabel: 'Delete',
      tone: 'danger'
    });
    if (!confirmed) return;
    const desktop = getDesktopBridge();
    if (!desktop) return;
    try {
      await desktop.deleteMcpServer(server.id);
      setConnected((previous) => {
        const next = { ...previous };
        delete next[server.id];
        return next;
      });
      if (activeId === server.id) setActiveId(null);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const connect = async (server: McpServerConfig) => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    setConnecting(server.id);
    setConnectErrors((previous) => ({ ...previous, [server.id]: '' }));
    try {
      await desktop.connectMcpServer(server.id);
      const tools = await desktop.listMcpTools(server.id);
      setConnected((previous) => ({ ...previous, [server.id]: tools }));
      setActiveId(server.id);
      setSelectedTool('');
    } catch (cause) {
      setConnectErrors((previous) => ({ ...previous, [server.id]: errorMessage(cause) }));
      setConnected((previous) => {
        const next = { ...previous };
        delete next[server.id];
        return next;
      });
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async (serverId: string) => {
    const desktop = getDesktopBridge();
    if (!desktop) return;
    try {
      await desktop.disconnectMcpServer(serverId);
    } catch (cause) {
      setConnectErrors((previous) => ({ ...previous, [serverId]: errorMessage(cause) }));
      return;
    }
    setConnected((previous) => {
      const next = { ...previous };
      delete next[serverId];
      return next;
    });
    if (activeId === serverId) setActiveId(null);
  };

  return (
    <div className="space-y-4">
      <section>
        <div className="flex items-center justify-between gap-2">
          <SectionTitle>MCP servers</SectionTitle>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => void load()} className={ghostButtonClass}>
              Reload
            </button>
            <button
              type="button"
              onClick={() => {
                setSavedMessage(null);
                setEditing('new');
              }}
              className={secondaryButtonClass}
            >
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
          </div>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
          Connect Model Context Protocol servers, list their tools, and call them. Every call goes through the
          desktop main process, which asks for your approval before it runs.
        </p>
      </section>

      {savedMessage && <Notice tone="ok">{savedMessage}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {editing && (
        <McpServerForm
          key={editing === 'new' ? 'new' : editing.id}
          server={editing === 'new' ? null : editing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading servers...
        </div>
      ) : servers.length === 0 && !editing ? (
        <EmptyState title="No MCP servers yet">
          Add a stdio command such as <code className="font-mono text-violet-300">npx</code> or an http endpoint.
          The list is stored by the desktop app.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => {
            const tools = connected[server.id];
            return (
              <Card key={server.id} className={`space-y-2 ${server.enabled ? '' : 'opacity-60'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-neutral-100">{server.name}</div>
                    <div className="truncate font-mono text-[10px] text-neutral-500">
                      {server.transport === 'stdio'
                        ? `stdio · ${server.command ?? ''}`
                        : `http · ${server.url ?? ''}`}
                    </div>
                  </div>
                  <StatusBadge enabled={server.enabled} />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {tools ? (
                    <button type="button" className={ghostButtonClass} onClick={() => void disconnect(server.id)}>
                      Disconnect
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      onClick={() => void connect(server)}
                      disabled={!server.enabled || connecting === server.id}
                    >
                      {connecting === server.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {connecting === server.id ? 'Connecting...' : 'Connect'}
                    </button>
                  )}
                  <button
                    type="button"
                    className={ghostButtonClass}
                    onClick={() => {
                      setSavedMessage(null);
                      setEditing(server);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={dangerIconButtonClass}
                    onClick={() => void remove(server)}
                    title={`Delete ${server.name}`}
                    aria-label={`Delete ${server.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {connectErrors[server.id] && <Notice tone="error">{connectErrors[server.id]}</Notice>}
                {tools && (
                  <div className="space-y-2">
                    {tools.length === 0 ? (
                      <p className="text-[11px] text-neutral-500">This server reported no tools.</p>
                    ) : (
                      <ul className="space-y-1">
                        {tools.map((tool) => (
                          <li key={tool.name}>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveId(server.id);
                                setSelectedTool(tool.name);
                                setConnectErrors((previous) => ({ ...previous, [server.id]: '' }));
                              }}
                              className="font-mono text-[11px] text-violet-300/80 transition-colors hover:text-violet-200"
                            >
                              {tool.name}
                            </button>
                            {tool.description && (
                              <span className="ml-2 text-[10px] text-neutral-500">{tool.description}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {activeId === server.id && tools.length > 0 && (
                      <McpToolPanel
                        key={`${server.id}:${selectedTool}`}
                        tools={tools}
                        initialTool={selectedTool}
                        onCall={(name, args) => {
                          const desktop = getDesktopBridge();
                          if (!desktop) return Promise.reject(new Error('The desktop bridge is not available.'));
                          return desktop.callMcpTool(server.id, name, args);
                        }}
                      />
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
