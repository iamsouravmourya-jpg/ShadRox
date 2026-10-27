/**
 * Process-side hardening helpers for the desktop bridge.
 *
 * These live outside main.cjs on purpose: main.cjs is only loadable inside
 * Electron (requiring it boots the app), so every security predicate that the
 * bridge depends on is implemented here as a pure function and unit tested
 * head-lessly. See electron/desktop-security.test.cjs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Options Electron injects before the subcommand for every read-only git call.
 * `core.hooksPath` and `diff.external` are pinned to values that cannot name a
 * program, so a hostile `.git/config` has no executable left to point at, and
 * `--no-pager` plus `GIT_PAGER=cat` removes every pager/command path.
 */
function gitGlobalFlags(platform = process.platform) {
  return [
    '--no-pager',
    '--no-optional-locks',
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${nullDevice(platform)}`,
    '-c', 'diff.external='
  ];
}

/** Subcommands that honor diff/textconv drivers, i.e. can read a diff pipeline. */
const GIT_DIFF_AWARE_COMMANDS = new Set(['diff', 'log', 'show']);

/** Subcommands that convert working-tree files, i.e. honor `[filter]` drivers. */
const GIT_WORKTREE_COMMANDS = new Set(['status', 'diff']);

const POSIX_GIT_INSTALL_ROOTS = Object.freeze([
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  '/snap/bin/git'
]);
const WINDOWS_GIT_INSTALL_SUBPATH = Object.freeze(['Git', 'cmd', 'git.exe']);
const WINDOWS_PROGRAM_FILE_KEYS = Object.freeze([
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'LOCALAPPDATA',
  'USERPROFILE'
]);

function nullDevice(platform = process.platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

/**
 * True when `candidateUrl` is served from the app's own backend origin. The same
 * predicate guards navigation and IPC, so the two can never drift apart.
 */
function isSameOriginAsRenderer(candidateUrl, rendererOrigin) {
  if (typeof candidateUrl !== 'string' || typeof rendererOrigin !== 'string') return false;
  if (!candidateUrl || !rendererOrigin) return false;
  try {
    return new URL(candidateUrl).origin === new URL(rendererOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * The desktop bridge may only be driven by the main window's own top-level
 * document. Electron injects the preload script into every frame of a
 * webContents, and the preview iframes live inside this document, so comparing
 * `event.sender` alone would hand the whole bridge to workspace-authored code.
 * Anything else — child frames, frames that navigated away, foreign
 * webContents, popups — is rejected.
 */
function isTrustedRendererEvent(event, mainWindow, rendererOrigin) {
  if (!mainWindow || !event || event.sender !== mainWindow.webContents) return false;
  try {
    const frame = event.senderFrame;
    // A null frame means the frame navigated or was destroyed: fail closed.
    if (!frame || frame !== event.sender.mainFrame) return false;
    if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return false;
    return isSameOriginAsRenderer(frame.url, rendererOrigin);
  } catch {
    return false;
  }
}

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalizeForComparison(value, platform) {
  const normalized = pathApi(platform).normalize(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** True when `target` is `directory` itself or lives beneath it. */
function isPathInsideDirectory(directory, target, platform = process.platform) {
  if (typeof directory !== 'string' || typeof target !== 'string') return false;
  const native = pathApi(platform);
  const relative = native.relative(native.resolve(directory), native.resolve(target));
  return relative === '' ||
    (!native.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${native.sep}`));
}

function isDirectoryPath(candidate, existsSync, statSync) {
  try {
    if (!existsSync(candidate)) return false;
    return Boolean(statSync(candidate).isDirectory());
  } catch {
    return false;
  }
}

/**
 * Pulls the folder a second launch asked to open out of its argv. Only absolute
 * (or working-directory-resolved) existing directories count; switch-looking
 * arguments and the Electron binary itself are skipped.
 */
function extractFolderArgument(argv, {
  platform = process.platform,
  workingDirectory = process.cwd(),
  existsSync = (value) => fs.existsSync(value),
  statSync = (value) => fs.statSync(value),
  applicationDirectory = null
} = {}) {
  if (!Array.isArray(argv)) return null;
  for (const entry of argv.slice(1)) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    if (entry.startsWith('-')) continue;
    const candidate = path.isAbsolute(entry)
      ? entry
      : (platform === 'win32' && /^[a-z]:[\\/]/i.test(entry)
        ? entry
        : path.resolve(workingDirectory, entry));
    if (!isDirectoryPath(candidate, existsSync, statSync)) continue;
    if (applicationDirectory &&
        isPathInsideDirectory(applicationDirectory, candidate, platform)) continue;
    return candidate;
  }
  return null;
}

