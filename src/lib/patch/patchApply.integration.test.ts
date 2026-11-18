/**
 * End-to-end integration proof for the multi-file edit path, over REAL files
 * in a real temp directory (fs.mkdtempSync in os.tmpdir()). No mocks of any
 * ShadRox module: every reply goes through the real extractUnifiedPatchScan /
 * extractUnifiedPatches -> resolvePatchContent -> applySearchReplaceBlocks
 * pipeline, and the landing policy mirrors the apply rail's contract
 * (atomicApply): a typed refusal or an anchor failure writes ZERO bytes for
 * that file; a rewrite of an existing file passes assessRewriteRisk first.
 * Files land per-file, like the review rail's per-file accept, so one refused
 * file never hides whether its siblings applied.
 *
 * Defect classes pinned here (audit-confirmed):
 *  1. Nested code fences inside a Markdown rewrite used to close the edit
 *     block at the first inner ``` — truncating the rewrite, inventing bogus
 *     extra patches, and (for NEW files, where assessRewriteRisk is null)
 *     writing partial content to disk.
 *  2. One unprefixed blank line inside a Cline hunk used to kill the ENTIRE
 *     multi-file patch with a single PARSE_ERROR refusal.
 *  3. Multi-line replacements inserted LF lines into CRLF files (mixed EOLs).
 *  4. Context-only hunks were silently dropped — no patch, no refusal.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assessRewriteRisk,
  extractUnifiedPatchScan,
  resolvePatchContent,
  type UnifiedPatch
} from '../patchEngine';
import type { KnownFile } from '../markdown';

/* ------------------------------------------------------------------ *
 * Real-temp-dir harness.
 * ------------------------------------------------------------------ */

function withTempProject(files: Record<string, string>, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-patch-apply-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function listProjectFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return found.sort();
}

interface ApplyOutcome {
  written: string[];
  refusals: Array<{ path: string; code: string; reason: string }>;
  failures: Array<{ path: string; reason: string }>;
}

/** Drives the REAL pipeline over the real on-disk project state. */
function applyReplyToProject(reply: string, root: string): ApplyOutcome {
  const files: KnownFile[] = listProjectFiles(root).map((rel) => ({
    name: rel,
    content: fs.readFileSync(path.join(root, rel), 'utf8')
  }));
  const scan = extractUnifiedPatchScan(reply, files);
  const outcome: ApplyOutcome = { written: [], refusals: [], failures: [] };

  for (const patch of scan.patches as UnifiedPatch[]) {
    const full = path.join(root, patch.path);
    const exists = fs.existsSync(full);
    const current = exists ? fs.readFileSync(full, 'utf8') : '';

    if (patch.kind === 'rewrite') {
      if (exists) {
        const risk = assessRewriteRisk(patch.path, patch.content, current);
        if (risk) {
          outcome.refusals.push({ path: patch.path, code: 'DESTRUCTIVE_REWRITE', reason: risk });
          continue;
        }
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, patch.content, 'utf8');
      outcome.written.push(patch.path);
      continue;
    }

    if (!exists) {
      // A refusal patch (e.g. TRUNCATED_BLOCK for a never-created file) still
      // resolves to its typed refusal against empty content; only a genuine
      // edit attempt on a missing file is a plain failure.
      const resolvedMissing = resolvePatchContent(patch, '');
      if (resolvedMissing.refusal) {
        outcome.refusals.push({ path: patch.path, code: resolvedMissing.refusal.code, reason: resolvedMissing.refusal.reason });
      } else {
        outcome.failures.push({ path: patch.path, reason: 'file is not in the workspace' });
      }
      continue;
    }
    const resolved = resolvePatchContent(patch, current);
    if (resolved.refusal) {
      outcome.refusals.push({ path: patch.path, code: resolved.refusal.code, reason: resolved.refusal.reason });
      continue;
    }
    if (resolved.failures.length > 0) {
      outcome.failures.push({ path: patch.path, reason: `block ${resolved.failures[0].blockIndex}: ${resolved.failures[0].reason}` });
      continue;
    }
    fs.writeFileSync(full, resolved.content, 'utf8');
    outcome.written.push(patch.path);
  }
  return outcome;
}

