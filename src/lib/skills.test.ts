import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SKILL_FILE_BYTES,
  describeSkills,
  findSkillFiles,
  matchSkill,
  parseSkill,
  renderSkill,
  skillInvocation,
  type Skill
} from './skills';

const RELEASE = [
  '---',
  'name: release-checklist',
  'description: Walks the release notes before a version bump.',
  'when-to-use: cutting a release or bumping the version',
  'applies-to: package.json, **/*.md',
  '---',
  '',
  'Review the diff since the last tag, then update {filename} with these args: {args}',
  'The file to check is:',
  '{file}'
].join('\n');

const AUDIT = ['---', 'description: Finds unused dependencies.', '---', '', 'Audit every dependency for unused imports.'].join('\n');
const SHIP = ['---', 'description: Ships the build.', '---', '', 'Run the ship steps for {args}.'].join('\n');

function skill(path: string, content: string): Skill | null {
  return parseSkill(path, content);
}

const loaded = (): Skill[] =>
  [skill('.shadrox/skills/audit.md', AUDIT), skill('.shadrox/skills/release-checklist.md', RELEASE), skill('.shadrox/skills/ship.md', SHIP)]
    .filter((entry): entry is Skill => entry !== null);

const entry = (path: string, size = 200) => ({ path, size });

test('skill files are discovered only under .shadrox/skills, sorted by path', () => {
  const tree = [
    entry('.shadrox/skills/zeta.md'),
    entry('.shadrox/skills/alpha.md'),
    entry('.shadrox/skills/nested/deep.md'),
    entry('.shadrox/skills/notes.txt'),
    entry('skills/other.md'),
    entry('.shadrox/rules/core.md'),
    entry('node_modules/pkg/skill.md')
  ];
  assert.deepEqual(findSkillFiles(tree), ['.shadrox/skills/alpha.md', '.shadrox/skills/zeta.md']);
  assert.deepEqual(findSkillFiles([]), []);
});

test('an oversized skill file is skipped before it is read', () => {
  const tree = [
    { path: '.shadrox/skills/big.md', size: MAX_SKILL_FILE_BYTES + 1 },
    { path: '.shadrox/skills/small.md', size: 1024 }
  ];
  assert.deepEqual(findSkillFiles(tree), ['.shadrox/skills/small.md']);
});

test('front matter becomes the skill record', () => {
  const parsed = skill('.shadrox/skills/release-checklist.md', RELEASE);
  assert.ok(parsed);
  assert.equal(parsed.name, 'release-checklist');
  assert.equal(parsed.description, 'Walks the release notes before a version bump.');
  assert.equal(parsed.whenToUse, 'cutting a release or bumping the version');
  assert.deepEqual(parsed.appliesTo, ['package.json', '**/*.md']);
  assert.match(parsed.body, /^Review the diff/);
  assert.equal(parsed.path, '.shadrox/skills/release-checklist.md');
});

test('malformed front matter still yields a skill with a defaulted name', () => {
  const broken = ['---', 'name: ', 'this line is not a key', '  : ', 'when-to-use', '---', '', 'Do the thing.'].join('\n');
  const parsed = skill('.shadrox/skills/deploy-app.md', broken);
  assert.ok(parsed, 'a bad field never discards the skill');
  assert.equal(parsed.name, 'deploy-app', 'name falls back to the filename');
  assert.equal(parsed.description, '');
  assert.deepEqual(parsed.appliesTo, []);
  assert.equal(parsed.body, 'Do the thing.');

  const unterminated = ['---', 'name: ghost', '', 'Body without a closing fence.'].join('\n');
  const ghost = skill('.shadrox/skills/ghost.md', unterminated);
  assert.ok(ghost);
  assert.equal(ghost.name, 'ghost', 'the block is only front matter when it closes');
  assert.match(ghost.body, /^---/);
});

test('a file with no body is not a skill, and neither is a file in the wrong place', () => {
  assert.equal(skill('.shadrox/skills/empty.md', '---\nname: empty\n---\n\n   \n'), null);
  assert.equal(skill('.shadrox/skills/blank.md', ''), null);
  assert.equal(skill('skills/outside.md', RELEASE), null);
  assert.equal(skill('../escape/skills/x.md', RELEASE), null);
});