function readEnvValue(env, key) {
  if (!env) return undefined;
  if (typeof env[key] === 'string') return env[key];
  const wanted = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

function splitPathEntries(value, platform) {
  if (!value) return [];
  return value.split(platform === 'win32' ? ';' : ':').map((entry) => entry.trim()).filter(Boolean);
}

function isPlausibleGitFile(candidate, platform) {
  const native = pathApi(platform);
  if (typeof candidate !== 'string' || !candidate) return false;
  // Only absolute results are usable: a bare/relative name re-opens the
  // current-directory search that lets a planted git.exe win inside a folder.
  if (!native.isAbsolute(candidate)) return false;
  if (candidate.includes('\0')) return false;
  const base = native.basename(candidate).toLowerCase();
  if (platform === 'win32') return base === 'git.exe';
  return base === 'git';
}

function uniquePaths(values, platform) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = normalizeForComparison(value, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** Runs `where git` from a neutral directory using an absolute where.exe. */
function runWindowsWhereGit({ env, neutralCwd, timeout }) {
  const systemRoot = readEnvValue(env, 'SystemRoot') || readEnvValue(env, 'windir') || 'C:\\Windows';
  const whereExecutable = path.join(systemRoot, 'System32', 'where.exe');
  if (!fs.existsSync(whereExecutable)) return [];
  try {
    const stdout = execFileSync(whereExecutable, ['git'], {
      cwd: neutralCwd,
      env: { PATH: readEnvValue(env, 'PATH') || '', SystemRoot: systemRoot, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      timeout,
      windowsHide: true,
      maxBuffer: 256 * 1024
    });
    return String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolves `git` to one absolute executable once, at startup. A workspace can
 * never influence the result: the current-directory search is skipped (absolute
 * path), the probe runs from a neutral cwd, and every candidate is checked for
 * being absolute, named git, and outside the opened folder.
 *
 * Returns null when nothing trustworthy is found, and callers must then report
 * the feature as unavailable instead of falling back to a relative command.
 */
function resolveGitExecutable({
  platform = process.platform,
  env = process.env,
  existsSync = (value) => fs.existsSync(value),
  workspaceRoot = null,
  neutralCwd = platform === 'win32'
    ? (readEnvValue(env, 'SystemRoot') || 'C:\\Windows')
    : '/',
  runWhere = (options) => runWindowsWhereGit(options),
  timeout = 6000
} = {}) {
  const candidates = [];
  const native = pathApi(platform);
  const gitName = platform === 'win32' ? 'git.exe' : 'git';

  if (platform === 'win32') {
    for (const key of WINDOWS_PROGRAM_FILE_KEYS) {
      const root = readEnvValue(env, key);
      if (!root) continue;
      const suffix = key === 'LOCALAPPDATA' || key === 'USERPROFILE'
        ? [native.join(root, 'Programs', ...WINDOWS_GIT_INSTALL_SUBPATH), native.join(root, 'scoop', 'shims', gitName)]
        : [native.join(root, ...WINDOWS_GIT_INSTALL_SUBPATH)];
      candidates.push(...suffix);
    }
  } else {
    candidates.push(...POSIX_GIT_INSTALL_ROOTS);
  }

  for (const entry of splitPathEntries(readEnvValue(env, 'PATH'), platform)) {
    if (!native.isAbsolute(entry)) continue;
    candidates.push(native.join(entry, gitName));
  }

  if (platform === 'win32') candidates.push(...runWhere({ env, neutralCwd, timeout }));

  for (const candidate of uniquePaths(candidates, platform)) {
    if (!isPlausibleGitFile(candidate, platform)) continue;
    if (!existsSync(candidate)) continue;
    if (workspaceRoot && isPathInsideDirectory(workspaceRoot, candidate, platform)) continue;
    return candidate;
  }
  return null;
}

const GIT_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP',
  'PROGRAMDATA', 'ALLUSERSPROFILE', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ'
]);

/**
 * A minimal environment for git: no user config (global/system files are the null
 * device, HOME is parked outside the real profile), no prompts, no pager, and no
 * optional locks so a hostile repo cannot drive git into running helpers.
 */
function buildIsolatedGitEnv({
  platform = process.platform,
  env = process.env,
  neutralHome = os.tmpdir(),
  device = nullDevice(platform)
} = {}) {
  const result = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = readEnvValue(env, key);
    if (typeof value === 'string' && value.length > 0) result[key] = value;
  }
  if (platform === 'win32') {
    const systemRoot = readEnvValue(env, 'SystemRoot') || readEnvValue(env, 'windir');
    if (systemRoot && !readEnvValue(env, 'SYSTEMROOT')) result.SystemRoot = systemRoot;
    const windir = readEnvValue(env, 'windir') || systemRoot;
    if (windir && !readEnvValue(env, 'WINDIR')) result.windir = windir;
  }
  result.HOME = neutralHome;
  if (platform === 'win32') result.USERPROFILE = neutralHome;
  return Object.assign(result, {
    GIT_CONFIG_GLOBAL: device,
    GIT_CONFIG_SYSTEM: device,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    LESS: 'FRX',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ADVICE: '0'
  });
}

function unquoteConfigValue(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  let out = '';
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '\\' && index + 1 < trimmed.length) {
      const next = trimmed[index + 1];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      index += 1;
      continue;
    }
    if (char === '"') return out;
    out += char;
  }
  // Unterminated quote: the value could not be parsed reliably.
  return null;
}