const fence = (filePath: string, body: string, lang = 'ts'): string =>
  '```' + lang + ' path=' + filePath + '\n' + body + '\n```';

const srBlock = (original: string, updated: string): string =>
  ['<<<<<<< ORIGINAL', original, '=======', updated, '>>>>>>> UPDATED'].join('\n');

const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * (a) Markdown rewrite containing inner code fences.
 * ------------------------------------------------------------------ */

const GUIDE_MARKDOWN = [
  '# Guide',
  '',
  'Intro text.',
  '',
  '```ts',
  'export const answer = 42;',
  '```',
  '',
  '## Plain sample',
  '',
  '```',
  'plain text sample',
  '```',
  '',
  'Outro text.'
].join('\n');

test('a Markdown rewrite containing ```ts and bare ``` fences lands COMPLETE, with no bogus extra patches', () => {
  const reply = ['Here is the rewritten guide:', '', fence('GUIDE.md', GUIDE_MARKDOWN, 'markdown')].join('\n');
  withTempProject({ 'GUIDE.md': '# Guide\n\nOld intro.\n' }, (root) => {
    const scan = extractUnifiedPatchScan(reply, [{ name: 'GUIDE.md', content: read(root, 'GUIDE.md') }]);
    assert.equal(scan.patches.length, 1, 'the inner fences must not split the rewrite into extra blocks');
    assert.equal(scan.rejected.length, 0);
    assert.equal(scan.patches[0].kind, 'rewrite');

    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.refusals, []);
    assert.deepEqual(outcome.failures, []);
    assert.deepEqual(outcome.written, ['GUIDE.md']);
    assert.equal(read(root, 'GUIDE.md'), GUIDE_MARKDOWN, 'every inner fence and the tail survive byte-for-byte');
    assert.deepEqual(listProjectFiles(root), ['GUIDE.md'], 'no bogus file created from a fence tail');
  });
});

test('a four-backtick outer fence carries inner ``` samples unambiguously', () => {
  const reply = ['````markdown path=GUIDE.md', GUIDE_MARKDOWN, '````'].join('\n');
  withTempProject({ 'GUIDE.md': '# Guide\n' }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.written, ['GUIDE.md']);
    assert.equal(read(root, 'GUIDE.md'), GUIDE_MARKDOWN);
  });
});

/* ------------------------------------------------------------------ *
 * (b) Unterminated whole-file rewrite for a NEW file: refusal, no write.
 * ------------------------------------------------------------------ */

test('an unterminated whole-file rewrite fence for a NEW file is a typed refusal and writes nothing', () => {
  const reply = [
    'Creating the guide:',
    '',
    '```markdown path=NEW.md',
    '# New guide',
    '',
    '```ts',
    'export const x = 1;',
    '```',
    '',
    'More content that never finished...'
  ].join('\n');
  withTempProject({ 'existing.txt': 'keep me\n' }, (root) => {
    const scan = extractUnifiedPatchScan(reply, [{ name: 'existing.txt', content: 'keep me\n' }]);
    assert.equal(scan.rejected.length, 1);
    assert.equal(scan.rejected[0].path, 'NEW.md');
    assert.equal(scan.rejected[0].code, 'TRUNCATED_BLOCK');

    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.written, []);
    assert.equal(outcome.refusals.length, 1);
    assert.equal(outcome.refusals[0].code, 'TRUNCATED_BLOCK');
    assert.equal(fs.existsSync(path.join(root, 'NEW.md')), false, 'a partial new file must never reach disk');
    assert.equal(read(root, 'existing.txt'), 'keep me\n');
  });
});

