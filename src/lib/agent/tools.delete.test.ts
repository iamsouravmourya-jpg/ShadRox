import assert from 'node:assert/strict';
import test from 'node:test';

import { settleConfirm, subscribeConfirm, type ConfirmRequest } from '../confirm';
import { classifyToolEffect, runTool } from './tools';

function withBridge(stub: Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { shadroxDesktop: stub }, configurable: true, writable: true });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

/**
 * What a user does when the delete dialog opens: click, or never answer. The
 * tool must behave the same either way, so every test below states its answer.
 */
function withApproval(accepted: boolean, requests: ConfirmRequest[], body: () => Promise<void>) {
  const off = subscribeConfirm((request) => {
    requests.push(request);
    settleConfirm(accepted);
  });
  return body().finally(off);
}

const deleteCall = { name: 'delete_file', args: { path: 'gone.txt', confirm: true } };
const approvedDelete = (body: () => Promise<void>) => withApproval(true, [], body);
const notFound = () => Object.assign(new Error("ENOENT: no such file or directory, lstat 'gone.txt'"), { code: 'ENOENT' });

test('delete_file still requires confirm: true', async () => {
  let deleted = false;
  await approvedDelete(async () => {
    await withBridge(
      {
        deletePath: async () => {
          deleted = true;
          return { path: 'gone.txt', kind: 'file' };
        },
        readFile: async () => {
          throw notFound();
        }
      },
      async () => {
        const outcome = await runTool('ws', { name: 'delete_file', args: { path: 'gone.txt' } });
        assert.equal(outcome.ok, false);
        assert.equal(outcome.refused, true);
        assert.match(outcome.error as string, /confirm: true/);
        assert.equal(deleted, false, 'nothing is deleted without confirmation');
      }
    );
  });
});

test('a delete the user has not approved removes nothing, whatever the model attested', async () => {
  const requests: ConfirmRequest[] = [];
  let deleted = false;
  await withApproval(false, requests, async () => {
    await withBridge(
      {
        deletePath: async () => {
          deleted = true;
          return { path: 'gone.txt', kind: 'file' };
        },
        readFile: async () => {
          throw notFound();
        }
      },
      async () => {
        const outcome = await runTool('ws', deleteCall);
        assert.equal(outcome.ok, false);
        assert.equal(outcome.refused, true, 'a refusal is not a failed operation');
        assert.equal(deleted, false, 'the bridge was never reached');
        assert.match(outcome.error as string, /did not approve/);
        assert.match(outcome.error as string, /Do not retry/);
      }
    );
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.title, 'Delete gone.txt?', 'the path clicked on is the path named');
  assert.equal(requests[0]?.tone, 'danger');
});

test('an unapproved delete is asked about once, not per attempt', async () => {
  const requests: ConfirmRequest[] = [];
  await withApproval(false, requests, async () => {
    await withBridge(
      {
        deletePath: async () => ({ path: 'gone.txt', kind: 'file' }),
        readFile: async () => {
          throw notFound();
        }
      },
      async () => {
        await runTool('ws', deleteCall);
        await runTool('ws', deleteCall);
      }
    );
  });
  assert.equal(requests.length, 2, 'each call asks; nothing remembers a yes for the next file');
});

test('a typed not-found read verifies the delete', async () => {
  await approvedDelete(async () => {
    await withBridge(
      {
        deletePath: async () => ({ path: 'gone.txt', kind: 'file' }),
        readFile: async () => {
          throw notFound();
        }
      },
      async () => {
        const outcome = await runTool('ws', deleteCall);
        assert.equal(outcome.ok, true);
        assert.match(outcome.content, /verified gone from disk/);
      }
    );
  });
});

test('a not-found message without a code still verifies the delete', async () => {
  await approvedDelete(async () => {
    await withBridge({
      deletePath: async () => ({ path: 'gone.txt', kind: 'file' }),
      readFile: async () => {
        throw new Error('That path is no longer in the workspace.');
      }
    }, async () => {
      const outcome = await runTool('ws', deleteCall);
      assert.equal(outcome.ok, true);
      assert.match(outcome.content, /verified gone/);
    });
  });
});

test('a permission error after delete never proves absence', async () => {
  await approvedDelete(async () => {
    await withBridge({
      deletePath: async () => ({ path: 'gone.txt', kind: 'file' }),
      readFile: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
    }, async () => {
      const outcome = await runTool('ws', deleteCall);
      assert.equal(outcome.ok, false, 'an unverified delete is not a success');
      assert.doesNotMatch(outcome.content, /verified gone/);
      assert.match(outcome.content, /could not be verified/);
      assert.match(outcome.error as string, /unverified/);
      assert.match(outcome.error as string, /EACCES/);
    });
  });
});

test('an unrelated read failure reports unverified, not gone', async () => {
  await approvedDelete(async () => {
    await withBridge({
      deletePath: async () => ({ path: 'gone.txt', kind: 'file' }),
      readFile: async () => {
        throw new Error('This desktop workspace is no longer open.');
      }
    }, async () => {
      const outcome = await runTool('ws', deleteCall);
      assert.equal(outcome.ok, false);
      assert.doesNotMatch(outcome.content, /verified gone/);
      assert.match(outcome.content, /could not be verified/);
    });
  });
});

test('a file still readable after delete is reported as not removed', async () => {
  await approvedDelete(async () => {
    await withBridge({
      deletePath: async () => ({ path: 'gone.txt', kind: 'file' }),
      readFile: async () => ({ name: 'gone.txt', content: 'still here', version: 'v' })
    }, async () => {
      const outcome = await runTool('ws', deleteCall);
      assert.equal(outcome.ok, false);
      assert.match(outcome.error as string, /still on disk/);
    });
  });
});

test('a delete the bridge refuses is a failure, not a verified removal', async () => {
  await approvedDelete(async () => {
    await withBridge({
      deletePath: async () => {
        throw new Error('Only an empty folder can be deleted.');
      },
      readFile: async () => {
        throw notFound();
      }
    }, async () => {
      const outcome = await runTool('ws', { name: 'delete_file', args: { path: 'full-dir', confirm: true } });
      assert.equal(outcome.ok, false);
      assert.match(outcome.error as string, /Only an empty folder/);
      assert.doesNotMatch(outcome.content, /verified gone/);
    });
  });
});

test('native tools classify into read/write/execute/control and unknown fails closed to external', () => {
  assert.equal(classifyToolEffect('read_file'), 'read');
  assert.equal(classifyToolEffect('list_directory'), 'read');
  assert.equal(classifyToolEffect('search_text'), 'read');
  assert.equal(classifyToolEffect('problems'), 'read');
  assert.equal(classifyToolEffect('git_state'), 'read');
  assert.equal(classifyToolEffect('terminal_state'), 'read');
  assert.equal(classifyToolEffect('debugger_state'), 'read');
  assert.equal(classifyToolEffect('outline'), 'read');
  assert.equal(classifyToolEffect('delete_file'), 'write');
  assert.equal(classifyToolEffect('run_command'), 'execute');
  assert.equal(classifyToolEffect('terminal_answer'), 'execute');
  assert.equal(classifyToolEffect('update_tasks'), 'control');
  assert.equal(classifyToolEffect('finish'), 'control');
  assert.equal(classifyToolEffect('mcp__search__web'), 'external');
  assert.equal(classifyToolEffect('not_a_tool'), 'external');
});