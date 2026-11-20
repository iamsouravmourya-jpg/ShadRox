import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFinishArguments, parseFinishDetails, renderFinishSummary, describeFinish } from './finishTool';

test('the legacy parser stays byte-compatible: {summary, blocked} only', () => {
  assert.deepEqual(parseFinishArguments({ summary: 'done', blocked: 'why' }), { summary: 'done', blocked: 'why' });
  assert.deepEqual(parseFinishArguments({ summary: 'done', verified: true, files_changed: ['a.ts'] }), { summary: 'done', blocked: null });
  assert.equal(parseFinishArguments({}), null);
  assert.deepEqual(parseFinishArguments('plain text'), { summary: 'plain text', blocked: null });
});

test('parseFinishDetails reads the honesty fields and their camelCase aliases', () => {
  const details = parseFinishDetails({
    summary: 'built the page',
    files_changed: ['index.html', 'styles.css'],
    verified: false,
    could_not_do: 'no logo yet',
    how_to_test: 'open index.html',
    blocked: 'rate limit'
  });
  assert.ok(details);
  assert.deepEqual(details.filesChanged, ['index.html', 'styles.css']);
  assert.equal(details.verified, false);
  assert.equal(details.couldNotDo, 'no logo yet');
  assert.equal(details.howToTest, 'open index.html');
  assert.equal(details.blocked, 'rate limit');

  const camel = parseFinishDetails({ summary: 'x', filesChanged: 'a.ts', couldNotDo: 'y', howToTest: 'z' });
  assert.deepEqual(camel?.filesChanged, ['a.ts']);
  assert.equal(camel?.couldNotDo, 'y');
  assert.equal(camel?.howToTest, 'z');
});

test('a non-boolean verified stays null so the loop resolves it', () => {
  assert.equal(parseFinishDetails({ summary: 'x', verified: 'yes' })?.verified, null);
  assert.equal(parseFinishDetails({ summary: 'x' })?.verified, null);
  assert.equal(parseFinishDetails({ summary: 'x', verified: true })?.verified, true);
});

test('a plain verified summary with nothing to add stays plain', () => {
  const details = parseFinishDetails({ summary: 'I read a.ts.' })!;
  assert.equal(renderFinishSummary(details, { verified: true, filesChanged: [], docsOnly: false }), 'I read a.ts.');
});

test('verified=false is ALWAYS visible in the text', () => {
  const details = parseFinishDetails({ summary: 'changed a.ts' })!;
  const text = renderFinishSummary(details, { verified: false, filesChanged: ['a.ts'], docsOnly: false });
  assert.match(text, /NOT VERIFIED/);
  assert.match(text, /Files changed: a\.ts/);
});

test('a docs-only turn says verification does not apply', () => {
  const details = parseFinishDetails({ summary: 'updated the readme' })!;
  const text = renderFinishSummary(details, { verified: false, filesChanged: ['README.md'], docsOnly: true });
  assert.match(text, /documentation-only turn/);
});

test('the model\'s file list merges with the real changed set, deduped', () => {
  const details = parseFinishDetails({ summary: 'x', files_changed: ['a.ts', 'extra.ts'] })!;
  const text = renderFinishSummary(details, { verified: true, filesChanged: ['a.ts', 'b.ts'], docsOnly: false });
  assert.match(text, /Files changed: a\.ts, b\.ts, extra\.ts/);
});

test('could_not_do, how_to_test and blocked render as their own lines', () => {
  const details = parseFinishDetails({ summary: 'x', could_not_do: 'c', how_to_test: 'h', blocked: 'b' })!;
  const text = renderFinishSummary(details, { verified: true, filesChanged: [], docsOnly: false });
  assert.match(text, /Could not do: c/);
  assert.match(text, /How to test: h/);
  assert.match(text, /Blocked: b/);
});

test('describeFinish stays one line and teaches the new fields', () => {
  const line = describeFinish();
  assert.ok(!line.includes('\n'), 'the finish rule is a single prompt line');
  assert.match(line, /FINISHING THE TURN/);
  assert.match(line, /files_changed/);
  assert.match(line, /verified/);
  assert.match(line, /could_not_do/);
  assert.match(line, /how_to_test/);
});