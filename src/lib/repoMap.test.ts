import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGraph,
  buildSignatureMap,
  extractSignatures,
  indexSignatures,
  mapCandidates,
  rankFiles,
  repoMapBudgetFor,
  type MapInputFile
} from './repoMap';

const file = (name: string, content: string): MapInputFile => ({ name, content });

const APP = [
  "import { helper } from './helper';",
  'export function App() {',
  '  return helper();',
  '}',
  'export const theme = { dark: true };'
].join('\n');

const HELPER = 'export function helper(): string {\n  return "ok";\n}\nclass Unused {}\n';
const UNRELATED = 'export function standalone() { return 1; }\n';

test('signatures name the declarations a planner needs', () => {
  const sigs = extractSignatures('src/App.tsx', APP);
  const names = sigs.map((sig) => sig.name);
  assert.ok(names.includes('App'), 'exported function is found');
  assert.ok(names.includes('helper'), 'the imported binding becomes a signature too');
  assert.ok(sigs.some((sig) => sig.module === './helper'), 'the import keeps its specifier for edge resolution');
  const app = sigs.find((sig) => sig.name === 'App');
  assert.equal(app?.kind, 'function');
  assert.equal(app?.line, 2);
});

test('a signature line never grows past one prompt line', () => {
  const args = Array.from({ length: 15 }, (_, i) => `arg${i}: number`).join(', ');
  const long = file('src/long.ts', `export function veryLong(${args}) { return 1; }`);
  assert.ok(long.content.length > 100 && long.content.length < 400, 'long but not treated as generated');
  const sigs = extractSignatures(long.name, long.content);
  assert.ok(sigs.length > 0);
  for (const sig of sigs) assert.ok(sig.text.length <= 100, `too long: ${sig.text}`);
  assert.match(sigs[0].text, /\.\.\.$/);
});

test('generated one-liners are skipped instead of eaten whole', () => {
  const minified = file('src/blob.js', 'var a=1;' + 'x'.repeat(500_000));
  assert.deepEqual(extractSignatures(minified.name, minified.content), []);
});

test('edges follow real imports, so ranking has something to walk', () => {
  const files = [file('src/App.tsx', APP), file('src/helper.ts', HELPER), file('src/standalone.ts', UNRELATED)];
  const graph = buildGraph(files);
  const app = graph.get('src/App.tsx');
  assert.ok(app?.out.has('src/helper.ts'), 'a relative import creates an edge');
  assert.ok(!app?.out.has('src/standalone.ts'));
  assert.ok(graph.get('src/helper.ts')?.refs.has('helper'), 'the defining file records who reads its symbol');
});

test('personalization pulls the referenced file up over an unrelated hub', () => {
  const hub = file('src/util.ts', Array.from({ length: 20 }, (_, i) => `export function u${i}() {}`).join('\n'));
  const consumers = Array.from({ length: 12 }, (_, i) => file(`src/c${i}.ts`, "import { u0 } from './util';\nexport const v = u0();"));
  const files = [file('src/App.tsx', APP), file('src/helper.ts', HELPER), hub, ...consumers];
  const ranked = rankFiles(buildGraph(files), ['src/App.tsx'], '').map((entry) => entry.file);
  assert.ok(ranked.indexOf('src/helper.ts') < ranked.indexOf('src/util.ts'),
    `expected helper above the hub, got ${ranked.slice(0, 6).join(', ')}`);
});

test('an edge-less graph keeps a stable order instead of inventing one', () => {
  const ranked = rankFiles(buildGraph([file('src/b.ts', UNRELATED), file('src/a.ts', UNRELATED)]));
  assert.deepEqual(ranked.map((entry) => entry.file), ['src/a.ts', 'src/b.ts']);
});

test('ranking is deterministic for the same tree', () => {
  const files = [file('src/App.tsx', APP), file('src/helper.ts', HELPER), file('src/standalone.ts', UNRELATED)];
  const once = buildSignatureMap(files, { tokenBudget: 512, query: 'App' });
  const twice = buildSignatureMap([...files].reverse(), { tokenBudget: 512, query: 'App' });
  assert.equal(once, twice, 'prompt caching depends on byte-identical maps');
});