test('a rewrite that dies after a nested BARE fence pair is refused, not partially written', () => {
  // The inner bare pair balances, but the outer close never arrived: an even
  // number of closing candidates proves the truncation.
  const reply = [
    '```markdown path=NEW2.md',
    '# Title',
    '```',
    'sample',
    '```',
    'trailing prose that never finished'
  ].join('\n');
  withTempProject({}, (root) => {
    const scan = extractUnifiedPatchScan(reply, []);
    assert.equal(scan.rejected.length, 1);
    assert.equal(scan.rejected[0].code, 'TRUNCATED_BLOCK');
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.written, []);
    assert.equal(fs.existsSync(path.join(root, 'NEW2.md')), false);
  });
});

/* ------------------------------------------------------------------ *
 * (c) Cline hunk with an unprefixed blank context line.
 * ------------------------------------------------------------------ */

test('a multi-file Cline patch with an unprefixed blank context line parses and applies', () => {
  const aTs = 'function f() {\n  const a = 1;\n\n  return a;\n}\n';
  const bTs = 'export const b = 2;\n';
  const reply = fence('apply-patch', [
    '*** Begin Patch',
    '*** Update File: a.ts',
    '@@',
    ' function f() {',
    '-  const a = 1;',
    '+  const a = 10;',
    '',
    '   return a;',
    ' }',
    '*** Update File: b.ts',
    '@@',
    '-export const b = 2;',
    '+export const b = 3;',
    '*** End Patch'
  ].join('\n'), 'diff');

  withTempProject({ 'a.ts': aTs, 'b.ts': bTs }, (root) => {
    const scan = extractUnifiedPatchScan(reply, [
      { name: 'a.ts', content: aTs },
      { name: 'b.ts', content: bTs }
    ]);
    assert.equal(scan.rejected.length, 0, 'one blank line must not refuse the whole patch');
    assert.equal(scan.patches.length, 2);

    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.refusals, []);
    assert.deepEqual(outcome.failures, []);
    assert.deepEqual(outcome.written, ['a.ts', 'b.ts']);
    assert.equal(read(root, 'a.ts'), 'function f() {\n  const a = 10;\n\n  return a;\n}\n');
    assert.equal(read(root, 'b.ts'), 'export const b = 3;\n');
  });
});

test('blank lines between Cline sections and around @@ are formatting, not parse errors', () => {
  const reply = fence('apply-patch', [
    '*** Begin Patch',
    '*** Update File: a.ts',
    '',
    '@@',
    '',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 20;',
    '',
    '*** Update File: b.ts',
    '@@',
    '-export const b = 2;',
    '+export const b = 3;',
    '*** End Patch'
  ].join('\n'), 'diff');
  withTempProject({ 'a.ts': 'const a = 1;\nconst b = 2;\n', 'b.ts': 'export const b = 2;\n' }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.refusals, []);
    assert.deepEqual(outcome.written, ['a.ts', 'b.ts']);
    assert.equal(read(root, 'a.ts'), 'const a = 1;\nconst b = 20;\n', 'no phantom blank line inserted');
    assert.equal(read(root, 'b.ts'), 'export const b = 3;\n');
  });
});

/* ------------------------------------------------------------------ *
 * (d) CRLF targets keep CRLF throughout; LF targets stay LF.
 * ------------------------------------------------------------------ */

const assertPureEol = (content: string, eol: '\r\n' | '\n') => {
  if (eol === '\r\n') {
    assert.ok(!/(?<!\r)\n/.test(content), 'no bare LF in a CRLF file');
    assert.ok(!/\r(?!\n)/.test(content), 'no lone CR in a CRLF file');
  } else {
    assert.ok(!content.includes('\r'), 'no CR introduced into an LF file');
  }
};

