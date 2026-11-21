import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server';

function makeStaticDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-srv-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
  return dir;
}

test('startServer binds 127.0.0.1 by default when HOST is unset', async () => {
  const previousHost = process.env.HOST;
  delete process.env.HOST;
  const staticDir = makeStaticDir();
  const handle = await startServer({ mode: 'production', port: 0, staticDirectory: staticDir });
  try {
    const parsed = new URL(handle.origin);
    assert.equal(parsed.hostname, '127.0.0.1');
    const health = await fetch(`${handle.origin}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    await handle.close();
    fs.rmSync(staticDir, { recursive: true, force: true });
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  }
});

test('startServer honors explicit HOST env opt-in', async () => {
  const previousHost = process.env.HOST;
  process.env.HOST = '0.0.0.0';
  const staticDir = makeStaticDir();
  const handle = await startServer({ mode: 'production', port: 0, staticDirectory: staticDir });
  try {
    const parsed = new URL(handle.origin);
    assert.equal(parsed.hostname, 'localhost');
  } finally {
    await handle.close();
    fs.rmSync(staticDir, { recursive: true, force: true });
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  }
});
