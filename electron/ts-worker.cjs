const { parentPort, workerData } = require('node:worker_threads');
const { createWorkspaceSession, WORKER_METHODS } = require('./ts-service.cjs');

let session = null;

function getSession() {
  if (!session) session = createWorkspaceSession(workerData.root);
  return session;
}

parentPort.on('message', (message) => {
  const { id, method, args } = message;
  if (!WORKER_METHODS.has(method)) {
    parentPort.postMessage({ id, error: `Unsupported language-service method "${method}".` });
    return;
  }

  try {
    const result = getSession()[method](...(Array.isArray(args) ? args : []));
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
