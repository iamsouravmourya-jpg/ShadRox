import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { McpCallResult, McpToolInfo } from '../../lib/desktop';
import { Notice, errorMessage, inputClass, primaryButtonClass } from './shared';

export interface McpToolPanelProps {
  tools: McpToolInfo[];
  /** A tool picked from the list; the panel remounts when this changes. */
  initialTool?: string;
  onCall: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
}

/** One server's tool picker, JSON arguments, and result surface. */
export function McpToolPanel({ tools, initialTool = '', onCall }: McpToolPanelProps) {
  const [toolName, setToolName] = useState(initialTool);
  const [argsText, setArgsText] = useState('{}');
  const [result, setResult] = useState<McpCallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calling, setCalling] = useState(false);

  const run = async () => {
    if (!toolName) {
      setError('Pick a tool first.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsText.trim() || '{}');
    } catch (cause) {
      setError(`Arguments are not valid JSON: ${errorMessage(cause)}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Arguments must be a JSON object, for example {}.');
      return;
    }
    setCalling(true);
    setError(null);
    setResult(null);
    try {
      setResult(await onCall(toolName, parsed as Record<string, unknown>));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCalling(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <label className="block text-[10px] uppercase tracking-wider text-neutral-500">
        Tool
        <select
          className={`${inputClass} mt-1 cursor-pointer`}
          value={toolName}
          onChange={(event) => {
            setToolName(event.target.value);
            setResult(null);
            setError(null);
          }}
        >
          <option value="">Select a tool</option>
          {tools.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.name}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 block text-[10px] uppercase tracking-wider text-neutral-500">
        Arguments (JSON)
        <textarea
          rows={3}
          className={`${inputClass} mt-1 resize-y`}
          value={argsText}
          onChange={(event) => setArgsText(event.target.value)}
          spellCheck={false}
        />
      </label>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-neutral-500">The main process asks for approval before the call.</span>
        <button
          type="button"
          className={primaryButtonClass}
          onClick={() => void run()}
          disabled={calling || !toolName}
        >
          {calling && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {calling ? 'Running...' : 'Call tool'}
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {result && (
        <div
          className={`mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 font-mono text-[10px] ${
            result.isError
              ? 'border-red-900/60 bg-red-950/20 text-red-400'
              : 'border-violet-300/25 bg-violet-500/[.07] text-violet-200'
          }`}
        >
          {result.text || JSON.stringify(result.content ?? null)}
        </div>
      )}
    </div>
  );
}
