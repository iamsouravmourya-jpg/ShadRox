import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerDependencyQuestion,
  buildIntentGraph,
  createIntentIndex,
  decisionFreshness,
  extractIntentContext,
  hashesForTargets,
  refreshDecisionStatuses
} from './graph';
import type { IntentDecision, IntentFile } from './types';

const helperFile: IntentFile = {
  path: 'src/b.ts',
  content: 'export function helperOne(value: number): number {\n  return value + 1;\n}\n'
};
const callerFile: IntentFile = {
  path: 'src/a.ts',
  content: "import { helperOne } from './b';\n\nexport function run(): number {\n  return helperOne(1);\n}\n"
};

const decision = (baseHashes: Record<string, string>, over: Partial<IntentDecision> = {}): IntentDecision => ({
  id: 'dec-1',
  workspaceRoot: '/work',
  createdAt: 1,
  updatedAt: 1,
  kind: 'rationale',
  title: 'Why the caller is thin',
  body: 'Keep run() a one-line adapter so the helper stays testable.',
  targets: Object.keys(baseHashes).map((path) => ({ path })),
  baseHashes,
  status: 'fresh',
  source: 'user',
  capsuleRef: null,
  ...over
});

async function build(files: readonly IntentFile[], decisions: readonly IntentDecision[] = [], index = createIntentIndex()) {
  return buildIntentGraph('/work', files, decisions, { index });
}

test('an untouched file keeps its cached hash and signatures across builds', async () => {
  const index = createIntentIndex();
  const first = await build([callerFile, helperFile], [], index);
  assert.equal(index.reindexed, 2, 'a cold build derives every file');
  assert.equal(index.reused, 0);

  const second = await build([callerFile, helperFile], [], index);
  assert.equal(index.reused, 2);
  assert.equal(index.reindexed, 0, 'nothing changed, so nothing was re-hashed or re-scanned');
  assert.deepEqual(second.fileHashes, first.fileHashes);
});

test('editing one file re-derives that file alone', async () => {
  const index = createIntentIndex();
  await build([callerFile, helperFile], [], index);
  const edited: IntentFile = { path: helperFile.path, content: `${helperFile.content}\nexport const extra = 2;\n` };

  await build([callerFile, edited], [], index);
  assert.equal(index.reindexed, 1);
  assert.equal(index.reused, 1);
});

test('the incremental build yields exactly what a cold build yields', async () => {
  const files = [callerFile, helperFile];
  const cold = await build(files);
  const index = createIntentIndex();
  await build([callerFile], [], index);
  const warm = await build(files, [], index);

  const strip = (graph: Awaited<ReturnType<typeof build>>) => ({ ...graph, builtAt: 0 });
  assert.deepEqual(strip(warm), strip(cold));
});

test('a file that leaves the index stops carrying a hash or an edge', async () => {
  const index = createIntentIndex();
  await build([callerFile, helperFile], [], index);
  const after = await build([callerFile], [], index);
  assert.equal(Object.keys(after.fileHashes).includes('src/b.ts'), false);
  assert.equal(after.fileEdges.some((edge) => edge.to === 'src/b.ts'), false);
});

test('a decision about a file that is not indexed is unknown, not stale', async () => {
  const hashes = (await build([callerFile])).fileHashes;
  const pinned = { 'src/never-opened.ts': 'anything' };

  assert.equal(decisionFreshness(pinned, hashes), 'unknown');
  // The old rule read this as stale, so every decision about a closed file
  // asked for review it never needed.
  assert.equal(decisionFreshness(pinned, hashes) === 'stale', false);
});

test('a governing file whose hash moved is stale, and one that matches is fresh', async () => {
  const graph = await build([callerFile, helperFile]);
  const live = graph.fileHashes['src/b.ts'];

  assert.equal(decisionFreshness({ 'src/b.ts': live }, graph.fileHashes), 'fresh');
  assert.equal(decisionFreshness({ 'src/b.ts': 'deadbeef' }, graph.fileHashes), 'stale');
});

test('a changed file outranks an unindexed one', async () => {
  const graph = await build([callerFile]);
  assert.equal(decisionFreshness({ 'src/a.ts': 'wrong', 'src/gone.ts': 'x' }, graph.fileHashes), 'stale');
});

test('a decision with no governing hashes has no evidence either way', async () => {
  const graph = await build([callerFile]);
  assert.equal(decisionFreshness({}, graph.fileHashes), 'unknown');
});

