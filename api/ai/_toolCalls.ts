import type { NativeToolDefinition, ToolCallEntry } from './_types.js';

type OpenAiToolCallParts = {
  id: string;
  name: string;
  arguments: string;
};

/** Reassembles the fragmented `delta.tool_calls` fields emitted by OpenAI APIs. */
export class OpenAiToolCallCollector {
  private readonly calls = new Map<number, OpenAiToolCallParts>();

  add(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const [fallbackIndex, item] of raw.entries()) {
      if (!item || typeof item !== 'object') continue;
      const call = item as Record<string, unknown>;
      const index = Number.isSafeInteger(call.index) ? Number(call.index) : fallbackIndex;
      const fn = call.function && typeof call.function === 'object'
        ? call.function as Record<string, unknown>
        : {};
      const current = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof call.id === 'string') current.id += call.id;
      if (typeof fn.name === 'string') current.name += fn.name;
      if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
      this.calls.set(index, current);
    }
  }

  values(): ToolCallEntry[] {
    return [...this.calls.entries()]
      .sort(([left], [right]) => left - right)
      .filter(([, call]) => Boolean(call.name))
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.arguments
      }));
  }
}

export function rejectsNativeTools(payload: string): boolean {
  return /tools?|function_call|tool_choice/i.test(payload) &&
    /unsupported|not supported|unknown|invalid|unrecognized|not allowed|does not support/i.test(payload);
}

export function nativeToolDefinitions(value: unknown): NativeToolDefinition[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid tool definitions.');
  const definitions = value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid tool definition.');
    const candidate = entry as Record<string, unknown>;
    const parameters = candidate.parameters;
    if (typeof candidate.name !== 'string' || !/^[A-Za-z0-9_-]{1,88}$/.test(candidate.name) ||
      typeof candidate.description !== 'string' || candidate.description.length > 500 ||
      !parameters || typeof parameters !== 'object' || Array.isArray(parameters) ||
      (parameters as Record<string, unknown>).type !== 'object' ||
      !(parameters as Record<string, unknown>).properties ||
      typeof (parameters as Record<string, unknown>).properties !== 'object' ||
      Array.isArray((parameters as Record<string, unknown>).properties)) {
      throw new Error('Invalid tool definition.');
    }
    return {
      name: candidate.name,
      description: candidate.description,
      parameters: parameters as Record<string, unknown>
    };
  });
  if (JSON.stringify(definitions).length > 24_000) throw new Error('Tool definitions are too large.');
  return definitions;
}
