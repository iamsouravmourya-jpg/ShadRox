import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseToolBlocks,
  serializeCallKey,
  serializeResults,
  stripToolBlocks,
  hasOpenToolFence
} from './toolProtocol';

const fence = (body: string) => '```shadrox:tools\n' + body + '\n```';

test('a well-formed array becomes calls with args', () => {
  const blocks = parseToolBlocks(fence('[{"name":"read_file","args":{"path":"src/a.ts"}}]'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].error, null);
  assert.deepEqual(blocks[0].calls, [{ name: 'read_file', args: { path: 'src/a.ts' } }]);
});

test('a single object is still one call', () => {
  const blocks = parseToolBlocks(fence('{"name":"list_directory","args":{}}'));
  assert.deepEqual(blocks[0].calls, [{ name: 'list_directory', args: {} }]);
});

test('a provider that returns bare tool-call JSON is recovered without showing it as prose', () => {
  const raw = '[{"name":"read_file","args":{"path":"README.md"}}]';
  assert.deepEqual(parseToolBlocks(raw), [{
    calls: [{ name: 'read_file', args: { path: 'README.md' } }],
    error: null
  }]);
  assert.equal(stripToolBlocks(raw), '');
});

test('ordinary JSON examples remain visible unless they match the strict tool-call shape', () => {
  const raw = '{"name":"example","description":"A tool schema"}';
  assert.equal(parseToolBlocks(raw).length, 0);
  assert.equal(stripToolBlocks(raw), raw);
});

test('broken JSON is fed back as an error instead of thrown away', () => {
  const blocks = parseToolBlocks(fence('[{"name": "read_file" '));
  assert.equal(blocks[0].calls.length, 0);
  assert.match(blocks[0].error as string, /not valid JSON/);
});

test('entries without a name are dropped and the rest survive', () => {
  const blocks = parseToolBlocks(fence('[{"name":"read_file","args":{"path":"a"}},{"args":{}}]'));
  assert.equal(blocks[0].calls.length, 1);
});

test('calls past the per-round cap survive parsing for the loop to budget', () => {
  const seven = Array.from({ length: 7 }, (_, index) => ({ name: 'read_file', args: { path: `${index}.ts` } }));
  const blocks = parseToolBlocks(fence(JSON.stringify(seven)));
  assert.equal(blocks[0].calls.length, 7);
  assert.equal(blocks[0].error, null);
});

test('a runaway block is parsed only up to a hard bound and says so', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ name: 'read_file', args: { path: `${index}.ts` } }));
  const blocks = parseToolBlocks(fence(JSON.stringify(many)));
  assert.equal(blocks[0].calls.length, 16);
  assert.match(blocks[0].error as string, /24 entries were unusable or past the parse limit/);
});

test('an unterminated fence is not treated as a block', () => {
  assert.equal(parseToolBlocks('```shadrox:tools\n[{"name":"read_file"}]').length, 0);
  assert.equal(hasOpenToolFence('```shadrox:tools\n[{"name":"read_file"}'), true);
  assert.equal(hasOpenToolFence(fence('[{"name":"read_file"}]')), false);
});

test('stripping removes whole and partial fences but keeps edit blocks', () => {
  const text = `Looking now.\n${fence('[{"name":"read_file","args":{"path":"a"}}]')}\nDone.\n`
    + '```path=src/a.ts\n<<<<<<< ORIGINAL\nx\n=======\ny\n>>>>>>> UPDATED\n```\n'
    + '```shadrox:tools\n[{"name":"read_';
  const stripped = stripToolBlocks(text);
  assert.match(stripped, /Looking now\./);
  assert.match(stripped, /Done\./);
  assert.match(stripped, /path=src\/a\.ts/);
  assert.doesNotMatch(stripped, /shadrox:tools/);
  assert.doesNotMatch(stripped, /read_file/);
});

test('results serialise as parseable JSON in a results fence', () => {
  const payload = serializeResults([
    { name: 'read_file', ok: true, content: 'hello' },
    { name: 'search_text', ok: false, content: '', error: 'needs a query' }
  ]);
  assert.match(payload, /^```shadrox:results\n/);
  const parsed = JSON.parse(payload.replace(/^```shadrox:results\n/, '').replace(/\n```$/, ''));
  assert.deepEqual(parsed, [
    { tool: 'read_file', ok: true, result: 'hello' },
    { tool: 'search_text', ok: false, error: 'needs a query' }
  ]);
});

test('a round of large results stays inside one context budget and says so', () => {
  const wide = 'x'.repeat(24_000);
  const payload = serializeResults([
    { name: 'read_file', ok: true, content: wide },
    { name: 'search_text', ok: true, content: wide },
    { name: 'git_state', ok: true, content: wide }
  ]);
  assert.ok(payload.length < 60_000, `the observation is bounded, was ${payload.length}`);
  const parsed = JSON.parse(payload.replace(/^```shadrox:results\n/, '').replace(/\n```$/, ''));
  assert.deepEqual(parsed.map((entry) => entry.tool), ['read_file', 'search_text', 'git_state']);
  for (const entry of parsed) {
    assert.match(entry.result, /of 24000 characters/, 'every call keeps a visible marker');
  }
});

test('a round of small results is handed over untouched', () => {
  const payload = serializeResults([{ name: 'read_file', ok: true, content: 'const a = 1;' }]);
  assert.ok(payload.includes('const a = 1;'));
  assert.doesNotMatch(payload, /characters/);
});

test('call keys ignore argument order', () => {
  const a = serializeCallKey({ name: 'read_file', args: { path: 'a.ts', start_line: 2 } });
  const b = serializeCallKey({ name: 'read_file', args: { start_line: 2, path: 'a.ts' } });
  assert.equal(a, b);
  assert.notEqual(a, serializeCallKey({ name: 'read_file', args: { path: 'a.ts', start_line: 3 } }));
});
