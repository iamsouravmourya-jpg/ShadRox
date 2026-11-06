/**
 * Default-deny allowlist for the autonomy run loop's verifyCommand silent
 * execution path (PLAN-BIGTASK phase 2, item 3a).
 *
 * The autonomous engine proves a milestone by running `milestone.verifyCommand`
 * through `AutonomyHost.runCommand` (src/lib/autonomy/ports.ts). Before this
 * gate, every read-only-looking command reached the main process and was run
 * there through `exec` — a full shell — unless Cline's blacklist
 * (src/lib/agent/commandGuard.ts) flagged it as file-modifying. A blacklist
 * over what a model can invent is never complete; this module replaces "no
 * silent exec unless blacklisted" with "no silent exec unless allowlisted".
 *
 * This is per-BINARY permission data, not per-action UI: the decision is a
 * pure string→verdict function with no dialogs, no state, and no child
 * processes. The renderer seam (autonomyHost.runCommand in App.tsx) asks the
 * main process, which re-validates here before any execFile — the allowlist
 * lives main-side so a compromised renderer cannot approve its own commands.
 *
 * Rules:
 *  - The command string is parsed into argv by whitespace splitting ONLY;
 *    there is no shell and no quoting layer. Anything containing shell
 *    metacharacters (`; & | ` $ ( ) < > \ ' " { } [ ] * ? ~ # !` and path
 *    separators) is rejected outright, so `git diff || curl evil` fails on
 *    the metacharacters before the argv match is even attempted.
 *  - argv[0] must be a bare allowlisted binary name (path separators are
 *    covered by the rejection above, so `./npm` and `C:\evil\git.exe` die).
 *  - The full argv must match one documented entry EXACTLY. No extra flags:
 *    `npm test --dry-run`, `pytest -c evil.ini`, `git status --help` and
 *    friends all miss the match. Adding a form means adding it here.
 *  - On Windows, CreateProcess searches the working directory before PATH,
 *    so a `npm.cmd` (or git.exe, tsc.cmd, ...) planted in the workspace root
 *    could shadow the real binary; `findPlantedShim` rejects that before
 *    execFile runs, falling back to the interactive approval path.
 */

'use strict';

/** Same ceiling the manual terminal handler enforces, so nothing huge sneaks in. */
const MAX_COMMAND_LENGTH = 5000;

/**
 * Characters that only make sense to a shell (or as paths). A whitelisted
 * verify command never needs one, so the whole string is rejected when any
 * appears — no escaping rules to keep in sync with a shell parser.
 */
