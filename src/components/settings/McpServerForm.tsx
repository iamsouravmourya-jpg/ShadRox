import { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import type { McpServerConfig } from '../../lib/desktop';
import {
  Card,
  Notice,
  SectionTitle,
  createId,
  dangerIconButtonClass,
  errorMessage,
  ghostButtonClass,
  inputClass,
  pairRows,
  pairsFromRows,
  primaryButtonClass,
  splitLines,
  type PairRow
} from './shared';

interface Draft {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  argsText: string;
  envRows: PairRow[];
  url: string;
  headersRows: PairRow[];
  enabled: boolean;
}

function toDraft(server: McpServerConfig | null): Draft {
  return {
    name: server?.name ?? '',
    transport: server?.transport ?? 'stdio',
    command: server?.command ?? '',
    argsText: (server?.args ?? []).join('\n'),
    envRows: pairRows(server?.env),
    url: server?.url ?? '',
    headersRows: pairRows(server?.headers),
    enabled: server?.enabled ?? true
  };
}

function PairRows({
  label,
  rows,
  stored,
  onChange
}: {
  label: string;
  rows: PairRow[];
  stored?: Record<string, string>;
  onChange: (rows: PairRow[]) => void;
}) {
  return (
    <div className="col-span-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</span>
        <button
          type="button"
          onClick={() => onChange([...rows, { key: '', value: '' }])}
          className="inline-flex items-center gap-1 text-[10px] text-violet-300 transition-colors hover:text-violet-200"
        >
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[10px] text-neutral-600">None configured.</p>
      ) : (
        rows.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              className={`${inputClass} min-w-0 flex-1`}
              value={row.key}
              onChange={(event) =>
                onChange(
                  rows.map((entry, at) => (at === index ? { ...entry, key: event.target.value } : entry))
                )
              }
              placeholder="KEY"
              autoComplete="off"
              spellCheck={false}
            />
            <input
              type="password"
              className={`${inputClass} min-w-0 flex-1`}
              value={row.value}
              onChange={(event) =>
                onChange(
                  rows.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry))
                )
              }
              placeholder={
                row.key.trim() && stored && Object.prototype.hasOwnProperty.call(stored, row.key.trim())
                  ? 'stored value kept'
                  : 'value'
              }
              autoComplete="new-password"
              spellCheck={false}
            />
            <button
              type="button"
              className={dangerIconButtonClass}
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
              aria-label="Remove entry"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

export interface McpServerFormProps {
  /** The server being edited, or null for a new one. */
  server: McpServerConfig | null;
  onSave: (config: McpServerConfig) => Promise<void>;
  onCancel: () => void;
}

export function McpServerForm({ server, onSave, onCancel }: McpServerFormProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(server));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!draft.name.trim()) {
      setError('Give the server a name.');
      return;
    }
    if (draft.transport === 'stdio' && !draft.command.trim()) {
      setError('A stdio server needs a command.');
      return;
    }
    if (draft.transport === 'http' && !/^https?:\/\//i.test(draft.url.trim())) {
      setError('An http server needs a URL starting with http:// or https://.');
      return;
    }
    const base = {
      id: server?.id ?? createId('mcp'),
      name: draft.name.trim(),
      enabled: draft.enabled
    };
    const config: McpServerConfig =
      draft.transport === 'stdio'
        ? {
            ...base,
            transport: 'stdio',
            command: draft.command.trim(),
            args: splitLines(draft.argsText),
            env: pairsFromRows(draft.envRows, server?.env)
          }
        : {
            ...base,
            transport: 'http',
            url: draft.url.trim(),
            headers: pairsFromRows(draft.headersRows, server?.headers)
          };
    setSaving(true);
    setError(null);
    try {
      await onSave(config);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-2">
      <SectionTitle>{server ? 'Edit server' : 'New server'}</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 text-[10px] uppercase tracking-wider text-neutral-500">
          Name
          <input
            className={`${inputClass} mt-1`}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="filesystem"
            autoComplete="off"
          />
        </label>
        <label className="text-[10px] uppercase tracking-wider text-neutral-500">
          Transport
          <select
            className={`${inputClass} mt-1 cursor-pointer`}
            value={draft.transport}
            onChange={(event) =>
              setDraft({ ...draft, transport: event.target.value === 'http' ? 'http' : 'stdio' })
            }
          >
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-[11px] text-neutral-300">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            className="accent-violet-400"
          />
          Enabled
        </label>
        {draft.transport === 'stdio' ? (
          <>
            <label className="col-span-2 text-[10px] uppercase tracking-wider text-neutral-500">
              Command
              <input
                className={`${inputClass} mt-1`}
                value={draft.command}
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                placeholder="npx"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="col-span-2 text-[10px] uppercase tracking-wider text-neutral-500">
              Arguments (one per line)
              <textarea
                rows={3}
                className={`${inputClass} mt-1 resize-y`}
                value={draft.argsText}
                onChange={(event) => setDraft({ ...draft, argsText: event.target.value })}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\work'}
                spellCheck={false}
              />
            </label>
            <PairRows
              label="Environment variables (KEY=VALUE)"
              rows={draft.envRows}
              stored={server?.env}
              onChange={(envRows) => setDraft({ ...draft, envRows })}
            />
          </>
        ) : (
          <>
            <label className="col-span-2 text-[10px] uppercase tracking-wider text-neutral-500">
              URL
              <input
                className={`${inputClass} mt-1`}
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                placeholder="https://example.com/mcp"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <PairRows
              label="Headers (KEY=VALUE)"
              rows={draft.headersRows}
              stored={server?.headers}
              onChange={(headersRows) => setDraft({ ...draft, headersRows })}
            />
          </>
        )}
      </div>
      <p className="text-[10px] leading-relaxed text-neutral-500">
        Secret values are masked and never shown after saving. Leave a value blank to keep what is already
        stored; remove a row to drop the key.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <button type="button" className={ghostButtonClass} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className={primaryButtonClass} onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {saving ? 'Saving...' : 'Save server'}
        </button>
      </div>
    </Card>
  );
}
