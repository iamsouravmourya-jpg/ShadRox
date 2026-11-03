const assert = require('node:assert/strict');
const test = require('node:test');
const {
  resolveTerminalPlan,
  agentEnvironment,
  isCredentialVariable,
  clampTerminalSize,
  normalizeTerminalSessionKey,
  isSafeExternalUrl
} = require('./terminal-modes.cjs');

const WINDOWS_ENV = {
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  PATH: 'C:\\Windows\\System32',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  SHADROX_GEMINI_API_KEY: 'AIza-super-secret',
  OPENAI_API_KEY: 'sk-secret',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  GITHUB_TOKEN: 'ghp-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret'
};

test('the system shell keeps the user environment and prefers PowerShell on Windows', () => {
  const plan = resolveTerminalPlan({
    platform: 'win32',
    env: WINDOWS_ENV,
    mode: 'system',
    existsSync: (candidate) => candidate.endsWith('powershell.exe')
  });
  assert.equal(plan.mode, 'system');
  assert.equal(plan.label, 'PowerShell');
  assert.deepEqual(plan.shellArgs, ['-NoLogo']);
  assert.equal(plan.env.SHADROX_GEMINI_API_KEY, 'AIza-super-secret');
});

test('the system shell falls back to ComSpec when PowerShell is missing', () => {
  const plan = resolveTerminalPlan({ platform: 'win32', env: WINDOWS_ENV, mode: 'system', existsSync: () => false });
  assert.equal(plan.shellPath, WINDOWS_ENV.ComSpec);
  assert.deepEqual(plan.shellArgs, []);
  assert.equal(plan.label, 'Command Prompt');
});

