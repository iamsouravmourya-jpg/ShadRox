import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_RULE_FILE_BYTES,
  RULES_SECTION_HEADER,
  compileRules,
  findRuleFiles,
  parseRuleFile,
  rulePrecedence,
  type RuleSource
} from './rules';

const source = (path: string, content: string): RuleSource => ({ path, content });

const CORE = '.shadrox/rules/core.md';
const ROOT_AGENT = 'AGENTS.md';
const NESTED_AGENT = 'src/lib/AGENTS.md';

const entry = (path: string, size = 120) => ({ path, size });

test('rule files come back in precedence order, general first', () => {
  const tree = [
    entry(NESTED_AGENT),
    entry(ROOT_AGENT),
    entry('src/AGENTS.md'),
    entry('.cursorrules'),
    entry('SHADROX.md'),
    entry('QODER.md'),
    entry(CORE),
    entry('.shadrox/rules/z.md'),
    entry('README.md'),
    entry('src/App.tsx')
  ];
  assert.deepEqual(findRuleFiles(tree), [
    CORE,
    '.shadrox/rules/z.md',
    'SHADROX.md',
    ROOT_AGENT,
    'QODER.md',
    '.cursorrules',
    'src/AGENTS.md',
    NESTED_AGENT
  ]);
});

test('nested AGENTS.md at any depth is discovered, vendored copies are not', () => {
  const tree = [
    entry('src/AGENTS.md'),
    entry('src/lib/deep/nested/AGENTS.md'),
    entry('node_modules/pkg/AGENTS.md'),
    entry('dist/AGENTS.md'),
    entry('.git/AGENTS.md'),
    entry('docs/agents.md')
  ];
  assert.deepEqual(findRuleFiles(tree), ['docs/agents.md', 'src/AGENTS.md', 'src/lib/deep/nested/AGENTS.md']);
});

test('a rule file bigger than 64 KB is skipped before any read', () => {
  const tree = [
    { path: ROOT_AGENT, size: MAX_RULE_FILE_BYTES + 1 },
    { path: CORE, size: MAX_RULE_FILE_BYTES },
    { path: 'src/AGENTS.md', size: 5_000_000 }
  ];
  assert.deepEqual(findRuleFiles(tree), [CORE]);
});

test('discovery is deterministic and tolerates duplicate or odd paths', () => {
  const tree = [
    entry('src\\AGENTS.md'),
    entry('./AGENTS.md'),
    entry('/etc/AGENTS.md'),
    entry('../escape/AGENTS.md'),
    entry(ROOT_AGENT),
    entry(CORE),
    entry('')
  ];
  const once = findRuleFiles(tree);
  const twice = findRuleFiles(tree);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, [CORE, 'AGENTS.md', 'src/AGENTS.md']);
});

test('a rule file splits into always sections and apply-to sections', () => {
  const parsed = parseRuleFile([
    'Use spaces, not tabs.',
    '',
    '## apply-to: **/*.ts',
    'Never use `any`.',
    '',
    '```apply-to: **/*.py',
    'Format with ruff.',
    '```',
    '',
    'apply-to: *.md',
    'Wrap prose at 100 columns.'
  ].join('\n'));

  assert.equal(parsed.always, 'Use spaces, not tabs.');
  assert.deepEqual(parsed.globs, [
    { pattern: '**/*.ts', body: 'Never use `any`.' },
    { pattern: '**/*.py', body: 'Format with ruff.' },
    { pattern: '*.md', body: 'Wrap prose at 100 columns.' }
  ]);
});

test('windows line endings and front matter are normalised away', () => {
  const parsed = parseRuleFile('---\r\ndescription: House style\r\n---\r\n\r\nIndent with two spaces.\r\n');
  assert.equal(parsed.description, 'House style');
  assert.equal(parsed.always, 'Indent with two spaces.');
  assert.deepEqual(parsed.globs, []);
});

test('an unparseable file degrades to one always section holding the whole body', () => {
  const messy = parseRuleFile('- a bullet\n`unterminated\n## just a heading\nplain prose');
  assert.equal(messy.globs.length, 0);
  assert.match(messy.always, /^- a bullet/);
  assert.match(messy.always, /plain prose$/);
  assert.equal(parseRuleFile('').always, '');
  assert.equal(parseRuleFile('').description, '');
});

test('a code block inside a rule keeps its fences so the markdown still renders', () => {
  const parsed = parseRuleFile('Name files like this:\n\n```ts\nconst a = 1;\n```\n');
  assert.match(parsed.always, /```ts\nconst a = 1;\n```/);
});