const SHELL_METACHARACTERS = /[;&|`$()<>\\'"{}[\]*?~#!/]/;

/**
 * The documented silent-run entries, keyed by binary. Each value is the list
 * of EXACT argument tuples the binary may run with on the silent path.
 *   npm test · pytest · python -m pytest · tsc --noEmit ·
 *   npx tsc --noEmit · git diff · git status
 * Flags keep their canonical camelCase spelling because arguments are
 * compared case-sensitively; only argv[0] is lowercased.
 */
const VERIFY_ALLOWLIST = Object.freeze({
  npm: Object.freeze([Object.freeze(['test'])]),
  pytest: Object.freeze([Object.freeze([])]),
  python: Object.freeze([Object.freeze(['-m', 'pytest'])]),
  tsc: Object.freeze([Object.freeze(['--noEmit'])]),
  npx: Object.freeze([Object.freeze(['tsc', '--noEmit'])]),
  git: Object.freeze([Object.freeze(['diff']), Object.freeze(['status'])])
});

/**
 * On win32 these are batch shims (npm.cmd and friends), invisible to execFile
 * without the extension. git/python resolve to real .exe files and stay bare.
 */
const WINDOWS_CMD_SHIMS = new Set(['npm', 'npx', 'tsc', 'pytest']);

/** Extensions CreateProcess would let a planted workspace-root file win with. */
const WINDOWS_EXECUTABLE_SUFFIXES = ['', '.exe', '.cmd', '.bat', '.com'];

/** Human-readable summary of the whole table, for reject reasons. */
function describeAllowlist() {
  return Object.entries(VERIFY_ALLOWLIST)
    .flatMap(([binary, forms]) =>
      forms.map((args) => [binary, ...args].join(' '))
    )
    .join(', ');
}

/** `npm` + [['test']] -> "`npm test`" (also used inside reject reasons). */
function listForms(binary, forms) {
  if (forms.length === 0) return `  \`${binary}\``;
  return `  ${forms.map((args) => `\`${[binary, ...args].join(' ')}\``).join(', ')}`;
}

/**
 * Parse a verifyCommand string into an execFile argv, gated by the
 * default-deny allowlist above. Pure: no fs, no child_process, no shell.
 *
 * @param {unknown} command the raw milestone.verifyCommand string
 * @returns {{ allowed: true, argv: string[] } | { allowed: false, reason: string }}
 */
function parseVerifyCommand(command) {
  if (typeof command !== 'string') {
    return { allowed: false, reason: 'the verification command must be a string' };
  }
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'the verification command is empty' };
  }
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return {
      allowed: false,
      reason: `the verification command is longer than ${MAX_COMMAND_LENGTH} characters`
    };
  }
  // Reject control bytes other than the whitespace we split on (space, tab,
  // newline); a NUL or bell inside "npm test" is not a command, it is an attack.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) {
    return { allowed: false, reason: 'the verification command contains control characters' };
  }
  const metaMatch = trimmed.match(SHELL_METACHARACTERS);
  if (metaMatch) {
    return {
      allowed: false,
      reason: `the verification command may not contain shell metacharacters or path separators (found "${metaMatch[0]}")`
    };
  }

  const argv = trimmed.split(/\s+/);
  const binary = argv[0].toLowerCase();
  const rest = argv.slice(1);

  const forms = Object.prototype.hasOwnProperty.call(VERIFY_ALLOWLIST, binary)
    ? VERIFY_ALLOWLIST[binary]
    : undefined;
  if (!forms) {
    return {
      allowed: false,
      reason: `"${binary}" is not on the verify allowlist; silent entries: ${describeAllowlist()}`
    };
  }
  const exact = forms.some(
    (args) => args.length === rest.length && args.every((arg, index) => arg === rest[index])
  );
  if (!exact) {
    return {
      allowed: false,
      reason: `"${trimmed}" is not an allowlisted form of ${binary}; only:${listForms(binary, forms)}`
    };
  }
  return { allowed: true, argv: [binary, ...rest] };
}

/**
 * Map an allowlisted argv onto the binary names execFile can actually spawn
 * on this platform (Windows shims need their .cmd extension).
 *
 * @param {string[]} argv argv produced by a successful parseVerifyCommand
 * @param {NodeJS.Platform | string} platform process.platform
 * @returns {string[]} a fresh argv with argv[0] adjusted; never mutates input
 */
function resolveExecArgv(argv, platform) {
  if (platform !== 'win32') return argv.slice();
  if (!WINDOWS_CMD_SHIMS.has(argv[0])) return argv.slice();
  return [`${argv[0]}.cmd`, ...argv.slice(1)];
}

/**
 * Windows CreateProcess searches the working directory before PATH, so a
 * binary-shaped file planted in the workspace root shadows the real tool.
 * POSIX execFile only searches PATH, so there this always returns null.
 *
 * @param {string[]} argv argv produced by a successful parseVerifyCommand
 * @param {string} workspaceRoot the cwd execFile would run in
 * @param {(candidate: string) => boolean} existsSync injected for testability
 * @param {NodeJS.Platform | string} platform process.platform
 * @returns {string | null} the planted file path, or null when nothing is planted
 */
function findPlantedShim(argv, workspaceRoot, existsSync, platform) {
  if (platform !== 'win32') return null;
  const base = argv[0];
  for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
    const candidate = `${workspaceRoot}\\${base}${suffix}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

module.exports = {
  MAX_COMMAND_LENGTH,
  SHELL_METACHARACTERS,
  VERIFY_ALLOWLIST,
  WINDOWS_CMD_SHIMS,
  describeAllowlist,
  findPlantedShim,
  parseVerifyCommand,
  resolveExecArgv
};
