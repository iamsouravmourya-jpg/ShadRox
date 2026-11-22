import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditRequirementCoverage,
  extractExplicitPathsFromText,
  extractRequirements,
  formatRequirementChecklistForPrompt
} from './requirements';

test('extractRequirements collapses a simple single-paragraph prompt into 1 item', () => {
  const items = extractRequirements('Update src/App.tsx to render the updated hero banner.');
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].explicitPaths, ['src/App.tsx']);
  assert.equal(formatRequirementChecklistForPrompt(items), '');
});

test('extractRequirements parses multi-section mega-prompts with explicit paths', () => {
  const mega = [
    '### Part 1: Security',
    '1. Fix DNS-rebinding SSRF in `api/ai/_endpoint.ts` cleanly.',
    '2. Sandbox blob URLs inside `electron/main.cjs`.',
    '### Part 2: Architecture',
    '- Extract modules from `src/App.tsx` into `src/components/WorkspaceShell.tsx`.',
    '- Bump version to 0.1.4 in `package.json` and `landing/index.html`.'
  ].join('\n');

  const items = extractRequirements(mega);
  assert.equal(items.length, 4);
  assert.deepEqual(items[0].explicitPaths, ['api/ai/_endpoint.ts']);
  assert.deepEqual(items[1].explicitPaths, ['electron/main.cjs']);
  assert.deepEqual(items[2].explicitPaths, ['src/App.tsx', 'src/components/WorkspaceShell.tsx']);
  assert.deepEqual(items[3].explicitPaths, ['package.json', 'landing/index.html']);

  const checklist = formatRequirementChecklistForPrompt(items);
  assert.match(checklist, /\[r1\].*api\/ai\/_endpoint\.ts/);
  assert.match(checklist, /\[r4\].*package\.json/);
});

test('extractExplicitPathsFromText ignores version numbers and URLs while normalizing ./ paths', () => {
  const paths = extractExplicitPathsFromText(
    'Upgrade v0.1.4 using https://example.com/a.ts and modify ./src/lib/agent.ts plus package.json'
  );
  assert.deepEqual(paths, ['src/lib/agent.ts', 'package.json']);
});

test('auditRequirementCoverage flags untouched explicit paths and marks covered items accurately', () => {
  const reqs = extractRequirements(
    [
      '1. Inspect `auditreport.md` and read existing architecture.',
      '2. Harden `api/ai/_endpoint.ts` against SSRF.',
      '3. Sandbox `electron/main.cjs` window creation.',
      '4. Update version badge across landing page copy.'
    ].join('\n')
  );

  const audited = auditRequirementCoverage(
    reqs,
    [
      {
        id: 'm1',
        title: 'Harden endpoint SSRF',
        instruction: 'Update api/ai/_endpoint.ts',
        status: 'passed',
        expectedFiles: ['api/ai/_endpoint.ts'],
        touchedFiles: ['api/ai/_endpoint.ts']
      },
      {
        id: 'm2',
        title: 'Update landing page version badge',
        instruction: 'Update version badge across landing page copy',
        status: 'unverified',
        expectedFiles: [],
        touchedFiles: ['landing/index.html']
      }
    ],
    ['api/ai/_endpoint.ts']
  );

  // Read-only audit item has no actionable file mutation requirement
  assert.equal(audited[0].id, 'r1');
  assert.equal(audited[1].status, 'covered', 'api/ai/_endpoint.ts was touched by a passed milestone');
  assert.equal(audited[2].status, 'pending', 'electron/main.cjs was never touched');
  assert.match(audited[2].evidence ?? '', /electron\/main\.cjs/);
  assert.equal(audited[3].status, 'unverified', 'keyword match to unverified unit preserves honest unverified status');
});