test('the map lists files with their signatures and stays inside its budget', () => {
  const files = [file('src/App.tsx', APP), file('src/helper.ts', HELPER), file('README.md', '# Project\n')];
  const full = buildSignatureMap(files, { tokenBudget: 2_000, query: 'App' });
  assert.match(full, /src\/App\.tsx/);
  assert.match(full, /export function App\(\) \{/);
  assert.match(full, /README\.md/);

  const tight = buildSignatureMap(files, { tokenBudget: 40, query: 'App' });
  assert.ok(tight.length <= 160, `map of ${tight.length} chars overran a 40 token budget`);
});

test('anchor files are pinned to the top and their bytes are not duplicated', () => {
  const files = [file('README.md', '# Project\n'), file('package.json', '{"name":"x"}'), file('src/App.tsx', APP)];
  const map = buildSignatureMap(files, { tokenBudget: 2_000, query: 'App' });
  assert.ok(map.indexOf('README.md') < map.indexOf('src/App.tsx'), 'readme comes first');
  assert.equal((map.match(/README\.md/g) ?? []).length, 1, 'listed once even though it is also ranked');
});

test('pinned paths are left out because they are already in the prompt', () => {
  const files = [file('src/App.tsx', APP), file('src/helper.ts', HELPER)];
  const map = buildSignatureMap(files, { tokenBudget: 2_000, pinned: ['src/App.tsx'], query: 'App' });
  assert.ok(!/^src\/App\.tsx/m.test(map), map);
  assert.match(map, /src\/helper\.ts/);
});

test('files cut by the budget are counted, not silently dropped', () => {
  const many = Array.from({ length: 40 }, (_, i) => file(`src/f${i}.ts`, `export function fn${i}() { return ${i}; }\n`.repeat(6)));
  const map = buildSignatureMap(many, { tokenBudget: 60 });
  assert.match(map, /not shown — ask for them by path/);
});

test('a file with many declarations shows a bounded set and counts the rest', () => {
  const big = file('src/big.ts', Array.from({ length: 30 }, (_, i) => `export function many${i}() {}`).join('\n'));
  const map = buildSignatureMap([big], { tokenBudget: 2_000 });
  assert.match(map, /more signature\(s\)/);
  assert.ok(map.split('\n').filter((line) => line.includes('many')).length <= 8);
});

test('the budget scales with the context window but stays bounded', () => {
  assert.equal(repoMapBudgetFor(8_000), 1_024);
  assert.equal(repoMapBudgetFor(200_000), 4_096);
  assert.ok(repoMapBudgetFor(128_000) > repoMapBudgetFor(16_000));
});

test('indexing signatures separately keeps them in step with the graph', () => {
  const files = [file('src/App.tsx', APP), file('src/helper.ts', HELPER)];
  const signatures = indexSignatures(files);
  assert.equal(signatures.size, 2);
  const graph = buildGraph(files, signatures);
  assert.ok(graph.get('src/App.tsx')?.out.has('src/helper.ts'));
});

test('no files and no budget produce no text instead of a header', () => {
  assert.equal(buildSignatureMap([], { tokenBudget: 500 }), '');
  assert.equal(buildSignatureMap([file('src/a.ts', UNRELATED)], { tokenBudget: 0 }), '');
});

test('candidates skip data files and oversized files, and stop at the byte budget', () => {
  const tree = [
    { path: 'README.md', size: 100 },
    { path: 'src/a.ts', size: 1_000 },
    { path: 'package.json', size: 50 },
    { path: 'src/huge.ts', size: 900_000 },
    { path: 'src/b.py', size: 2_000 },
    { path: 'src/views.vue', size: 10 },
    { path: '', size: 5 }
  ];
  assert.deepEqual(mapCandidates(tree), ['src/a.ts', 'src/b.py', 'src/views.vue'],
    'markdown and json declare nothing; an unknown extension still gets the generic scan');
  assert.deepEqual(mapCandidates(tree, { maxTotalBytes: 900 }), ['src/a.ts'],
    'the budget is checked before the read, so the file that would overrun it is never opened');
  assert.deepEqual(mapCandidates(tree, { maxFileBytes: 1_500 }), ['src/a.ts', 'src/views.vue']);
  assert.deepEqual(mapCandidates([]), []);
});

test('a precomputed signature index produces the same map', () => {
  const files = [file('src/App.tsx', APP), file('src/helper.ts', HELPER)];
  assert.equal(
    buildSignatureMap(files, { tokenBudget: 500, query: 'App' }, indexSignatures(files)),
    buildSignatureMap(files, { tokenBudget: 500, query: 'App' })
  );
});