test('the agent shell runs ComSpec without any credential variables', () => {
  const plan = resolveTerminalPlan({ platform: 'win32', env: WINDOWS_ENV, mode: 'agent', existsSync: () => true });
  assert.equal(plan.shellPath, WINDOWS_ENV.ComSpec);
  assert.equal(plan.env.SHADROX_GEMINI_API_KEY, undefined);
  assert.equal(plan.env.OPENAI_API_KEY, undefined);
  assert.equal(plan.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(plan.env.GITHUB_TOKEN, undefined);
  assert.equal(plan.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(plan.env.PATH, WINDOWS_ENV.PATH);
  assert.equal(plan.env.SystemRoot, WINDOWS_ENV.SystemRoot);
});

test('unknown or missing modes resolve to the system shell', () => {
  const plan = resolveTerminalPlan({ platform: 'win32', env: WINDOWS_ENV, mode: 'nonsense', existsSync: () => true });
  assert.equal(plan.mode, 'system');
});

test('posix agent shells are stripped too, while the user shell keeps $SHELL', () => {
  const env = { SHELL: '/bin/zsh', PATH: '/usr/bin', GROQ_API_KEY: 'gsk_secret', HOME: '/home/dev' };
  assert.equal(resolveTerminalPlan({ platform: 'linux', env, mode: 'agent' }).shellPath, '/bin/sh');
  const system = resolveTerminalPlan({ platform: 'linux', env, mode: 'system' });
  assert.equal(system.shellPath, '/bin/zsh');
  assert.equal(system.env.GROQ_API_KEY, 'gsk_secret');
  const agent = resolveTerminalPlan({ platform: 'linux', env, mode: 'agent' });
  assert.equal(agent.env.GROQ_API_KEY, undefined);
  assert.equal(agent.env.HOME, '/home/dev');
});

test('credential detection covers keys, tokens and secrets but not ordinary paths', () => {
  assert.equal(isCredentialVariable('OPENAI_API_KEY'), true);
  assert.equal(isCredentialVariable('ACCESS_TOKEN'), true);
  assert.equal(isCredentialVariable('DB_PASSWORD'), true);
  assert.equal(isCredentialVariable('PATH'), false);
  assert.equal(isCredentialVariable('SystemRoot'), false);
  assert.equal(agentEnvironment({ FOO_SESSION: 'x', FOO: 'y' }).FOO, 'y');
});

test('credential detection survives camelCase and glued variable names', () => {
  // The boundary-only pattern needed an underscore, so these all reached the
  // assistant's shell with their values intact.
  for (const name of ['Geminiapikey', 'myOpenAiKey', 'awsSecretAccessKey', 'PrivateKEY', 'DB_SECRETS']) {
    assert.equal(isCredentialVariable(name), true, `${name} must be scrubbed`);
  }
  for (const name of ['PATH', 'PATHEXT', 'COMSPEC', 'TMPDIR', 'USERNAME', 'SystemRoot', 'PSModulePath', 'OneDrive', 'SESSIONNAME', 'AUTHOR']) {
    assert.equal(isCredentialVariable(name), false, `${name} must survive`);
  }
  const agent = resolveTerminalPlan({
    platform: 'linux',
    env: { PATH: '/usr/bin', Geminiapikey: 'AIza_secret', HOME: '/home/dev' },
    mode: 'agent'
  });
  assert.equal(agent.env.Geminiapikey, undefined);
  assert.equal(agent.env.PATH, '/usr/bin');
});

test('terminal sizes are clamped into the range node-pty accepts', () => {
  assert.deepEqual(clampTerminalSize(120, 40), { cols: 120, rows: 40 });
  assert.deepEqual(clampTerminalSize(2, 1), { cols: 20, rows: 5 });
  assert.deepEqual(clampTerminalSize(9999, 9999), { cols: 400, rows: 200 });
  assert.deepEqual(clampTerminalSize(undefined, undefined), { cols: 100, rows: 30 });
  assert.deepEqual(clampTerminalSize('not-a-number', NaN), { cols: 100, rows: 30 });
  assert.deepEqual(clampTerminalSize(-5, 0), { cols: 100, rows: 30 });
  assert.deepEqual(clampTerminalSize(81.9, 24.4), { cols: 81, rows: 24 });
});

test('renderer tab keys are accepted only as plain tokens', () => {
  assert.equal(normalizeTerminalSessionKey('aB3-_xyz'), 'aB3-_xyz');
  assert.equal(normalizeTerminalSessionKey('2f1c9a7e-6b5d-4c3b-9a1f-0d2e4c6a8b0c'), '2f1c9a7e-6b5d-4c3b-9a1f-0d2e4c6a8b0c');
  assert.equal(normalizeTerminalSessionKey('short'), null);
  assert.equal(normalizeTerminalSessionKey('has spaces'), null);
  assert.equal(normalizeTerminalSessionKey('../../etc/passwd'), null);
  assert.equal(normalizeTerminalSessionKey('x'.repeat(100)), null);
  assert.equal(normalizeTerminalSessionKey(undefined), null);
  assert.equal(normalizeTerminalSessionKey(42), null);
});

test('only a plain http(s) url may leave the app through the browser', () => {
  assert.equal(isSafeExternalUrl('https://example.com/docs#install'), true);
  assert.equal(isSafeExternalUrl('http://localhost:3000'), true);
  assert.equal(isSafeExternalUrl('https://sub.example.co.uk/a/b?c=d'), true);
  assert.equal(isSafeExternalUrl('file:///C:/Windows/system32/cmd.exe'), false);
  assert.equal(isSafeExternalUrl('powershell://Invoke-Command'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('mailto:someone@example.com'), false);
  assert.equal(isSafeExternalUrl('\\example.com\\share\\file.exe'), false);
  assert.equal(isSafeExternalUrl('https://user:pass@example.com'), false);
  assert.equal(isSafeExternalUrl('https://example.com/ space'), false);
  assert.equal(isSafeExternalUrl(' https://example.com'), false);
  assert.equal(isSafeExternalUrl(''), false);
  assert.equal(isSafeExternalUrl(null), false);
});
