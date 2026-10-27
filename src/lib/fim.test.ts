import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIM_MAX_LINES,
  FIM_PREFIX_CHARS,
  buildFimMessages,
  isWorthCompleting,
  postprocessFimCompletion,
  suffixOverlapLength
} from './fim';
import {
  FIM_FAILURE_HINT_THRESHOLD,
  clearFimCache,
  fimCacheKey,
  fimIdentity,
  fingerprintSecret,
  getFimHealth,
  requestFimCompletion,
  subscribeFimHealth,
  type FimRequestContext
} from './fimClient';

const CONTEXT: FimRequestContext = { provider: 'groq', model: 'code-llama', apiKey: 'sk-secret-abcdef' };

/** Minimal fetch stub: records calls, resolves each one however the test asks. */
function stubFetch(respond: (call: number) => Promise<any>) {
  const bodies: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return respond(bodies.length);
  }) as typeof fetch;
  return {
    bodies,
    restore() {
      globalThis.fetch = original;
    }
  };
}

const okResponse = (text: string, tokens = 3) => ({
  ok: true,
  status: 200,
  json: async () => ({ text, tokens })
});
const errorResponse = (status = 401) => ({
  ok: false,
  status,
  json: async () => ({ error: 'invalid api key' })
});

test('completion keys are partitioned by credential, and never hold the raw key', () => {
  clearFimCache();
  const withKey = fimCacheKey(CONTEXT, 'const x = ', ';');
  const otherKey = fimCacheKey({ ...CONTEXT, apiKey: 'sk-OTHER-abcdef' }, 'const x = ', ';');
  const shared = fimCacheKey({ ...CONTEXT, apiKey: undefined }, 'const x = ', ';');
  const otherModel = fimCacheKey({ ...CONTEXT, model: 'other' }, 'const x = ', ';');

  assert.ok(!withKey.includes('sk-secret-abcdef'), 'the API key must never appear in the cache key');
  assert.ok(withKey.includes(fingerprintSecret('sk-secret-abcdef')));
  assert.notEqual(withKey, otherKey, 'switching keys cannot serve the previous key result');
  assert.notEqual(withKey, shared);
  assert.notEqual(withKey, otherModel);
  assert.equal(fingerprintSecret('sk-secret-abcdef'), fingerprintSecret('sk-secret-abcdef'), 'stable per key');
  assert.equal(fimIdentity(CONTEXT), 'groq|code-llama|' + fingerprintSecret('sk-secret-abcdef'));
});

test('two identical in-flight contexts share a single request', async () => {
  clearFimCache();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchStub = stubFetch(async () => {
    await gate;
    return okResponse('  = compute(a);');
  });

  try {
    const first = requestFimCompletion(CONTEXT, 'const x', ';');
    const second = requestFimCompletion(CONTEXT, 'const x', ';');
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(fetchStub.bodies.length, 1, 'identical contexts must be deduped while in flight');
    assert.equal(a.text, b.text);
  } finally {
    fetchStub.restore();
  }
});

test('a successful completion is served from cache on the next keystroke', async () => {
  clearFimCache();
  const fetchStub = stubFetch(async () => okResponse('  = 1;'));
  try {
    const a = await requestFimCompletion(CONTEXT, 'const x', ';');
    const b = await requestFimCompletion(CONTEXT, 'const x', ';');
    assert.equal(fetchStub.bodies.length, 1);
    assert.deepEqual(a, b);

    // Different context, so a different key: a request is made.
    await requestFimCompletion(CONTEXT, 'const y', ';');
    assert.equal(fetchStub.bodies.length, 2);
  } finally {
    fetchStub.restore();
  }
});

test('an auth failure is not cached, so Tab can work again after the key is fixed', async () => {
  clearFimCache();
  let failing = true;
  const fetchStub = stubFetch(async () => (failing ? errorResponse() : okResponse('  = fixed();')));
  try {
    const dropped = await requestFimCompletion(CONTEXT, 'const x', ';');
    assert.deepEqual(dropped, { text: '', tokens: 0 }, 'the editor never sees an exception');
    assert.equal(fetchStub.bodies.length, 1);

    // The old code cached that empty string forever. It must ask again.
    failing = false;
    const retried = await requestFimCompletion(CONTEXT, 'const x', ';');
    assert.equal(fetchStub.bodies.length, 2, 'a failure must not be cached');
    assert.equal(retried.text, '  = fixed();');
    assert.equal(getFimHealth().consecutiveFailures, 0, 'a success clears the failure streak');
  } finally {
    fetchStub.restore();
  }
});