test('statuses are recomputed against the live index when the graph is built', async () => {
  const graph = await build([callerFile, helperFile]);
  const live = graph.fileHashes['src/a.ts'];
  const rebuilt = await build([callerFile, helperFile], [
    decision({ 'src/a.ts': live }),
    decision({ 'src/a.ts': 'old-hash' }),
    decision({ 'src/other.ts': 'whatever' })
  ]);
  assert.deepEqual(rebuilt.decisions.map((item) => item.status), ['fresh', 'stale', 'unknown']);
});

test('a decision pins its own targets, never the whole index', () => {
  const hashes = { 'src/a.ts': 'aaa', 'src/b.ts': 'bbb', 'src/c.ts': 'ccc' };
  assert.deepEqual(hashesForTargets(hashes, [{ path: './src/b.ts' }]), { 'src/b.ts': 'bbb' });
  assert.deepEqual(hashesForTargets(hashes, [{ path: 'src/missing.ts' }]), {});
});

test('refreshDecisionStatuses returns new objects and leaves the input alone', () => {
  const stored = decision({ 'src/a.ts': 'aaa' }, { status: 'unknown' });
  const [next] = refreshDecisionStatuses([stored], { 'src/a.ts': 'aaa' });
  assert.equal(next.status, 'fresh');
  assert.equal(stored.status, 'unknown', 'the stored decision is never mutated in place');
});

test('the dependency answer lists only edges the graph really found', async () => {
  const graph = await build([callerFile, helperFile]);
  const answer = answerDependencyQuestion(graph, 'what does src/a.ts depend on?');

  assert.equal(answer.resolved, true);
  assert.equal(answer.subject, 'src/a.ts');
  assert.equal(answer.confidence, 0.9);
  assert.ok(answer.dependsOn.some((edge) => edge.path === 'src/b.ts' && edge.weight >= 5 && edge.indexed));
  assert.ok(answer.symbols.includes('run'));
  assert.ok(answer.reasons.some((reason) => reason.includes('src/a.ts')));
});

test('a symbol named in the question resolves through the file that declares it', async () => {
  const graph = await build([callerFile, helperFile]);
  const answer = answerDependencyQuestion(graph, 'who uses helperOne?');
  assert.equal(answer.resolved, true);
  assert.equal(answer.subject, 'src/b.ts');
  assert.equal(answer.confidence, 0.8);
  assert.ok(answer.dependedBy.some((edge) => edge.path === 'src/a.ts'));
});

test('an empty dependent list says not seen, never none exist', async () => {
  const graph = await build([callerFile, helperFile]);
  const answer = answerDependencyQuestion(graph, 'who imports src/a.ts?');
  assert.equal(answer.subject, 'src/a.ts');
  assert.equal(answer.dependedBy.length, 0);
  assert.ok(answer.confidence <= 0.45, `confidence was ${answer.confidence}`);
  assert.ok(answer.reasons.some((reason) => /not seen/.test(reason)));
});

test('a question that matches nothing gets no answer rather than a guess', async () => {
  const graph = await build([callerFile, helperFile]);
  const answer = answerDependencyQuestion(graph, 'what depends on the billing module?');
  assert.equal(answer.resolved, false);
  assert.equal(answer.confidence, 0);
  assert.equal(answer.subject, null);
  assert.equal(answer.dependsOn.length, 0);
});

test('unverified decisions are marked in the prompt block, and never counted as stale', async () => {
  const graph = await build([callerFile], [
    decision({ 'src/gone.ts': 'hash' }, { id: 'dec-u', title: 'Unindexed rule', body: 'Nothing read this file yet.' }),
    decision({ 'src/a.ts': 'wrong' }, { id: 'dec-s', title: 'Stale rule', body: 'This governing file changed.' })
  ]);
  const context = extractIntentContext(graph, { seeds: ['src/a.ts'], query: 'Stale rule Unindexed rule', tokenBudget: 900 });

  assert.match(context.text, /\[STALE — NEEDS REVIEW\]/);
  assert.match(context.text, /\[NOT INDEXED — UNVERIFIED\]/);
  assert.equal(context.staleCount, 1, 'a decision nobody could check is not counted as a stale one');
});

test('an empty token budget extracts nothing instead of trusting the graph', async () => {
  const indexed = await build([callerFile]);
  const graph = await build([callerFile], [decision({ 'src/a.ts': indexed.fileHashes['src/a.ts'] })]);
  const context = extractIntentContext(graph, { seeds: ['src/a.ts'], query: 'anything', tokenBudget: 0 });
  assert.equal(context.text, '');
  assert.equal(context.selected.length, 0);
});
