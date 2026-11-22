'use strict';

const { createHash } = require('node:crypto');
const { redactCommandForProof } = require('../proof-redact.cjs');

function clipProofText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > 4096 ? `${text.slice(0, 4096)}…` : text;
}

function hashProofText(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : '').digest('hex');
}

function createCommandProofRecorder({ proofService }) {
  return async function recordCommandProof(workspaceId, command, run) {
    try {
      const redacted = redactCommandForProof(command);
      await proofService.append(workspaceId, {
        type: run.deniedReason ? 'command.denied' : 'command.run',
        actor: 'agent',
        data: {
          argv: clipProofText(redacted),
          commandHash: hashProofText(redacted),
          exitCode: run.exitCode ?? null,
          stdoutHash: hashProofText(run.stdout),
          stderrHash: hashProofText(run.stderr),
          ...(run.tier ? { tier: run.tier } : {}),
          ...(run.jobId ? { jobId: run.jobId } : {}),
          ...(run.backgrounded ? { backgrounded: true } : {}),
          ...(run.deniedReason ? { deniedReason: clipProofText(run.deniedReason) } : {})
        }
      });
    } catch (error) {
      // A ledger write must not change the command result the user already saw.
      console.error(`[desktop] proof ledger append failed for workspace ${workspaceId}:`, error?.message ?? error);
    }
  };
}

function registerProofHandlers({
  ipcMain,
  assertTrustedRenderer,
  proofService,
  workspaceAccess,
  getActiveWorkspaceId,
  PROOF_APP_SCOPE
}) {
  ipcMain.handle('proof:append-receipt', async (event, receipt, kind) => {
    assertTrustedRenderer(event);
    const isUpdate = kind === 'update';
    const { record, receiptHash } = await proofService.appendReceipt(receipt, isUpdate ? 'receipt.update' : 'receipt.failure');
    return { seq: record.seq, ts: record.ts, proofHash: record.hash, keyId: record.keyId, receiptHash };
  });

  ipcMain.handle('proof:append-milestone', async (event, proof) => {
    assertTrustedRenderer(event);
    const record = await proofService.appendMilestone(proof);
    return { seq: record.seq, ts: record.ts, proofHash: record.hash, keyId: record.keyId };
  });

  ipcMain.handle('proof:receipts', (event) => {
    assertTrustedRenderer(event);
    return proofService.readReceipts(PROOF_APP_SCOPE);
  });

  ipcMain.handle('proof:records', (event, workspaceId) => {
    assertTrustedRenderer(event);
    const target = typeof workspaceId === 'string' && workspaceId ? workspaceId : PROOF_APP_SCOPE;
    return proofService.readRecords(target);
  });

  ipcMain.handle('proof:verify', (event, workspaceId) => {
    assertTrustedRenderer(event);
    const activeWorkspaceId = getActiveWorkspaceId();
    const target =
      typeof workspaceId === 'string' && workspaceId
        ? workspaceId
        : activeWorkspaceId && workspaceAccess.getWorkspace(activeWorkspaceId)
          ? activeWorkspaceId
          : PROOF_APP_SCOPE;
    return proofService.verify(target);
  });
}

function registerDebugHandlers({
  ipcMain,
  assertTrustedRenderer,
  debugHost,
  dialog,
  app,
  bundledDebugRoots,
  getMainWindow
}) {
  ipcMain.handle('debug:config', (event, workspaceId) => {
    assertTrustedRenderer(event);
    return debugHost.configs(workspaceId);
  });

  ipcMain.handle('debug:start', async (event, workspaceId, configName) => {
    assertTrustedRenderer(event);
    return debugHost.start(
      workspaceId,
      typeof configName === 'string' ? configName : undefined,
      async ({ command, args, cwd }) => {
        const choice = await dialog.showMessageBox(getMainWindow(), {
          type: 'warning',
          buttons: ['Cancel', 'Start debugger'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Approve external debug adapter',
          message: 'This workspace wants to start an external debug adapter.',
          detail: `Command: ${command}\nArguments: ${args.join(' ') || '(none)'}\nDirectory: ${cwd}`
        });
        return choice.response === 1;
      },
      [app.getAppPath(), ...bundledDebugRoots]
    );
  });

  ipcMain.handle('debug:stop', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    await debugHost.stop(workspaceId);
  });

  ipcMain.handle('debug:breakpoints', async (event, workspaceId, file, lines) => {
    assertTrustedRenderer(event);
    return debugHost.setBreakpoints(workspaceId, file, lines);
  });

  ipcMain.handle('debug:threads', (event, workspaceId) => {
    assertTrustedRenderer(event);
    return debugHost.threads(workspaceId);
  });

  ipcMain.handle('debug:stack', (event, workspaceId) => {
    assertTrustedRenderer(event);
    return debugHost.stack(workspaceId);
  });

  ipcMain.handle('debug:scopes', (event, workspaceId, frameId) => {
    assertTrustedRenderer(event);
    return debugHost.scopes(workspaceId, frameId);
  });

  ipcMain.handle('debug:variables', (event, workspaceId, variablesReference) => {
    assertTrustedRenderer(event);
    return debugHost.variables(workspaceId, variablesReference);
  });

  ipcMain.handle('debug:evaluate', (event, workspaceId, frameId, expression) => {
    assertTrustedRenderer(event);
    return debugHost.evaluate(workspaceId, frameId, expression);
  });

  ipcMain.handle('debug:continue', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.continue(workspaceId, threadId);
  });

  ipcMain.handle('debug:next', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.next(workspaceId, threadId);
  });

  ipcMain.handle('debug:step-in', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.stepIn(workspaceId, threadId);
  });

  ipcMain.handle('debug:step-out', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.stepOut(workspaceId, threadId);
  });

  ipcMain.handle('debug:pause', (event, workspaceId, threadId) => {
    assertTrustedRenderer(event);
    return debugHost.pause(workspaceId, threadId);
  });

  ipcMain.handle('debug:state', (event, workspaceId) => {
    assertTrustedRenderer(event);
    return debugHost.state(workspaceId);
  });
}

module.exports = {
  createCommandProofRecorder,
  registerProofHandlers,
  registerDebugHandlers
};