test('a multi-line SEARCH/REPLACE into a CRLF file keeps CRLF throughout (no mixed EOL)', () => {
  const crlf = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';
  const reply = fence('win.ts', srBlock('const a = 1;\nconst b = 2;', 'const A = 1;\nconst B = 2;\nconst extra = 9;'));
  withTempProject({ 'win.ts': crlf }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.failures, []);
    assert.deepEqual(outcome.written, ['win.ts']);
    const result = read(root, 'win.ts');
    assert.equal(result, 'const A = 1;\r\nconst B = 2;\r\nconst extra = 9;\r\nconst c = 3;\r\n');
    assertPureEol(result, '\r\n');
  });
});

test('a whitespace-stripped match ending mid-CRLF splices without breaking the pair', () => {
  const crlf = 'const a = 1;\r\nconst b = 2;\r\n';
  const reply = fence('win.ts', srBlock('const  a = 1;', 'const A = 1;\nconst extra = 0;'));
  withTempProject({ 'win.ts': crlf }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.failures, []);
    const result = read(root, 'win.ts');
    assert.equal(result, 'const A = 1;\r\nconst extra = 0;\r\nconst b = 2;\r\n');
    assertPureEol(result, '\r\n');
  });
});

test('a multi-line Cline hunk into a CRLF file keeps CRLF throughout', () => {
  const crlf = 'alpha\r\nbeta\r\ngamma\r\n';
  const reply = fence('apply-patch', [
    '*** Begin Patch',
    '*** Update File: win.txt',
    '@@',
    ' alpha',
    '-beta',
    '+BETA',
    '+inserted',
    ' gamma',
    '*** End Patch'
  ].join('\n'), 'diff');
  withTempProject({ 'win.txt': crlf }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.refusals, []);
    assert.deepEqual(outcome.failures, []);
    const result = read(root, 'win.txt');
    assert.equal(result, 'alpha\r\nBETA\r\ninserted\r\ngamma\r\n');
    assertPureEol(result, '\r\n');
  });
});

test('a pure-LF file stays LF through the same multi-line replacement', () => {
  const lf = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const reply = fence('lf.ts', srBlock('const a = 1;\nconst b = 2;', 'const A = 1;\nconst B = 2;\nconst extra = 9;'));
  withTempProject({ 'lf.ts': lf }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.failures, []);
    const result = read(root, 'lf.ts');
    assert.equal(result, 'const A = 1;\nconst B = 2;\nconst extra = 9;\nconst c = 3;\n');
    assertPureEol(result, '\n');
  });
});

/* ------------------------------------------------------------------ *
 * (e) Context-only hunk: typed refusal for that file, siblings still apply.
 * ------------------------------------------------------------------ */

test('a context-only hunk is a typed refusal for its file while the other files still apply', () => {
  const noop = 'just context\nmore context\n';
  const reply = fence('apply-patch', [
    '*** Begin Patch',
    '*** Update File: noop.ts',
    '@@',
    ' just context',
    ' more context',
    '*** Update File: real.ts',
    '@@',
    '-old',
    '+new',
    '*** End Patch'
  ].join('\n'), 'diff');
  withTempProject({ 'noop.ts': noop, 'real.ts': 'old\n' }, (root) => {
    const scan = extractUnifiedPatchScan(reply, [
      { name: 'noop.ts', content: noop },
      { name: 'real.ts', content: 'old\n' }
    ]);
    assert.equal(scan.rejected.length, 1, 'a no-op hunk is never silently dropped');
    assert.equal(scan.rejected[0].path, 'noop.ts');
    assert.equal(scan.rejected[0].code, 'HUNK_NO_CHANGES');
    assert.match(scan.rejected[0].reason, /no changes/i);

    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.written, ['real.ts'], 'the sibling file in the same patch still lands');
    assert.equal(outcome.refusals.length, 1);
    assert.equal(outcome.refusals[0].code, 'HUNK_NO_CHANGES');
    assert.equal(read(root, 'noop.ts'), noop, 'zero bytes for the refused file');
    assert.equal(read(root, 'real.ts'), 'new\n');
  });
});