test('windows line endings and unknown keys are handled leniently', () => {
  const crlf = ['---', 'name: tidy', 'colour: blue', 'applies-to: "src/*.ts, src/**" ', '---', '', 'Body line.', '', 'Second line.'].join('\r\n');
  const parsed = skill('.shadrox/skills/tidy.md', crlf);
  assert.ok(parsed);
  assert.equal(parsed.name, 'tidy');
  assert.deepEqual(parsed.appliesTo, ['src/*.ts', 'src/**']);
  assert.equal(parsed.body, 'Body line.\n\nSecond line.');
});

test('an explicit slash invocation beats a bare mention of another skill', () => {
  const skills = loaded();
  assert.equal(matchSkill('/ship audit the deps', skills)?.name, 'ship', 'the slash name wins over the mentioned audit skill');
  const shipIt = skill('.shadrox/skills/ship-it.md', SHIP)!;
  const invoked = skillInvocation('/ship-it bump to 0.0.4', [...skills, shipIt]);
  assert.equal(invoked?.skill.name, 'ship-it');
  assert.equal(invoked?.args, 'bump to 0.0.4');
  assert.equal(skillInvocation('run ship-it now', [...skills, shipIt])?.args, 'run ship-it now');
});

test('a name mention is case-insensitive and survives spaces and underscores', () => {
  const skills = loaded();
  assert.equal(matchSkill('Use the Release Checklist skill now', skills)?.name, 'release-checklist');
  assert.equal(matchSkill('can you run release_checklist please', skills)?.name, 'release-checklist');
  assert.equal(matchSkill('walk me through the release-checklist', skills)?.name, 'release-checklist');
});

test('when-to-use keywords are the last resort and need two distinct hits', () => {
  const prAudit = skill('.shadrox/skills/pr-audit.md', ['---', 'when-to-use: audit every dependency before shipping a release', '---', '', 'List the unused packages.'].join('\n'))!;
  const skills = [prAudit];
  assert.equal(matchSkill('please audit every dependency in this project', skills)?.name, 'pr-audit');
  assert.equal(matchSkill('please audit the ledger', skills), null, 'one shared word is not a match');
  assert.equal(matchSkill('', skills), null);
  assert.equal(matchSkill('anything at all', []), null);
});

test('matching ignores the order the caller passed the skills in', () => {
  const skills = loaded();
  const forward = matchSkill('/release-checklist bump', skills)?.name;
  const backward = matchSkill('/release-checklist bump', [...skills].reverse())?.name;
  assert.equal(forward, 'release-checklist');
  assert.equal(backward, forward);
  assert.deepEqual(describeSkills(skills), describeSkills([...skills].reverse()));
});

test('placeholders substitute, including the no-active-file case', () => {
  const parsed = skill('.shadrox/skills/release-checklist.md', RELEASE)!;
  const active = { path: 'src/App.tsx', content: 'export default function App() { return null; }' };
  const rendered = renderSkill(parsed, 'bump to 0.0.4', active);
  assert.match(rendered, /update App\.tsx with these args: bump to 0\.0\.4/);
  assert.match(rendered, /src\/App\.tsx\nexport default function App/, '{file} is the path then the content');
  assert.doesNotMatch(rendered, /\{args\}|\{file\}|\{filename\}/);

  const noFile = renderSkill(parsed, '', undefined);
  assert.match(noFile, /update \(no file is open in the editor\) with these args: /);
  assert.match(noFile, /\(no file is open in the editor\)/);
});

test('unknown placeholders and repeated ones are left alone', () => {
  const parsed = skill('.shadrox/skills/odd.md', ['---', '---', '', 'Args twice: {args} and {args}.', 'Keep {model} and { } and {} and {FILE}.'].join('\n'))!;
  assert.equal(parsed.name, 'odd');
  const rendered = renderSkill(parsed, 'now', { path: 'src/notes.md', content: 'body' });
  assert.equal(rendered, 'Args twice: now and now.\nKeep {model} and { } and {} and {FILE}.');
  assert.equal(renderSkill(parsed, '', undefined), 'Args twice:  and .\nKeep {model} and { } and {} and {FILE}.');
});

test('the system instruction learns every skill in one stable line each', () => {
  const lines = describeSkills(loaded());
  assert.deepEqual(lines, [
    '- /audit: Finds unused dependencies.',
    '- /release-checklist: Walks the release notes before a version bump. Use when: cutting a release or bumping the version. Applies to: package.json, **/*.md.',
    '- /ship: Ships the build.'
  ]);
  assert.deepEqual(describeSkills([]), []);
});