test('only apply-to sections matching an active path are compiled in', () => {
  const rule = source(ROOT_AGENT, [
    'Use spaces, not tabs.',
    '',
    '## apply-to: **/*.ts',
    'Never use `any`.',
    '',
    '## apply-to: **/*.tsx',
    'Keep components small.',
    '',
    '## apply-to: *.test.ts',
    'Every test asserts one behaviour.',
    '',
    '## apply-to: **/*.py',
    'Format with ruff.'
  ].join('\n'));

  const typescript = compileRules([rule], ['src/lib/rules.ts'], 10_000);
  assert.match(typescript.text, /Use spaces, not tabs\./);
  assert.match(typescript.text, /Never use `any`\./, '** crosses folders');
  assert.doesNotMatch(typescript.text, /Keep components small\./, '*.tsx is not *.ts');
  assert.doesNotMatch(typescript.text, /Every test asserts/, 'a single-segment glob cannot reach src/');
  assert.doesNotMatch(typescript.text, /Format with ruff\./);
  assert.deepEqual(typescript.used, [ROOT_AGENT]);
  assert.deepEqual(typescript.dropped, []);

  const component = compileRules([rule], ['src/App.tsx'], 10_000);
  assert.match(component.text, /Keep components small\./);
  assert.doesNotMatch(component.text, /Never use/);

  const testFile = compileRules([rule], ['rules.test.ts'], 10_000);
  assert.match(testFile.text, /Every test asserts one behaviour\./);

  const nothingActive = compileRules([rule], [], 10_000);
  assert.equal(nothingActive.text, `${RULES_SECTION_HEADER}\n\nRULES FROM ${ROOT_AGENT}:\nUse spaces, not tabs.`);
  assert.doesNotMatch(nothingActive.text, /Never use/);
});

test('a rule whose sections never match is neither used nor dropped', () => {
  const compiled = compileRules(
    [source('src/AGENTS.md', '## apply-to: **/*.py\nFormat with ruff.')],
    ['src/App.tsx'],
    10_000
  );
  assert.deepEqual(compiled, { text: '', used: [], dropped: [] });
});

test('compiled rules join in precedence order and are byte-identical across calls', () => {
  const sources = [
    source(NESTED_AGENT, 'Keep src/lib pure.'),
    source(ROOT_AGENT, 'Run typecheck before committing.'),
    source(CORE, 'Prefer small commits.')
  ];
  const first = compileRules(sources, ['src/lib/rules.ts'], 20_000);
  const second = compileRules(sources, ['src/lib/rules.ts'], 20_000);
  assert.equal(first.text, second.text);
  assert.deepEqual(first.used, [CORE, ROOT_AGENT, NESTED_AGENT]);

  const shuffled = compileRules([...sources].reverse(), ['src/lib/rules.ts'], 20_000);
  assert.equal(shuffled.text, first.text, 'caller order must not shift the cached bytes');

  const core = first.text.indexOf('RULES FROM .shadrox/rules/core.md:');
  const root = first.text.indexOf(`RULES FROM ${ROOT_AGENT}:`);
  const nested = first.text.indexOf(`RULES FROM ${NESTED_AGENT}:`);
  assert.ok(core >= 0 && core < root && root < nested, 'most specific rule is emitted last');
});

test('the budget cut lands on a rule-file boundary and reports what went', () => {
  const sources = [
    source(CORE, 'Prefer small commits.'),
    source(ROOT_AGENT, 'Run typecheck before committing.'),
    source(NESTED_AGENT, 'Keep src/lib pure and free of React imports.')
  ];
  const full = compileRules(sources, [], 100_000);
  assert.deepEqual(full.used, [CORE, ROOT_AGENT, NESTED_AGENT]);

  const boundary = full.text.indexOf(`RULES FROM ${ROOT_AGENT}:`);
  const tight = compileRules(sources, [], boundary);
  assert.equal(tight.text, full.text.slice(0, boundary - 2));
  assert.deepEqual(tight.used, [CORE]);
  assert.deepEqual(tight.dropped, [ROOT_AGENT, NESTED_AGENT]);

  const starved = compileRules(sources, [], RULES_SECTION_HEADER.length - 1);
  assert.equal(starved.text, '');
  assert.deepEqual(starved.used, []);
  assert.deepEqual(starved.dropped, [CORE, ROOT_AGENT, NESTED_AGENT]);
});

test('empty inputs compile to nothing instead of throwing', () => {
  assert.deepEqual(compileRules([], [], 0), { text: '', used: [], dropped: [] });
  assert.deepEqual(compileRules([], ['src/App.tsx'], 0), { text: '', used: [], dropped: [] });
  assert.deepEqual(compileRules([source(ROOT_AGENT, '')], [], 10_000), { text: '', used: [], dropped: [] });
  assert.deepEqual(findRuleFiles([]), []);
});

test('precedence buckets name the rule kinds the compiler sorts by', () => {
  assert.equal(rulePrecedence(CORE), 0);
  assert.equal(rulePrecedence('.cursorrules'), 1);
  assert.equal(rulePrecedence(NESTED_AGENT), 2);
  assert.equal(rulePrecedence('src/App.tsx'), 3);
  assert.equal(rulePrecedence('.shadrox/rules/deep/extra.md'), 3);
});