test('repeated failures reach the hint threshold instead of staying silent', async () => {
  clearFimCache();
  const seen: number[] = [];
  const unsubscribe = subscribeFimHealth(() => seen.push(getFimHealth().consecutiveFailures));
  const fetchStub = stubFetch(async () => errorResponse(500));
  try {
    for (let index = 0; index < FIM_FAILURE_HINT_THRESHOLD; index += 1) {
      await requestFimCompletion(CONTEXT, `prefix ${index}`, 'suffix');
    }
    assert.ok(getFimHealth().consecutiveFailures >= FIM_FAILURE_HINT_THRESHOLD);
    assert.equal(getFimHealth().lastFailure, 'request-failed');
    assert.deepEqual(seen, [1, 2, 3], 'the editor is told as the streak grows');
  } finally {
    unsubscribe();
    fetchStub.restore();
  }
});

test('switching the key or model evicts cached completions', async () => {
  clearFimCache();
  const fetchStub = stubFetch(async () => okResponse('  = 1;'));
  try {
    await requestFimCompletion(CONTEXT, 'const x', ';');
    await requestFimCompletion({ ...CONTEXT, apiKey: 'sk-SECOND-key' }, 'const x', ';');
    assert.equal(fetchStub.bodies.length, 2, 'a new credential gets its own request');
    assert.equal(getFimHealth().consecutiveFailures, 0);

    // What App does when the identity changes: nothing survives the switch.
    clearFimCache();
    await requestFimCompletion(CONTEXT, 'const x', ';');
    assert.equal(fetchStub.bodies.length, 3);
  } finally {
    fetchStub.restore();
  }
});

test('an aborted request is not counted as a completion failure', async () => {
  clearFimCache();
  const fetchStub = stubFetch(async () => {
    throw new DOMException('aborted', 'AbortError');
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await requestFimCompletion(CONTEXT, 'const x', ';', controller.signal);
    assert.equal(getFimHealth().consecutiveFailures, 0);
    assert.equal(getFimHealth().lastFailure, null);
  } finally {
    fetchStub.restore();
  }
});

test('caps the context window sent to the completion model', () => {
  const { prompt, systemInstruction } = buildFimMessages('x'.repeat(FIM_PREFIX_CHARS * 2), 'y'.repeat(9_000), 'tsx');
  assert.ok(systemInstruction.length > 0);
  assert.ok(prompt.includes('<caret>'));
  assert.ok(prompt.length < FIM_PREFIX_CHARS + 3_000 + 400, 'prefix and suffix must both be capped');
});

test('drops the part of a completion that re-types the existing suffix', () => {
  assert.equal(suffixOverlapLength(' const app', 'const app = express()'), 9);
  assert.equal(postprocessFimCompletion('  const app', 'const app = express()'), '');
});

test('strips fences and cuts at stop markers', () => {
  assert.equal(postprocessFimCompletion('```ts\nreturn res.json(data);\n```', ''), 'return res.json(data);');
  assert.equal(postprocessFimCompletion('doThing()\n```', ''), 'doThing()');
  assert.equal(postprocessFimCompletion('value = 123<|end|>', ''), 'value = 123');
});

test('keeps a suggestion to a few lines', () => {
  const text = postprocessFimCompletion('one\ntwo\nthree\nfour\nfive', '');
  assert.equal(text.split('\n').length, FIM_MAX_LINES);
});

test('only completes when the caret sits on real code', () => {
  assert.equal(isWorthCompleting('const total = calcul'), true);
  assert.equal(isWorthCompleting('callApi('), true);
  assert.equal(isWorthCompleting('line one\n'), false);
  assert.equal(isWorthCompleting('   '), false);
});