function parseConfigHeader(line) {
  const match = /^\[\s*([^\s"\]]+)\s*(?:"((?:[^"\\]|\\.)*)"\s*)?\]\s*(?:[#;].*)?$/.exec(line);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    subsection: match[2] === undefined ? null : match[2].replace(/\\(["\\])/g, '$1')
  };
}

/**
 * Resolves a line to git's (section, subsection, key) triple. `[filter] x.clean`
 * is the same entry as `[filter "x"] clean`, and a quoted subsection is never
 * re-split on its dots.
 */
function effectiveConfigKey(header, rawKey) {
  const headParts = header.name.split('.');
  const section = headParts.shift();
  const remainder = [...headParts];
  const keyParts = rawKey.split('.');
  const key = keyParts.pop();
  remainder.push(...keyParts);
  const quoted = header.subsection;
  let subsection = null;
  if (quoted !== null) {
    subsection = remainder.length ? `${remainder.join('.')}.${quoted}` : quoted;
  } else if (remainder.length) {
    subsection = remainder.join('.');
  }
  return { section, subsection, key };
}

/**
 * Parses one git config file well enough to enumerate `[filter "<driver>"]`
 * definitions and `include`/`includeIf` targets. `ok: false` means the file held
 * something this parser could not read reliably, which callers must treat as
 * "unknown repo config" and refuse working-tree commands for.
 */
function parseGitConfig(text) {
  const lines = String(text).split(/\r?\n/);
  const driverNames = new Set();
  const includeTargets = [];
  const extensions = {};
  let header = null;
  let ok = true;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      const parsed = parseConfigHeader(line);
      if (!parsed || (line.includes('"') && !/["\]]\s*(?:[#;].*)?$/.test(line))) {
        ok = false;
        header = null;
        continue;
      }
      header = parsed;
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const rawKey = line.slice(0, separator).trim().toLowerCase();
    const value = unquoteConfigValue(line.slice(separator + 1));
    if (value === null) {
      ok = false;
      continue;
    }
    if (!header) continue;
    const { section, subsection, key } = effectiveConfigKey(header, rawKey);

    if (section === 'filter' && subsection) driverNames.add(subsection);
    else if (section === 'include' && key === 'path') includeTargets.push(value);
    else if (section === 'includeif' && key === 'path') {
      // Over-approximate: recurse into every includeIf target instead of
      // evaluating the pattern, so a conditional include cannot hide a driver.
      includeTargets.push(value);
    } else if (section === 'extensions' && key) extensions[key] = value;
  }

  return { filterDrivers: [...driverNames], includePaths: includeTargets, extensions, ok };
}

function isSafeFilterDriverName(name) {
  // A driver name is echoed into a `-c filter.<name>.clean=` key, so anything
  // that could re-shape that key (quotes, backslashes, separators, control
  // characters) makes the repo un-parseable for this bridge instead.
  return typeof name === 'string' && name.length > 0 && name.length <= 128 &&
    !/[\u0000-\u001f\u007f="\\/]/.test(name);
}

/**
 * Enumerates every filter driver the repository could hand to git, following its
 * own include chain. Filter commands are the one conversion path git honors from
 * repo-local config that no documented flag turns off, so each driver is
 * overridden per call with empty clean/smudge/process keys instead.
 *
 * Resolves to `{ drivers, complete }`; `complete: false` means the repo config
 * could not be fully read and working-tree commands must be skipped.
 */
async function collectRepoFilterDrivers(gitDir, {
  readFile = (file) => fs.promises.readFile(file, 'utf8'),
  fileExists = (file) => fs.existsSync(file),
  statSync = (file) => fs.statSync(file),
  maxFiles = 16,
  maxBytes = 512 * 1024,
  platform = process.platform
} = {}) {
  const drivers = new Set();
  const pending = [path.join(gitDir, 'config')];
  const visited = new Set();
  let files = 0;
  let complete = true;

  const push = (target) => {
    if (!target) return;
    const resolved = path.normalize(target);
    if (visited.has(normalizeForComparison(resolved, platform))) return;
    pending.push(resolved);
  };

  for (let index = 0; index < pending.length; index += 1) {
    const file = pending[index];
    if (visited.has(normalizeForComparison(file, platform))) continue;
    visited.add(normalizeForComparison(file, platform));
    if (!fileExists(file)) continue;
    if (files >= maxFiles) { complete = false; break; }
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      complete = false;
      continue;
    }
    if (size > maxBytes) { complete = false; continue; }
    let text;
    try {
      text = await readFile(file);
    } catch {
      complete = false;
      continue;
    }
    files += 1;
    const parsed = parseGitConfig(text);
    if (!parsed.ok) complete = false;
    for (const driver of parsed.filterDrivers) {
      if (isSafeFilterDriverName(driver)) drivers.add(driver);
      else complete = false;
    }
    for (const include of parsed.includePaths) {
      if (include.startsWith('~')) {
        // `~` is resolved against the real user profile, which this isolated
        // environment deliberately does not expose. Treat it as unknown.
        complete = false;
        continue;
      }
      push(path.isAbsolute(include) ? include : path.join(path.dirname(file), include));
    }
    if (file.endsWith(`${path.sep}config`) && parsed.extensions.worktreeconfig === 'true') {
      push(path.join(path.dirname(file), 'config.worktree'));
    }
  }

  return { drivers: [...drivers], complete };
}

/**
 * Full argv for one read-only git call: the global safety options, an override
 * that disarms every filter driver the repo declares, the diff-driver flags for
 * the subcommands that can consult them, and a `--` so nothing after the fixed
 * revision can be read as an option.
 */
function buildGitArgv(args, {
  filterDrivers = [],
  safeDirectories = [],
  platform = process.platform
} = {}) {
  const [command, ...rest] = args;
  const globalArgs = gitGlobalFlags(platform);
  for (const driver of filterDrivers) {
    if (!isSafeFilterDriverName(driver)) continue;
    globalArgs.push('-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`,
      '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`);
  }
  for (const directory of safeDirectories) {
    if (typeof directory !== 'string' || !directory) continue;
    globalArgs.push('-c', `safe.directory=${directory}`);
  }

  const subcommandArgs = [...rest];
  if (GIT_DIFF_AWARE_COMMANDS.has(command)) {
    subcommandArgs.unshift('--no-textconv', '--no-ext-diff');
  }
  if (GIT_WORKTREE_COMMANDS.has(command) && !subcommandArgs.includes('--')) {
    subcommandArgs.push('--');
  }
  return [...globalArgs, command, ...subcommandArgs];
}

module.exports = {
  buildGitArgv,
  buildIsolatedGitEnv,
  collectRepoFilterDrivers,
  extractFolderArgument,
  gitGlobalFlags,
  isPathInsideDirectory,
  isSameOriginAsRenderer,
  isTrustedRendererEvent,
  nullDevice,
  parseGitConfig,
  resolveGitExecutable
};
