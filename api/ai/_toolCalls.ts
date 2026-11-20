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
      let index: number;
      if (Number.isSafeInteger(call.index)) {
        index = Number(call.index);
      } else if (typeof call.id === 'string' && call.id) {
        const existing = [...this.calls.entries()].find(([, entry]) => entry.id === call.id);
        if (existing) index = existing[0];
        else index = this.calls.has(fallbackIndex) ? this.calls.size : fallbackIndex;
      } else {
        index = fallbackIndex;
      }
      const fn = call.function && typeof call.function === 'object'
        ? call.function as Record<string, unknown>
        : {};
      const current = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof call.id === 'string') current.id += call.id;
      if (typeof fn.name === 'string') current.name += fn.name;
      if (typeof fn.arguments === 'string') {
        current.arguments += fn.arguments;
      } else if (fn.arguments && typeof fn.arguments === 'object') {
        current.arguments += JSON.stringify(fn.arguments);
      }
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

/**
 * Groq (and some gateways) validate the model's emitted call against the
 * declared list mid-generation and 400 the whole turn: "Tool call validation
 * failed: attempted to call tool 'create_file' which was not in request.tools".
 * The request itself was fine — the model hallucinated a name — so the recovery
 * is to resend without native tools and let the text protocol's repair loop
 * teach the model the real names, not to blame the user's key.
 */
export function rejectsToolCall(payload: string): boolean {
  return /tool call validation failed|not in request\.tools|attempted to call tool|tool.*(not|never) (provided|declared|listed)/i.test(payload);
}

/**
 * Gemini's function-declaration schema is a strict OpenAPI subset: keys like
 * `additionalProperties`, `$schema` or `examples` are rejected with a generic
 * "Request contains an invalid argument", and an OBJECT with empty `properties`
 * is refused outright. Everything ShadRox's own schemas carry that Gemini does
 * not know is stripped here, types are upper-cased to the canonical enum, and
 * `required` is filtered to names that actually exist in `properties`.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum',
  'items', 'properties', 'required', 'minItems', 'maxItems',
  'minimum', 'maximum', 'anyOf', 'default'
]);

function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === 'type' && typeof entry === 'string') {
      out.type = entry.toUpperCase();
      continue;
    }
    if (key === 'properties' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const properties: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(entry as Record<string, unknown>)) {
        properties[name] = sanitizeGeminiSchema(sub);
      }
      out.properties = properties;
      continue;
    }
    out[key] = sanitizeGeminiSchema(entry);
  }
  if (Array.isArray(out.required) && out.properties && typeof out.properties === 'object') {
    const names = new Set(Object.keys(out.properties as Record<string, unknown>));
    const required = out.required.filter((name): name is string => typeof name === 'string' && names.has(name));
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}

/**
 * The parameters block for one Gemini function declaration, or `undefined`
 * when the tool takes no arguments — Gemini refuses an empty OBJECT schema, so
 * a no-argument tool is declared without `parameters` at all.
 */
export function geminiFunctionParameters(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  const cleaned = sanitizeGeminiSchema(schema) as Record<string, unknown>;
  const properties = cleaned.properties;
  const isEmptyObject = cleaned.type === 'OBJECT' &&
    (!properties || typeof properties !== 'object' || Object.keys(properties as Record<string, unknown>).length === 0);
  if (isEmptyObject) return undefined;
  return cleaned;
}

// Native-function-calling providers accept up to 128 declarations; 64 keeps the
// whole agent registry deliverable while still bounding a hostile request. The
// old 32 silently broke every provider once the registry grew past it.
const MAX_TOOL_DEFINITIONS = 64;

export function nativeToolDefinitions(value: unknown): NativeToolDefinition[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TOOL_DEFINITIONS) throw new Error('Invalid tool definitions.');
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
