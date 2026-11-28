// Minimal OpenAI-compatible streaming client for the ShadRox bench.
// Uses BYOK from the environment so the bench spends the caller's own key:
//   SHADROX_BENCH_BASE_URL  e.g. https://api.groq.com/openai/v1
//   SHADROX_BENCH_KEY       the API key
//   SHADROX_BENCH_MODEL     e.g. llama-3.3-70b-versatile
//
// The bench runs the agent in "text fence" mode: the model is asked (via the
// system instruction's describeTools output) to emit ```shadrox:tools blocks,
// which runToolRounds parses. No native tool schema is sent, so the same
// stream works across providers.

export function createByokStream({ baseUrl, apiKey, model, usage }) {
  if (!baseUrl || !apiKey || !model) {
    throw new Error('bench: set SHADROX_BENCH_BASE_URL, SHADROX_BENCH_KEY and SHADROX_BENCH_MODEL');
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async function stream(messages) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } })
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      return { text: '', error: `bench provider ${res.status}: ${detail.slice(0, 400)}` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const readFrame = (frame) => {
      for (const line of frame.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.usage) {
          usage.inputTokens += json.usage.prompt_tokens ?? 0;
          usage.outputTokens += json.usage.completion_tokens ?? 0;
          const cached = json.usage.prompt_tokens_details?.cached_tokens
            ?? json.usage.prompt_cache_hit_tokens ?? 0;
          usage.cachedInputTokens += cached;
        }
        const choice = json.choices?.[0];
        const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
        if (typeof delta === 'string') text += delta;
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          readFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      }
      if (buffer.trim()) readFrame(buffer);
    } catch (error) {
      return { text, error: `bench stream error: ${error?.message ?? error}` };
    }
    return { text, error: null };
  };
}