test('a context-only hunk mixed with a real hunk refuses the whole file, not half of it', () => {
  const reply = fence('apply-patch', [
    '*** Begin Patch',
    '*** Update File: mixed.ts',
    '@@',
    ' only context',
    '@@',
    '-old',
    '+new',
    '*** End Patch'
  ].join('\n'), 'diff');
  withTempProject({ 'mixed.ts': 'only context\nold\n' }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.written, []);
    assert.equal(outcome.refusals.length, 1);
    assert.equal(outcome.refusals[0].code, 'HUNK_NO_CHANGES');
    assert.equal(read(root, 'mixed.ts'), 'only context\nold\n');
  });
});

/* ------------------------------------------------------------------ *
 * (f) Regressions: the pre-existing behaviors are unchanged.
 * ------------------------------------------------------------------ */

test('regression: an ordinary SEARCH/REPLACE fence still lands byte-exact', () => {
  const original = 'export function App() {\n  const old = 1;\n  return old;\n}\n';
  const reply = ['Fixing the constant:', '', fence('src/App.tsx', srBlock('  const old = 1;', '  const old = 42;'))].join('\n');
  withTempProject({ 'src/App.tsx': original }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.written, ['src/App.tsx']);
    assert.equal(read(root, 'src/App.tsx'), original.replace('const old = 1;', 'const old = 42;'));
  });
});

test('regression: a whole-file rewrite and a new-file create still land', () => {
  const reply = [
    fence('small.ts', 'export const value = 2;', 'ts'),
    '',
    fence('src/new/Widget.ts', 'export const widget = 7;', 'ts')
  ].join('\n');
  withTempProject({ 'small.ts': 'export const value = 1;\n' }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.refusals, []);
    assert.deepEqual(outcome.written.sort(), ['small.ts', 'src/new/Widget.ts']);
    assert.equal(read(root, 'small.ts'), 'export const value = 2;');
    assert.equal(read(root, 'src/new/Widget.ts'), 'export const widget = 7;');
  });
});

test('regression: a reply cut off mid SEARCH/REPLACE fence is a typed refusal, zero bytes', () => {
  const reply = ['Here is the fix:', '```ts path=src/a.ts', '<<<<<<< ORIGINAL', 'const a = 1;', '=======', 'const a = 2;'].join('\n');
  withTempProject({ 'src/a.ts': 'const a = 1;\n' }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.written, []);
    assert.equal(outcome.refusals.length, 1);
    assert.equal(outcome.refusals[0].code, 'TRUNCATED_BLOCK');
    assert.equal(read(root, 'src/a.ts'), 'const a = 1;\n');
  });
});

test('regression: a fragment rewrite of a large existing file is still refused by the wipe guard', () => {
  const original = Array.from({ length: 40 }, (_, index) => `<div class="row-${index}"></div>`).join('\n');
  const reply = fence('form.html', '<div>new</div>\n<script>submit()</script>', 'html');
  withTempProject({ 'form.html': original }, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.written, []);
    assert.equal(outcome.refusals.length, 1);
    assert.equal(outcome.refusals[0].code, 'DESTRUCTIVE_REWRITE');
    assert.equal(read(root, 'form.html'), original);
  });
});

test('regression: two consecutive edit fences still extract as two patches (last per path wins)', () => {
  const reply = [
    fence('a.ts', 'export const a = 1;'),
    '',
    'Updating b.ts:',
    '',
    fence('b.ts', 'export const b = 2;'),
    '',
    'Adding a.ts again after a tool round:',
    '',
    fence('a.ts', 'export const a = 9;')
  ].join('\n');
  withTempProject({}, (root) => {
    const outcome = applyReplyToProject(reply, root);
    assert.deepEqual(outcome.refusals, []);
    assert.deepEqual(outcome.written.sort(), ['a.ts', 'b.ts']);
    assert.equal(read(root, 'a.ts'), 'export const a = 9;');
    assert.equal(read(root, 'b.ts'), 'export const b = 2;');
  });
});
