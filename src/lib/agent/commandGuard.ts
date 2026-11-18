/**
 * Ported from Cline (https://github.com/cline/cline), Apache-2.0 licensed.
 * Source: sdk/packages/core/src/extensions/tools/command-guard.ts
 *
 * Lightweight renderer-side notice for agent-requested shell runs. This is
 * NOT the execution gate: the main process parses every command with the
 * shared risk classifier (electron/command-risk.cjs) and decides the tier —
 * READ/BUILD_TEST/INSTALL run automatically, MUTATE/NETWORK open a native
 * approval dialog, DANGEROUS always asks. This module only produces the
 * human-readable heads-up ("what about this command can modify files") that
 * travels with the request as display text. It deliberately stays a small
 * self-contained blacklist so the renderer bundle never imports main-process
 * code, and so a notice can inform a decision but never replace one.
 *
 * The autonomous engine and the agent team ask the app to run proof commands
 * (`autonomyHost.runCommand` in App.tsx). Models — especially weaker ones —
 * use that channel to touch files the turn should never touch. The detected
 * reason comes from `commandApprovalNotice`, which every caller of
 * `desktop.runCommand` hands to the main process.
 *
 * This is a simple blacklist, not a shell interpreter. Commands are lightly
 * preprocessed (quoted text and heredoc bodies are masked so they cannot
 * false-positive; backslashes and `#` are NOT escapes/comments because
 * cmd.exe treats them literally), split on shell separators, and the leading
 * command word of each part is compared against the lists below; output
 * redirection to files is also flagged. It will not catch every possible
 * mutation (e.g. `python -c "open(..., 'w')"` or commands hidden inside a
 * quoted `bash -c` string) — the main-process tier gate fails closed on
 * anything it cannot parse, and entries here are easy to add.
 *
 * The port keeps Cline's lists and checks intact so upstream updates can be
 * diffed by eye; only the formatter wording was adapted to ShadRox's
 * risk-tiered approval flow.
 */

/** Commands that create, modify, or delete files. */
const BLOCKED_COMMANDS = new Set([
  // POSIX
  'rm',
  'rmdir',
  'unlink',
  'mv',
  'cp',
  'dd',
  'touch',
  'mkdir',
  'ln',
  'link',
  'chmod',
  'chown',
  'chgrp',
  'truncate',
  'shred',
  'install',
  'patch',
  'rsync',
  'mkfifo',
  'mknod',
  // Windows / PowerShell
  'del',
  'erase',
  'move',
  'ren',
  'rename',
  'md',
  'rd',
  'mklink',
  'copy',
  'xcopy',
  'robocopy',
  'new-item',
  'ni',
  'remove-item',
  'move-item',
  'copy-item',
  'rename-item',
  'set-content',
  'add-content',
  'clear-content',
  'out-file',
  // Unambiguous PowerShell aliases of the cmdlets above
  'mi',
  'ri',
  'cpi',
  'rni',
  'ac',
  'clc'
]);

/** Subcommands that mutate state, keyed by the command they belong to. */
const GIT_SUBCOMMANDS = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'init',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'submodule',
  'switch',
  'worktree'
]);
const NODE_PM_SUBCOMMANDS = new Set([
  'install',
  'i',
  'ci',
  'add',
  'remove',
  'rm',
  'uninstall',
  'unlink',
  'link',
  'update',
  'up',
  'upgrade',
  'dedupe',
  'prune',
  'publish'
]);
const PIP_SUBCOMMANDS = new Set(['install', 'uninstall', 'add', 'remove']);
const CARGO_SUBCOMMANDS = new Set([
  'add',
  'remove',
  'rm',
  'install',
  'uninstall',
  'update',
  'new',
  'init',
  'publish'
]);
const GEM_SUBCOMMANDS = new Set(['install', 'uninstall', 'update', 'cleanup']);
const COMPOSER_SUBCOMMANDS = new Set(['install', 'require', 'remove', 'update']);
const GO_SUBCOMMANDS = new Set(['install', 'get']);
const DOTNET_SUBCOMMANDS = new Set(['add', 'remove']);
const WINGET_SUBCOMMANDS = new Set(['install', 'uninstall', 'upgrade']);
const NUGET_SUBCOMMANDS = new Set(['install', 'update', 'delete', 'push']);
const SYSTEM_PM_SUBCOMMANDS = new Set([
  'install',
  'reinstall',
  'remove',
  'purge',
  'uninstall',
  'upgrade',
  'autoremove',
  'add',
  'del'
]);
const BLOCKED_SUBCOMMANDS: Record<string, Set<string>> = {
  git: GIT_SUBCOMMANDS,
  npm: NODE_PM_SUBCOMMANDS,
  pnpm: NODE_PM_SUBCOMMANDS,
  yarn: NODE_PM_SUBCOMMANDS,
  bun: NODE_PM_SUBCOMMANDS,
  pip: PIP_SUBCOMMANDS,
  pip3: PIP_SUBCOMMANDS,
  pipx: PIP_SUBCOMMANDS,
  uv: PIP_SUBCOMMANDS,
  cargo: CARGO_SUBCOMMANDS,
  apt: SYSTEM_PM_SUBCOMMANDS,
  'apt-get': SYSTEM_PM_SUBCOMMANDS,
  dnf: SYSTEM_PM_SUBCOMMANDS,
  yum: SYSTEM_PM_SUBCOMMANDS,
  apk: SYSTEM_PM_SUBCOMMANDS,
  brew: SYSTEM_PM_SUBCOMMANDS,
  snap: SYSTEM_PM_SUBCOMMANDS,
  gem: GEM_SUBCOMMANDS,
  composer: COMPOSER_SUBCOMMANDS,
  go: GO_SUBCOMMANDS,
  dotnet: DOTNET_SUBCOMMANDS,
  winget: WINGET_SUBCOMMANDS,
  nuget: NUGET_SUBCOMMANDS
};

