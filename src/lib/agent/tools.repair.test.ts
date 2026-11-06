/**
 * The `run_command` repair lifecycle, end to end through the real tool.
 *
 * A stub bridge stands in for the shell; everything between the command text
 * and the receipt on the ledger is production code: classification, capture,
 * the proposed repair, and the re-run that decides the verdict.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runTool } from './tools';
import { globalProofLedger } from '../proofLedger';
import { globalRepairSession } from '../repairSession';
import type { DesktopCommandResult } from '../desktop';

function withBridge(runCommand: () => DesktopCommandResult, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: { shadroxDesktop: { platform: 'win32', runCommand: async () => runCommand() } },
    configurable: true,
    writable: true
  });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

function reset() {
  globalRepairSession.reset();
  globalProofLedger.clear();
}

test('a failed test command is captured as source "test", not "terminal"', async (t) => {
  t.after(reset);
  reset();
  await withBridge(
    () => ({ stdout: '', stderr: '2 tests failed', exitCode: 1 }),
    async () => {
      const outcome = await runTool('ws', { name: 'run_command', args: { command: 'npm test' } });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.proof?.source, 'test');
      assert.equal(outcome.proof?.status, 'captured');
      assert.equal(outcome.proof?.exitCode, 1);
      assert.match(outcome.content, /SELF-HEALING PROOF RECEIPT/);
      assert.equal(globalProofLedger.getFailureReceipt(outcome.proof!.id)?.source, 'test');
    }
  );
});

test('a proposed repair is verified healed only by a clean re-run', async (t) => {
  t.after(reset);
  reset();
  let exitCode = 1;
  await withBridge(
    () => (exitCode === 0
      ? { stdout: '10 tests passed', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: 'AssertionError: expected true', exitCode }),
    async () => {
      globalRepairSession.beginTurn('cp-turn-1');
      const failed = await runTool('ws', { name: 'run_command', args: { command: 'npm run test:unit' } });
      assert.equal(failed.ok, false);
      assert.ok(failed.proof);
      assert.equal(failed.proof.checkpointId, 'cp-turn-1', 'the turn checkpoint is on the receipt');

      // The apply pipeline's success path calls exactly this.
      const proposed = globalRepairSession.onEditApplied('Applied 1 file(s) through the patch engine: src/run.ts');
      assert.equal(proposed.length, 1);
      assert.equal(proposed[0].status, 'repair_proposed');

      exitCode = 0;
      const healed = await runTool('ws', { name: 'run_command', args: { command: 'npm run test:unit' } });
      assert.equal(healed.ok, true);
      assert.equal(healed.proof?.id, failed.proof.id, 'the same receipt is healed, not replaced');
      assert.equal(healed.proof?.status, 'verified_healed');
      assert.match(healed.content, /Healing verified/);
      assert.equal(globalProofLedger.getFailureReceipt(failed.proof.id)?.status, 'verified_healed');
    }
  );
  globalRepairSession.endTurn();
});

test('a still-failing re-run moves the proposal to healing_failed without a new receipt', async (t) => {
  t.after(reset);
  reset();
  let exitCode = 1;
  let stderr = 'TS2345: still broken';
  await withBridge(
    () => ({ stdout: '', stderr, exitCode }),
    async () => {
      const failed = await runTool('ws', { name: 'run_command', args: { command: 'npm run typecheck' } });
      assert.equal(failed.proof?.source, 'compiler');
      assert.ok(failed.proof);
      globalRepairSession.onEditApplied('Applied 1 file(s) through the patch engine: src/app.ts');

      exitCode = 2;
      stderr = 'TS2322: type mismatch';
      const again = await runTool('ws', { name: 'run_command', args: { command: 'npm run typecheck' } });
      assert.equal(again.ok, false);
      assert.equal(again.proof?.id, failed.proof.id);
      assert.equal(again.proof?.status, 'healing_failed');
      assert.match(again.proof?.verificationEvidence ?? '', /exited 2/);
      assert.match(again.proof?.verificationEvidence ?? '', /TS2322/);
      assert.equal(globalProofLedger.getAllFailureReceipts().length, 1, 'a refuted repair is not a second failure');
    }
  );
});

test('a command with no proposed repair is never reported as healed', async (t) => {
  t.after(reset);
  reset();
  let exitCode = 0;
  await withBridge(
    () => ({ stdout: exitCode === 0 ? 'ok' : 'boom', stderr: '', exitCode }),
    async () => {
      const clean = await runTool('ws', { name: 'run_command', args: { command: 'npm run build' } });
      assert.equal(clean.ok, true);
      assert.equal(clean.proof, undefined, 'a passing build proves no healing');
      assert.equal(globalProofLedger.getAllFailureReceipts().length, 0);

      exitCode = 1;
      const failed = await runTool('ws', { name: 'run_command', args: { command: 'npm run build' } });
      assert.equal(failed.proof?.source, 'compiler');
      exitCode = 0;
      const retried = await runTool('ws', { name: 'run_command', args: { command: 'npm run build' } });
      assert.equal(retried.proof, undefined);
      assert.equal(failed.proof?.status, 'captured');
      assert.equal(globalProofLedger.getFailureReceipt(failed.proof!.id)?.status, 'captured');
    }
  );
});
