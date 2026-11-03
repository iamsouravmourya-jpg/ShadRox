/**
 * The two shells the terminal dock can run.
 *
 * `agent` mirrors the shell the assistant's one-shot commands run in. It gets a
 * credential-scrubbed environment: ShadRox keeps provider keys in the process
 * environment, and a shell driven by model-authored commands must not be able to
 * `echo` them. Nothing types into this pty on the user's behalf — the assistant
 * still goes through the confirmed one-shot handler, which uses the same
 * environment. `system` is the user's own shell — full environment, PowerShell on
 * Windows — because installing Node, git or a package manager is the one thing
 * the assistant's shell deliberately cannot do.
 */

/**
 * Credential names are matched per word rather than per whole variable, with
 * `_`, punctuation and camelCase transitions all treated as word breaks. The
 * old `(^|_)KEY(_|$)` shape missed `Geminiapikey` and `myAwsSecretKey`, so a
 * model-driven shell could still `echo` a key the user happened to name in
 * mixed case. Over-scrubbing costs the agent one missing variable; under-
 * scrubbing leaks a credential into a transcript.
 */
const CREDENTIAL_SUFFIXES = [
  'KEY', 'KEYS', 'TOKEN', 'TOKENS', 'SECRET', 'SECRETS',
  'PASSWORD', 'PASSWORDS', 'CREDENTIAL', 'CREDENTIALS'
];
const CREDENTIAL_WORDS = ['SESSION', 'AUTH'];

const ALWAYS_SCRUBBED = [
  'SHADROX_GEMINI_API_KEY',
  'SHADROX_GROQ_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY'
];

function splitVariableName(name) {
  return name
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split('_')
    .filter(Boolean)
    .map((word) => word.toUpperCase());
}

function isCredentialVariable(name) {
  if (typeof name !== 'string' || !name) return false;
  if (ALWAYS_SCRUBBED.includes(name.toUpperCase())) return true;
  return splitVariableName(name).some(
    (word) => CREDENTIAL_WORDS.includes(word) ||
      CREDENTIAL_SUFFIXES.some((suffix) => word.length > suffix.length ? word.endsWith(suffix) : word === suffix)
  );
}

function agentEnvironment(env) {
  const scrubbed = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (isCredentialVariable(name)) continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}

function resolveTerminalPlan({
  platform = process.platform,
  env = process.env,
  mode = 'system',
  existsSync = (candidate) => { try { return require('node:fs').existsSync(candidate); } catch { return false; } }
} = {}) {
  const normalized = mode === 'agent' ? 'agent' : 'system';

  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
    const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const shellPath = normalized === 'agent'
      ? (env.ComSpec || 'cmd.exe')
      : (existsSync(powershell) ? powershell : (env.ComSpec || 'cmd.exe'));
    return {
      mode: normalized,
      shellPath,
      shellArgs: /powershell/i.test(shellPath) ? ['-NoLogo'] : [],
      env: normalized === 'agent' ? agentEnvironment(env) : { ...env },
      label: /powershell/i.test(shellPath) ? 'PowerShell' : 'Command Prompt'
    };
  }

  const shellPath = normalized === 'agent' ? '/bin/sh' : (env.SHELL || '/bin/bash');
  return {
    mode: normalized,
    shellPath,
    shellArgs: [],
    env: normalized === 'agent' ? agentEnvironment(env) : { ...env },
    label: shellPath.split('/').pop() || shellPath
  };
}

const TERMINAL_SIZE_LIMITS = { minCols: 20, maxCols: 400, minRows: 5, maxRows: 200 };

/** node-pty rejects a zero or absurd size, so both create and resize share this. */
function clampTerminalSize(cols, rows) {
  const toFinite = (value, fallback) => {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    cols: Math.min(TERMINAL_SIZE_LIMITS.maxCols, Math.max(TERMINAL_SIZE_LIMITS.minCols, toFinite(cols, 100))),
    rows: Math.min(TERMINAL_SIZE_LIMITS.maxRows, Math.max(TERMINAL_SIZE_LIMITS.minRows, toFinite(rows, 30)))
  };
}

/**
 * The renderer names its own tabs, and that name becomes the pty map key, so it
 * has to be a plain token: anything else could collide with a UUID minted for a
 * legacy caller or smuggle path-ish bytes into logs.
 */
function normalizeTerminalSessionKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(key) ? key : null;
}

/**
 * Guard for links clicked inside the terminal. The renderer cannot open a browser
 * itself, and handing `shell.openExternal` an arbitrary string turns a log line
 * into an arbitrary program launch, so only a plain absolute http(s) URL passes.
 */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (/[\u0000-\u001f\u007f\s]/.test(url)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return Boolean(parsed.hostname);
}

module.exports = {
  resolveTerminalPlan,
  agentEnvironment,
  isCredentialVariable,
  clampTerminalSize,
  normalizeTerminalSessionKey,
  isSafeExternalUrl,
  TERMINAL_SIZE_LIMITS
};