/**
 * Read-only forms of otherwise-mutating git subcommands, keyed by
 * subcommand: `git stash list` inspects, `git stash` mutates.
 */
const READ_ONLY_GIT_FORMS: Record<string, Set<string>> = {
  stash: new Set(['list', 'show']),
  worktree: new Set(['list']),
  submodule: new Set(['status', 'summary'])
};

/** Prefix commands to skip over to reach the command that actually runs. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'builtin',
  'nohup',
  'time',
  'nice',
  'stdbuf',
  'timeout',
  'xargs'
]);

/** Shell reserved words that can precede the command word. */
const RESERVED_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'for',
  'case',
  'esac',
  '!',
  '{',
  '}'
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * Redirect targets that never persist data to a file: /dev sinks, Windows
 * NUL, and fd-duplication numbers (`2>&1`, `>&2`). Everything else flags —
 * including /tmp capture and unresolvable expansions ($TMPDIR, %TEMP%):
 * owner decisions 2026-11-18 treat any write outside the workspace root as
 * something the tier gate must ask about, and this notice says so.
 */
function isAllowedRedirectTarget(rawTarget: string): boolean {
  const target = rawTarget.replace(/["']/g, '');
  if (/^(\/dev\/(null|stdout|stderr|tty)|nul:?)$/i.test(target)) {
    return true;
  }
  // A bare number is a file descriptor, not a file name.
  return /^\d+$/.test(target);
}

/** Basename, lowercased, quotes and a trailing .exe stripped. */
function normalizeCommandName(word: string): string {
  const base = word.replace(/["']/g, '').split(/[/\\]/).pop() ?? word;
  return base.toLowerCase().replace(/\.exe$/, '');
}

/**
 * Mask the parts of a command string that are data rather than commands, so
 * the blacklist scan below cannot false-positive on them: heredoc bodies are
 * dropped, and special characters inside quotes are replaced with "_".
 *
 * Windows reality: cmd.exe treats backslash as a path character (not an
 * escape) and has no `#` comments, so neither is masked — `echo a \> b` and
 * `ls # > notes.txt` both carry a real redirect and must flag.
 */
function maskNonCommandText(command: string): string {
  // Drop heredoc bodies (everything between `<<DELIM` and the DELIM line).
  const lines = command.split('\n');
  const kept: string[] = [];
  let heredocDelimiter: string | undefined;
  for (const line of lines) {
    if (heredocDelimiter !== undefined) {
      if (line.replace(/^\t+/, '') === heredocDelimiter) {
        heredocDelimiter = undefined;
      }
      continue;
    }
    kept.push(line);
    const heredoc = line.match(
      /(?<![<])<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+))/
    );
    if (heredoc) {
      heredocDelimiter = heredoc[1] ?? heredoc[2] ?? heredoc[3];
    }
  }
  return (
    kept
      .join('\n')
      // Arithmetic expansion ($((3 > 2))) holds comparisons, not
      // commands or redirections.
      .replace(/\$\(\([\s\S]*?\)\)/g, '_')
      // Special characters inside quotes are literal text; spaces are
      // masked too so a quoted span stays a single token.
      .replace(/"[^"]*"|'[^']*'/g, (span) =>
        span.replace(/[\s<>|;&$()`#\\]/g, '_')
      )
  );
}

/** Check one command's tokens (command word + args) against the blacklist. */
function checkTokens(tokens: string[]): string | undefined {
  let index = 0;
  while (
    index < tokens.length &&
    (ENV_ASSIGNMENT.test(tokens[index]) || RESERVED_WORDS.has(tokens[index]))
  ) {
    index += 1;
  }
  // Skip wrappers (sudo, env, xargs, timeout 30, ...) and their options.
  while (
    index < tokens.length &&
    WRAPPERS.has(normalizeCommandName(tokens[index]))
  ) {
    index += 1;
    while (
      index < tokens.length &&
      (tokens[index].startsWith('-') ||
        tokens[index] === '{}' ||
        ENV_ASSIGNMENT.test(tokens[index]) ||
        /^\d+[smhd]?$/.test(tokens[index]))
    ) {
      index += 1;
    }
  }
  if (index >= tokens.length) {
    return undefined;
  }

  const name = normalizeCommandName(tokens[index]);
  const args = tokens.slice(index + 1);

  // `tee` writes every file argument; only /dev sinks and fd numbers are
  // harmless, so `tee /tmp/log` flags like any other out-of-workspace write.
  if (name === 'tee') {
    const fileArgs = args.filter((arg) => !arg.startsWith('-'));
    return fileArgs.some((arg) => !isAllowedRedirectTarget(arg))
      ? '`tee`'
      : undefined;
  }

  if (BLOCKED_COMMANDS.has(name)) {
    return `\`${name}\``;
  }

  const subcommands = BLOCKED_SUBCOMMANDS[name];
  if (subcommands) {
    // Help output never mutates (`git switch --help`).
    if (name === 'git' && args.some((arg) => arg === '--help' || arg === '-h')) {
      return undefined;
    }
    // First non-option arg is the subcommand; `git -c k=v` / `git -C dir`
    // take a value, so skip that too.
    let cursor = 0;
    while (cursor < args.length && args[cursor].startsWith('-')) {
      cursor += name === 'git' && /^-[cC]$/.test(args[cursor]) ? 2 : 1;
    }
    const subcommand = args[cursor]?.toLowerCase();
    if (subcommand && subcommands.has(subcommand)) {
      const next = args[cursor + 1]?.toLowerCase();
      if (
        name === 'git' &&
        next !== undefined &&
        READ_ONLY_GIT_FORMS[subcommand]?.has(next)
      ) {
        return undefined;
      }
      return `\`${name} ${subcommand}\``;
    }
    // Classic yarn with no subcommand runs an install.
    if (name === 'yarn' && args.length === 0) {
      return '`yarn` (install)';
    }
    return undefined;
  }

  // `python -m pip install ...` is pip; a bare interpreter (no script file,
  // e.g. a heredoc fed to stdin) is arbitrary execution the gate must ask for.
  if (/^python[\d.]*$/.test(name)) {
    const moduleIndex = args.indexOf('-m');
    const module =
      moduleIndex === -1 ? undefined : args[moduleIndex + 1]?.toLowerCase();
    if (module === 'pip' || module === 'pip3') {
      const subcommand = args
        .slice(moduleIndex + 2)
        .find((arg) => !arg.startsWith('-'))
        ?.toLowerCase();
      if (subcommand && PIP_SUBCOMMANDS.has(subcommand)) {
        return `\`pip ${subcommand}\``;
      }
    }
    const scriptArgs = args.filter(
      (arg) => !arg.startsWith('-') && !/[<>]/.test(arg)
    );
    if (scriptArgs.length === 0) {
      return `\`${name}\` (interactive interpreter)`;
    }
    return undefined;
  }

  // In-place edit flags on otherwise read-only text tools. The flag cluster
  // must end at the lowercase `i` (optionally followed by a `.suffix`), so
  // value-taking uppercase flags like `perl -Ilib` do not match.
  const IN_PLACE_FLAG = /^-[A-Za-z]*i(\..*)?$/;
  if (
    (name === 'sed' || name === 'gsed') &&
    args.some((arg) => IN_PLACE_FLAG.test(arg) || arg.startsWith('--in-place'))
  ) {
    return '`sed -i` (in-place edit)';
  }
  if (name === 'perl' && args.some((arg) => IN_PLACE_FLAG.test(arg))) {
    return '`perl -i` (in-place edit)';
  }
  if (/^[gnm]?awk$/.test(name)) {
    const usesInplace = args.some(
      (arg, argIndex) =>
        ((arg === '-i' || arg === '--include') &&
          args[argIndex + 1]?.startsWith('inplace')) ||
        (arg.startsWith('-i') && arg.slice(2).startsWith('inplace')) ||
        arg.startsWith('--include=inplace')
    );
    if (usesInplace) {
      return '`awk -i inplace` (in-place edit)';
    }
    return undefined;
  }
  if (
    name === 'sort' &&
    args.some((arg) => arg.startsWith('-o') || arg.startsWith('--output'))
  ) {
    return '`sort -o` (writes a file)';
  }
  if (name === 'curl') {
    const writesFile = args.some(
      (arg) =>
        (!arg.startsWith('--') && /^-[A-Za-z]*[oO]/.test(arg)) ||
        arg.startsWith('--output') ||
        arg.startsWith('--remote-name')
    );
    return writesFile ? '`curl -o` (writes a file)' : undefined;
  }
  if (name === 'wget') {
    const readOnly = args.some(
      (arg, argIndex) =>
        arg === '--spider' ||
        /^-[A-Za-z]*O-$/.test(arg) ||
        arg === '--output-document=-' ||
        (arg === '-O' && args[argIndex + 1] === '-')
    );
    return readOnly ? undefined : '`wget` (downloads files)';
  }
  if (name === 'find') {
    if (args.includes('-delete')) {
      return '`find -delete`';
    }
    for (let argIndex = 0; argIndex < args.length; argIndex += 1) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[argIndex])) {
        continue;
      }
      const tail: string[] = [];
      for (
        let cursor = argIndex + 1;
        cursor < args.length && args[cursor] !== ';' && args[cursor] !== '+';
        cursor += 1
      ) {
        tail.push(args[cursor]);
      }
      const nested = checkTokens(tail);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  return undefined;
}

/**
 * Inspect an agent-requested command and return a short description of the
 * first file-modifying construct found, or undefined when the command looks
 * read-only. Pure network activity (e.g. `git fetch`, `curl` without `-o`)
 * carries no file-modifying reason and stays unflagged here; the main-process
 * tier gate still requires approval for it.
 */
export function findFileEditingCommand(command: string): string | undefined {
  const masked = maskNonCommandText(command);

  // Output redirection to a file (`>`, `>>`, `&>`), allowing /dev sinks,
  // fd duplication (`2>&1`, `>&2`), and /tmp output capture.
  const redirects = masked.matchAll(
    /(?:^|[^<>])(?:>{1,2}|&>{1,2})\s*([^\s;&|<>()]+)/g
  );
  for (const redirect of redirects) {
    if (!isAllowedRedirectTarget(redirect[1])) {
      return `output redirection (\`> ${redirect[1]}\`)`;
    }
  }

  // Check the command word of every simple command in the string.
  for (const segment of masked.split(/[\n;|&()`]+/)) {
    const blocked = checkTokens(segment.trim().split(/\s+/).filter(Boolean));
    if (blocked) {
      return blocked;
    }
  }
  return undefined;
}

/**
 * Human notice shown with an agent-requested command that can modify files.
 * Names the offending construct and the command so the user can decide with
 * the real argv in front of them. The main process decides the tier and
 * whether a dialog opens; this text only explains what was detected.
 */
export function formatCommandRiskNotice(command: string, reason: string): string {
  return (
    `Heads-up: ${reason} can modify files. File-modifying commands from the assistant open an approval dialog before they run; ` +
    'this notice explains what was detected so the decision is an informed one. ' +
    `Review the exact command below — approving runs it once, and blocking runs nothing. \n\n` +
    `Command: ${command}`
  );
}

/**
 * What the approval dialog should say about this command, or undefined when
 * the blacklist has nothing file-modifying to flag.
 *
 * Callers hand the result to `terminal:run-command` as display text: main
 * applies its own risk-tier gate either way, so a notice can inform a decision
 * but never replace one — and a command nobody flagged is still subject to the
 * tier rules (MUTATE/NETWORK ask, DANGEROUS always asks).
 */
export function commandApprovalNotice(command: string): string | undefined {
  const reason = findFileEditingCommand(command);
  return reason ? formatCommandRiskNotice(command, reason) : undefined;
}