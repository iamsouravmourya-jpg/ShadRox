const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveTerminalPlan, agentEnvironment, isCredentialVariable } = require('./terminal-modes.cjs');

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
