import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginTurn, endTurn, getTurn, resetTurns, noteRead, noteWrite, noteUnknownWrite, noteVerification,
  hasMutations, isDocsOnlyTurn, satisfyingVerification, needsVerification, changedPathList, verificationDemand
} from './turnState';

test.afterEach(() => resetTurns());

test('beginTurn replaces a stale entry and endTurn removes it', () => {
  const first = beginTurn('ws', 'ask one', { scaffold: false, addPage: false });
  noteRead(first, 'a.ts');
  const second = beginTurn('ws', 'ask two', { scaffold: true, addPage: false });
  assert.notEqual(first, second);
  assert.equal(second.reads.size, 0, 'a crashed turn never leaks its read-set');
  assert.equal(second.scaffoldIntent, true);
  assert.equal(getTurn('ws'), second);
  endTurn('ws');
  assert.equal(getTurn('ws'), null);
  assert.equal(getTurn(null), null);
});

test('a read lands in the read-set with its hash; a write bumps the mutation seq', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteRead(turn, 'src/a.ts', 'h1');
  assert.ok(turn.reads.has('src/a.ts'));
  assert.equal(turn.readHashes.get('src/a.ts'), 'h1');
  assert.equal(hasMutations(turn), false);
  noteWrite(turn, ['src/a.ts'], []);
  assert.equal(hasMutations(turn), true);
  assert.equal(turn.lastMutationSeq, turn.seq);
  assert.ok(turn.changed.has('src/a.ts'));
});

test('a created path is both changed and created', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteWrite(turn, ['new.ts'], ['new.ts']);
  assert.ok(turn.changed.has('new.ts'));
  assert.ok(turn.created.has('new.ts'));
  assert.deepEqual(changedPathList(turn), ['new.ts']);
});

test('an unknown write (command/MCP) counts as a mutation without a path', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteUnknownWrite(turn);
  assert.equal(hasMutations(turn), true);
  assert.equal(turn.unknownWrites, 1);
  assert.equal(isDocsOnlyTurn(turn), false, 'unknown reach can never be docs-only');
});

test('a write with no verification needs verification; the demand names the files', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteWrite(turn, ['src/a.ts', 'src/b.ts'], []);
  assert.equal(needsVerification(turn), true);
  const demand = verificationDemand(turn);
  assert.match(demand, /finish refused/);
  assert.match(demand, /src\/a\.ts/);
  assert.match(demand, /verify/);
  assert.match(demand, /problems/);
});

test('a verify after the last write satisfies the gate even when it failed', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteWrite(turn, ['a.ts'], []);
  noteVerification(turn, { kind: 'verify', ok: false, paths: [], detail: 'ran' });
  assert.equal(needsVerification(turn), false, 'a failed check still RAN');
  assert.equal(satisfyingVerification(turn)?.ok, false);
});

test('a verification before the last write does not satisfy the gate', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteVerification(turn, { kind: 'verify', ok: true, paths: [], detail: 'early' });
  noteWrite(turn, ['a.ts'], []);
  assert.equal(needsVerification(turn), true, 'the write landed after the check');
});

test('a problems check must cover every changed path to satisfy', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteWrite(turn, ['a.ts', 'b.ts'], []);
  noteVerification(turn, { kind: 'problems', ok: true, paths: ['a.ts'], detail: 'partial' });
  assert.equal(needsVerification(turn), true, 'b.ts was not covered');
  noteVerification(turn, { kind: 'problems', ok: true, paths: ['a.ts', 'b.ts'], detail: 'full' });
  assert.equal(needsVerification(turn), false);
});

test('a whole-project problems check (empty paths) covers everything', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteWrite(turn, ['a.ts', 'b.ts'], []);
  noteVerification(turn, { kind: 'problems', ok: true, paths: [], detail: 'project' });
  assert.equal(needsVerification(turn), false);
});

test('a documentation-only turn is exempt from verification', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteWrite(turn, ['README.md', 'docs/guide.md'], []);
  assert.equal(isDocsOnlyTurn(turn), true);
  assert.equal(needsVerification(turn), false);
});

test('a turn mixing code and docs is NOT docs-only', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteWrite(turn, ['README.md', 'src/a.ts'], []);
  assert.equal(isDocsOnlyTurn(turn), false);
  assert.equal(needsVerification(turn), true);
});

test('a read-only turn never needs verification', () => {
  const turn = beginTurn('ws', 'ask', { scaffold: false, addPage: false });
  noteRead(turn, 'a.ts');
  assert.equal(hasMutations(turn), false);
  assert.equal(needsVerification(turn), false);
});