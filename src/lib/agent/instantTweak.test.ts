import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInstantTweakSystemPrompt, isInstantTweakCandidate } from './instantTweak';

const base = { writesFiles: true, hasActiveFile: true };

test('isInstantTweakCandidate accepts short, write-mode edit asks against an open file', () => {
  assert.equal(isInstantTweakCandidate({ ...base, text: 'rename foo to bar' }), true);
  assert.equal(isInstantTweakCandidate({ ...base, text: 'fix the typo on line 3' }), true);
  assert.equal(isInstantTweakCandidate({ ...base, text: 'format this file' }), true);
  assert.equal(isInstantTweakCandidate({ ...base, text: 'remove the unused import' }), true);
});

test('isInstantTweakCandidate refuses questions, long asks, code fences and read-only turns', () => {
  assert.equal(isInstantTweakCandidate({ ...base, text: 'what does this function do?' }), false, 'a question');
  assert.equal(isInstantTweakCandidate({ ...base, text: 'explain how the parser works' }), false, 'explanation verb');
  assert.equal(isInstantTweakCandidate({ ...base, text: 'x'.repeat(201) }), false, 'too long');
  assert.equal(isInstantTweakCandidate({ ...base, text: 'change ```code``` here' }), false, 'already has a fence');
  assert.equal(isInstantTweakCandidate({ ...base, writesFiles: false, text: 'rename foo to bar' }), false, 'read-only turn');
  assert.equal(isInstantTweakCandidate({ ...base, hasActiveFile: false, text: 'rename foo to bar' }), false, 'no file open');
  assert.equal(isInstantTweakCandidate({ ...base, text: '   ' }), false, 'empty');
});

test('isInstantTweakCandidate refuses a task-sized request even with a tweak verb', () => {
  const manyWords = Array.from({ length: 41 }, () => 'word').join(' ');
  assert.equal(isInstantTweakCandidate({ ...base, text: `add ${manyWords}` }), false);
});

test('buildInstantTweakSystemPrompt names the target and teaches the edit fences without tools', () => {
  const lines = buildInstantTweakSystemPrompt('src/App.tsx');
  const text = lines.join('\n');
  assert.match(text, /src\/App\.tsx/);
  assert.match(text, /ONE-SHOT EDIT MODE/);
  assert.match(text, /<<<<<<< ORIGINAL/);
  assert.match(text, />>>>>>> UPDATED/);
  assert.match(text, /Do NOT use tools/);
  // No active file: falls back to a generic target and still forbids tools.
  assert.match(buildInstantTweakSystemPrompt(null).join('\n'), /the active file/);
});