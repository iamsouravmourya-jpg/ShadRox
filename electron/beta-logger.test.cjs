const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createBetaLogger,
  redactDiagnostics,
  redactString
} = require('./beta-logger.cjs');

test('redactString scrubs API keys, bearer tokens, and Windows/macOS/Linux user home directories', () => {
  const geminiKey = 'AIzaSyDummyTestKey1234567890abcd';
  const openaiKey = 'sk-proj-TestSecretKeyValue1234567890';
  const groqKey = 'gsk_TestGroqKeyValue1234567890abcd';
  const raw =
    `Error with ${geminiKey}, ${openaiKey}, ${groqKey}, Bearer supersecrettoken123 ` +
    'in C:\\Users\\Alice\\Documents\\repo and /Users/bob/Code and /home/carol/app';

  const clean = redactString(raw);
  assert.equal(clean.includes(geminiKey), false);
  assert.equal(clean.includes(openaiKey), false);
  assert.equal(clean.includes(groqKey), false);
  assert.equal(clean.includes('supersecrettoken123'), false);
  assert.equal(clean.includes('Alice'), false);
  assert.equal(clean.includes('bob'), false);
  assert.equal(clean.includes('carol'), false);
  assert.match(clean, /C:\\Users\\<user>/);
  assert.match(clean, /\/Users\/<user>/);
  assert.match(clean, /\/home\/<user>/);
});

test('redactDiagnostics masks secret-like meta keys recursively', () => {
  const redacted = redactDiagnostics({
    apiKey: 'secret-value-123456',
    nested: {
      authorization: 'Bearer abcdefghijklmnop',
      note: 'path C:\\Users\\DevUser\\proj\\a.ts'
    }
  });
  assert.equal(redacted.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.authorization, '[REDACTED]');
  assert.equal(redacted.nested.note.includes('DevUser'), false);
});

test('createBetaLogger enforces a 500-entry ring buffer and persists JSONL records to disk', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-beta-log-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const logger = createBetaLogger({ logDir: tmpDir });
  for (let i = 0; i < 525; i += 1) {
    logger.record({
      level: i % 10 === 0 ? 'error' : 'info',
      source: 'autonomy',
      event: `evt-${i}`,
      message: `Event ${i} for C:\\Users\\Tester\\repo`
    });
  }

  await logger.flush();
  const recent = logger.getRecent();
  assert.equal(recent.length, 500);
  assert.equal(recent[0].event, 'evt-524');
  assert.equal(recent[499].event, 'evt-25');
  assert.equal(recent[0].message.includes('Tester'), false);

  const fileContents = await fs.readFile(path.join(tmpDir, 'shadrox-beta.log'), 'utf8');
  const lines = fileContents.trim().split('\n');
  assert.equal(lines.length, 525);
  const parsedLast = JSON.parse(lines[lines.length - 1]);
  assert.equal(parsedLast.event, 'evt-524');
  assert.equal(parsedLast.message.includes('Tester'), false);
});
