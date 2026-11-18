'use strict';

/**
 * Command risk classifier for agent-requested shell runs.
 *
 * Parsing core: `shell-quote` (MIT, https://github.com/substack/node-shell-quote),
 * used as a real tokenizer (quote states, control operators, globs, expansions)
 * rather than a regex blocklist. The Windows adaptation layer (cmd `^` escapes,
 * `%VAR%` / `!VAR!` expansion, literal backslash paths, `#` as a literal), the
 * segment builder, the path-scope analysis and the data-driven tier tables below
 * are ShadRox originals. No code was copied from zed (GPL).
 *
 * Contract (owner decisions 2026-11-18):
 *   - Compound commands are allowed; the command is parsed into segments
 *     (chains, pipes, redirects, substitutions) and each segment is classified.
 *   - Tiers: READ / BUILD_TEST / INSTALL auto-run; MUTATE / NETWORK need the
 *     native dialog; DANGEROUS always needs the dialog with a red warning and
 *     can never be pre-approved by any scope. The worst segment wins.
 *   - Unknown command = MUTATE (fail safe: never auto-run an unrecognized binary).
 *   - Writes outside the workspace root, destructive recursion outside the root
 *     (or at the root itself), download-piped-to-shell, sudo, encoded PowerShell
 *     and disk/format tooling are DANGEROUS.
 *
 * This module is pure (node:path + shell-quote only) so the renderer bundle can
 * import it too (commandGuard.ts delegates here).
 */

const path = require('node:path');
const shellQuote = require('shell-quote');

const TIERS = ['READ', 'BUILD_TEST', 'INSTALL', 'MUTATE', 'NETWORK', 'DANGEROUS'];
const TIER_RANK = Object.fromEntries(TIERS.map((tier, index) => [tier, index]));
const AUTO_TIERS = new Set(['READ', 'BUILD_TEST', 'INSTALL']);
const DIALOG_TIERS = new Set(['MUTATE', 'NETWORK', 'DANGEROUS']);

function worstTier(a, b) {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

const MAX_PARSE_DEPTH = 4;
const MAX_PARSE_LENGTH = 50_000;

/* ------------------------------------------------------------------ *
 * Rule tables (data, not one giant regex)
 * ------------------------------------------------------------------ */

/** Plain read-only binaries. */
const READ_COMMANDS = new Set([
  'ls', 'dir', 'vdir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'pwd', 'cd', 'chdir',
  'echo', 'printf', 'printenv', 'wc', 'stat', 'file', 'which', 'where', 'where.exe', 'whence',
  'tree', 'fd', 'fdfind', 'rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'findstr',
  'diff', 'cmp', 'fc', 'comm', 'sort', 'uniq', 'cut', 'tr', 'column', 'nl', 'od', 'xxd',
  'strings', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'hostname',
  'uname', 'uptime', 'ps', 'top', 'htop', 'jobs', 'history', 'man', 'help', 'info',
  'wc.exe', 'vol', 'ver', 'systeminfo', 'tasklist', 'query', 'doskey', 'cls', 'clear',
  'exit', 'title', 'prompt', 'color', 'true', 'false', 'test', '[', 'sleep',
  // PowerShell read cmdlets and their common aliases
  'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'gi', 'get-itemproperty',
  'get-location', 'gl', 'get-process', 'gps', 'get-service', 'gsv', 'get-command', 'gcm',
  'get-help', 'get-member', 'gm', 'get-date', 'get-random', 'get-unique', 'get-history',
  'select-string', 'sls', 'test-path', 'test-connection', 'measure-object', 'measure',
  'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'fw', 'format-custom',
  'out-string', 'out-host', 'out-null', 'write-output', 'write-host', 'write-verbose',
  'write-debug', 'write-information', 'resolve-path', 'rvpa', 'split-path', 'join-path',
  'compare-object', 'compare', 'select-object', 'select', 'where-object', 'where', '?',
  'sort-object', 'group-object', 'group', 'convertto-json', 'convertfrom-json',
  'convertto-csv', 'convertfrom-csv', 'convertto-xml', 'get-alias', 'gal',
  'get-variable', 'gv', 'get-psdrive', 'get-location', 'set-psdebug', 'trace-command'
]);

/** Commands that build or test the project; they may write build output inside the root. */
const BUILD_TEST_COMMANDS = new Set([
  'pytest', 'py.test', 'jest', 'vitest', 'mocha', 'ava', 'tap', 'tape', 'jasmine', 'karma',
  'phpunit', 'rspec', 'ctest', 'msbuild', 'xcodebuild', 'gradle', 'gradlew', 'mvn', 'mvnw',
  'make', 'gmake', 'cmake', 'ninja', 'meson', 'bazel', 'buck', 'just', 'task',
  'tsc', 'tsgo', 'esbuild', 'webpack', 'rollup', 'parcel', 'vite', 'swc', 'babel',
  'eslint', 'stylelint', 'tslint', 'biome', 'oxlint', 'ruff', 'flake8', 'pylint', 'mypy',
  'pyright', 'basedpyright', 'black', 'isort', 'clang-tidy', 'clang-format', 'rustfmt',
  'gofmt', 'dotnet', 'turbo', 'nx', 'lerna', 'rush', 'nx.exe',
  'go', 'cargo', 'zig', 'nim', 'crystal', 'mix', 'rebar3', 'dune', 'cabal', 'stack',
  'sbt', 'mill', 'lein', 'composer', 'bundle', 'rake', 'tox', 'nox', 'hatch', 'pdm'
]);

/** Package installation is explicitly AUTO (owner: install is not dangerous). */
const INSTALL_COMMANDS = new Set([
  'pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'mamba', 'gem', 'bundler',
  'apt', 'apt-get', 'dnf', 'yum', 'apk', 'brew', 'snap', 'pacman', 'zypper', 'emerge',
  'winget', 'nuget', 'choco', 'chocolatey', 'scoop', 'cargo-install', 'go-get'
]);

/** Destructive recursion candidates: analysed against the workspace root. */
const RM_COMMANDS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'del', 'erase', 'rd', 'remove-item', 'ri',
  'remove-itemproperty', 'clear-item', 'clear-content', 'clc'
]);

const COPY_COMMANDS = new Set(['cp', 'copy', 'xcopy', 'robocopy', 'copy-item', 'cpi']);
const MOVE_COMMANDS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);

const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'netcat', 'ncat', 'socat',
  'ping', 'nslookup', 'dig', 'host', 'traceroute', 'tracert', 'telnet', 'ftp', 'tftp',
  'http', 'https', 'aria2c', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
  'start-bitstransfer', 'bitsadmin', 'invoke-command', 'icm', 'enter-pssession',
  'new-pssession', 'send-mailmessage', 'test-netconnection', 'resolve-dnsname'
]);

/** Interpreters that execute whatever arrives on stdin — the `curl | sh` rule. */
const STDIN_INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh',
  'powershell', 'pwsh', 'cmd', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'lua'
]);

const DOWNLOADERS = new Set([
  'curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
  'start-bitstransfer', 'bitsadmin', 'ftp', 'tftp', 'http', 'https', 'aria2c'
]);

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'powershell', 'pwsh', 'cmd']);

/** Prefix wrappers that escalate to DANGEROUS regardless of what they wrap. */
const ELEVATION_WRAPPERS = new Set(['sudo', 'doas', 'runas', 'gsudo']);

/** Transparent prefixes: skip them (and their options) to reach the real command. */
const TRANSPARENT_WRAPPERS = new Set(['env', 'command', 'builtin', 'nohup', 'nice', 'stdbuf', 'timeout', 'xargs', 'time', 'ionice', 'chrt', 'setsid', 'unbuffer', 'script', 'watch']);

/** Shell reserved words: control structure, not a command word. */
const RESERVED_WORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'for', 'case', 'esac', 'select', 'in', '!', '{', '}', 'time', 'coproc']);

/** Keywords whose segment carries no command of its own. */
const NOOP_KEYWORDS = new Set(['then', 'else', 'fi', 'done', 'esac', '}', 'do', '{', '!', 'in', 'coproc']);

const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'annotate', 'rev-parse', 'rev-list', 'describe',
  'ls-files', 'ls-tree', 'cat-file', 'shortlog', 'reflog', 'grep', 'help',
  'version', 'count-objects', 'verify-commit', 'verify-tag', 'name-rev', 'merge-base',
  'cherry', 'whatchanged', 'range-diff', 'difftool', 'show-ref', 'for-each-ref', 'symbolic-ref'
]);
const GIT_MUTATE_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'init', 'merge',
  'mv', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'worktree',
  'submodule', 'tag', 'branch', 'remote', 'config', 'bisect', 'rerere', 'gc', 'prune',
  'repack', 'replace', 'update-ref', 'update-index', 'read-tree', 'write-tree', 'hash-object',
  'commit-tree', 'mktree', 'fast-import', 'filter-branch', 'notes', 'attributes'
]);
const GIT_NETWORK_SUBCOMMANDS = new Set(['push', 'pull', 'fetch', 'clone', 'send-email', 'request-pull', 'archive']);
/** Read-only forms of otherwise-mutating git subcommands. */
const GIT_READ_FORMS = {
  stash: new Set(['list', 'show']),
  worktree: new Set(['list']),
  submodule: new Set(['status', 'summary']),
  branch: new Set(['--list', '-l', '--show-current', '-a', '-r', '--all', '--remotes', '-v', '-vv']),
  tag: new Set(['--list', '-l', '-n', '--contains', '--points-at']),
  remote: new Set(['show', '-v', 'get-url', '--verbose']),
  config: new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch']),
  reflog: new Set(['show', 'exists']),
  bisect: new Set(['log', 'visualize', 'view'])
};
/** git subcommands that touch the network AND are worth a file-risk reason. */
const GIT_NETWORK_WITH_REASON = new Set(['push', 'pull', 'clone']);

const NODE_PM_INSTALL_SUBS = new Set(['install', 'i', 'add', 'ci', 'update', 'up', 'upgrade', 'dedupe', 'prune', 'link', 'unlink', 'rebuild']);
const NODE_PM_BUILD_SUBS = new Set(['run', 'run-script', 'test', 't', 'build', 'start', 'dev', 'serve', 'lint', 'typecheck', 'exec', 'create', 'init', 'watch']);
const NODE_PM_READ_SUBS = new Set(['ls', 'list', 'la', 'll', 'root', 'bin', 'prefix', 'config', 'get', 'explain', 'why', 'doctor', 'help', 'version']);
const NODE_PM_NETWORK_SUBS = new Set(['view', 'info', 'show', 'v', 'search', 'find', 'audit', 'ping', 'publish', 'unpublish', 'deprecate', 'star', 'stars', 'outdated', 'fund', 'bugs', 'docs', 'repo', 'access', 'owner', 'team', 'token', 'profile']);
const NODE_PM_MUTATE_SUBS = new Set(['remove', 'rm', 'uninstall', 'un', 'unlink', 'cache', 'set', 'edit', 'hook', 'completion']);

const PIP_INSTALL_SUBS = new Set(['install', 'add']);
const PIP_READ_SUBS = new Set(['show', 'list', 'freeze', 'check', 'inspect', 'config', 'debug', 'help', 'index']);
const PIP_NETWORK_SUBS = new Set(['download', 'search', 'upload']);
const PIP_MUTATE_SUBS = new Set(['uninstall', 'remove', 'cache', 'wheel']);

const CARGO_BUILD_SUBS = new Set(['build', 'b', 'test', 't', 'check', 'c', 'clippy', 'bench', 'run', 'r', 'doc', 'rustc', 'rustdoc', 'fix', 'report']);
const CARGO_READ_SUBS = new Set(['tree', 'metadata', 'verify-project', 'locate-project', 'read-manifest', 'pkgid', 'help', 'version', 'config']);
const CARGO_INSTALL_SUBS = new Set(['install', 'add', 'update', 'fetch']);
const CARGO_MUTATE_SUBS = new Set(['remove', 'rm', 'uninstall', 'clean', 'new', 'init', 'fmt', 'generate-lockfile', 'yank', 'owner', 'login', 'logout']);
const CARGO_NETWORK_SUBS = new Set(['publish', 'search', 'login', 'logout', 'owner', 'yank']);

const GO_BUILD_SUBS = new Set(['build', 'test', 'vet', 'run', 'generate', 'work', 'tool']);
const GO_READ_SUBS = new Set(['version', 'env', 'list', 'doc', 'help', 'bug', 'mod']);
const GO_INSTALL_SUBS = new Set(['get', 'install']);
const GO_MUTATE_SUBS = new Set(['fmt', 'clean', 'fix', 'mod', 'work']);

/** In-place edit flags on otherwise read-only text tools. */
const IN_PLACE_FLAG = /^-[A-Za-z]*i(\..*)?$/;

/** Null sinks and fd duplications never persist data. */
const NULL_SINK = /^(nul:?:?|\/dev\/(null|stdout|stderr|tty|fd\/[012]))$/i;
const DEVICE_PATH = /^(\/dev\/(?!null$|stdout$|stderr$|tty$|fd\/)|\\\\\.\\|\/proc\/|\/sys\/)/i;

/** Write redirect operators (vs input / heredoc / fd-dup). */
const WRITE_OPS = new Set(['>', '>>', '&>', '&>>', '>|', '<>']);
const DUP_OPS = new Set(['>&', '<&']);
const INPUT_OPS = new Set(['<', '<<', '<<<', '<(']);
const REDIRECT_OPS = new Set([...WRITE_OPS, ...DUP_OPS, ...INPUT_OPS, '>(']);
const CHAIN_OPS = new Set(['&&', '||', ';', ';&', ';;', ';;&', '&', '|', '|&', '\n']);

/** PowerShell encoded-command flags (aliases of -EncodedCommand). */
const PS_ENCODED_FLAGS = /^-(enc|ec|encodedcommand|encodedcomman|encodedcomma|encodedcomm|encodedcom|encodedco|encodedc|encoded)$/i;
const PS_COMMAND_FLAGS = new Set(['-command', '-c', '-cmd']);
const PS_FILE_FLAGS = new Set(['-file', '-f']);

/** Dev-server-style long runners: background jobs with a readiness probe. */
const DEV_SERVER_PM_HEADS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const DEV_SERVER_PM_SUBS = new Set(['dev', 'start', 'serve', 'develop', 'preview', 'watch']);
const DEV_SERVER_ALWAYS_HEADS = new Set(['vite', 'uvicorn', 'gunicorn', 'hypercorn', 'daphne', 'puma', 'unicorn', 'webpack-dev-server', 'parcel']);
const DEV_SERVER_SUB_HEADS = new Set(['next', 'nuxt', 'webpack', 'react-scripts', 'ng', 'vue-cli-service', 'astro', 'remix', 'gatsby', 'wrangler', 'vercel', 'netlify', 'flask', 'rails', 'php', 'dotnet', 'cargo', 'deno']);
const DEV_SERVER_SUBS = new Set(['dev', 'start', 'serve', 'server', 's', 'watch', 'run', 'develop']);
const DEV_SERVER_SCRIPT_PATTERNS = {
  python: /(http\.server|manage\.py|server|app|dev|serve)/i,
  python3: /(http\.server|manage\.py|server|app|dev|serve)/i,
  // `node index.js` / `node main.js` are ordinary scripts; only server-shaped
  // names earn the immediate-background treatment.
  node: /(server|dev|serve|start|watch)/i,
  ruby: /(server|dev|serve)/i
};
const READINESS_LOG_PATTERN = /(ready in|ready started|started server|listening (?:on|at)|available on|running at|compiled successfully|watching for file changes|local:\s*https?:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)/i;
const READY_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s'"<>]*/i;

/* ------------------------------------------------------------------ *
 * Tokenizer: shell-quote core + Windows adaptation layer
 * ------------------------------------------------------------------ */

const PLACEHOLDER = /\u0002(\d+)\u0003/g;

function pathModule(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Mask heredoc bodies so their text can never be read as commands or redirects.
 * Line-based, quote-aware enough for the `<<DELIM` / `<<-DELIM` / `<<'DELIM'` forms.
 */
function maskHeredocs(command) {
  const lines = command.split('\n');
  const kept = [];
  let delimiter;
  for (const line of lines) {
    if (delimiter !== undefined) {
      if (line.replace(/^\t+/, '').trim() === delimiter) delimiter = undefined;
      kept.push('');
      continue;
    }
    kept.push(line);
    const heredoc = line.match(/(?<![<])<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+))/);
    if (heredoc) delimiter = heredoc[1] ?? heredoc[2] ?? heredoc[3];
  }
  return kept.join('\n');
}

/** Replace balanced `$((...))` arithmetic spans with opaque placeholders. */
function maskArithmetic(command, protections) {
  let out = '';
  let i = 0;
  while (i < command.length) {
    if (command.startsWith('$((', i)) {
      let depth = 2;
      let j = i + 3;
      while (j < command.length && depth > 0) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') depth -= 1;
        j += 1;
      }
      if (depth === 0) {
        out += `\u0002${protections.length}\u0003`;
        protections.push({ kind: 'arithmetic', text: command.slice(i, j) });
        i = j;
        continue;
      }
    }
    out += command[i];
    i += 1;
  }
  return out;
}

/** Extract balanced `$(...)` / backtick spans as nested commands (quote-aware). */
function extractSubstitutions(command, protections, platform) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < command.length) {
    const c = command[i];
    if (quote) {
      // Substitution still happens inside double quotes; single quotes are literal.
      if (c === quote && command[i - 1] !== '\\') quote = null;
      if (quote === "'" || (c !== '$' && c !== '`')) {
        out += c;
        i += 1;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '$' && command[i + 1] === '(' && !command.startsWith('$((', i)) {
      let depth = 1;
      let j = i + 2;
      let innerQuote = null;
      while (j < command.length && depth > 0) {
        const d = command[j];
        if (innerQuote) {
          if (d === innerQuote) innerQuote = null;
        } else if (d === "'" || d === '"') innerQuote = d;
        else if (d === '(') depth += 1;
        else if (d === ')') depth -= 1;
        j += 1;
      }
      if (depth === 0) {
        out += `\u0002${protections.length}\u0003`;
        protections.push({ kind: 'substitution', text: command.slice(i + 2, j - 1) });
        i = j;
        continue;
      }
    }
    if (c === '`' && platform !== 'win32') {
      const end = command.indexOf('`', i + 1);
      if (end > i) {
        out += `\u0002${protections.length}\u0003`;
        protections.push({ kind: 'substitution', text: command.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** cmd.exe `^X` escapes and `%VAR%` / `!VAR!` expansion, protected before parsing. */
function protectWindowsSyntax(command, protections) {
  let out = '';
  let i = 0;
  let quote = null;
  const protect = (kind, text) => {
    out += `\u0002${protections.length}\u0003`;
    protections.push({ kind, text });
  };
  while (i < command.length) {
    const c = command[i];
    if (c === "'" || c === '"') {
      if (quote === c) quote = null;
      else if (!quote) quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (!quote && c === '^' && i + 1 < command.length) {
      protect('literal', command[i + 1]);
      i += 2;
      continue;
    }
    if (c === '%') {
      const named = command.slice(i).match(/^%[A-Za-z_][A-Za-z0-9_]*%/);
      const batch = command.slice(i).match(/^%~[a-zA-Z0-9]+|^%[0-9*]/);
      if (named) { protect('expansion', named[0]); i += named[0].length; continue; }
      if (batch) { protect('expansion', batch[0]); i += batch[0].length; continue; }
    }
    if (!quote && c === '!') {
      const delayed = command.slice(i).match(/^![A-Za-z_][A-Za-z0-9_]*!/);
      if (delayed) { protect('expansion', delayed[0]); i += delayed[0].length; continue; }
    }
    if (c === '#') {
      // cmd.exe has no `#` comment; keep it a literal so `ls # > f` still shows the write.
      protect('literal', '#');
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Turn unquoted newlines into `;` separators (quote-aware). */
function newlinesToSeparators(command) {
  let out = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote && command[i - 1] !== '\\') quote = null;
      out += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === '\n') {
      out += ' ; ';
    } else {
      out += c;
    }
  }
  return out;
}

/** Restore protected spans into parsed entries. */
function restoreProtections(entries, protections) {
  const restored = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      if (entry && entry.op === 'glob' && PLACEHOLDER.test(entry.pattern)) {
        PLACEHOLDER.lastIndex = 0;
        restored.push({ op: 'glob', pattern: entry.pattern.replace(PLACEHOLDER, (m, n) => protections[Number(n)]?.text ?? '') });
        continue;
      }
      if (entry && entry.comment !== undefined) { restored.push(entry); continue; }
      restored.push(entry);
      continue;
    }
    PLACEHOLDER.lastIndex = 0;
    const whole = entry.match(/^\u0002(\d+)\u0003$/);
    if (whole) {
      const protection = protections[Number(whole[1])];
      if (!protection) { restored.push(entry); continue; }
      if (protection.kind === 'literal') restored.push(protection.text);
      else if (protection.kind === 'expansion') restored.push({ op: 'var', name: protection.text });
      else if (protection.kind === 'substitution') restored.push({ op: 'sub', inner: protection.text });
      else restored.push({ op: 'opaque', text: protection.text });
      continue;
    }
    if (!entry.includes('\u0002')) { restored.push(entry); continue; }
    let mixed = '';
    let opaque = false;
    let sub = null;
    let cursor = 0;
    PLACEHOLDER.lastIndex = 0;
    let match;
    while ((match = PLACEHOLDER.exec(entry)) !== null) {
      mixed += entry.slice(cursor, match.index);
      const protection = protections[Number(match[1])];
      cursor = match.index + match[0].length;
      if (!protection) continue;
      mixed += protection.text;
      if (protection.kind !== 'literal') opaque = true;
      if (protection.kind === 'substitution') sub = protection.text;
    }
    mixed += entry.slice(cursor);
    restored.push(opaque ? { op: 'opaque', text: mixed, sub } : mixed);
  }
  return restored;
}

/**
 * Tokenize one command line into shell-quote entries with Windows reality kept
 * intact: backslash paths, drive letters, quoted spaces, cmd escapes, expansions.
 */
function tokenizeShell(command, platform) {
  const protections = [];
  let text = String(command).replace(/\r\n?/g, '\n');
  text = maskHeredocs(text);
  text = maskArithmetic(text, protections);
  text = extractSubstitutions(text, protections, platform);
  if (platform === 'win32') text = protectWindowsSyntax(text, protections);
  text = newlinesToSeparators(text);
  const entries = shellQuote.parse(
    text,
    (name) => ({ op: 'var', name: name ? `$${name}` : '$' }),
    platform === 'win32' ? { escape: '\u0000' } : {}
  );
  return restoreProtections(entries, protections);
}

/* ------------------------------------------------------------------ *
 * Segment builder
 * ------------------------------------------------------------------ */

function isMarker(entry) {
  return Boolean(entry) && typeof entry === 'object' && typeof entry.op === 'string'
    && ['var', 'opaque', 'glob', 'sub'].includes(entry.op);
}

function markerText(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  if (entry.glob !== undefined) return entry.glob;
  if (entry.op === 'glob') return entry.pattern;
  if (entry.op === 'var') return entry.name;
  if (entry.op === 'opaque') return entry.text;
  if (entry.op === 'sub') return `$(${entry.inner})`;
  return '';
}

/** Group parsed entries into simple-command segments with redirects and pipes. */
function buildSegments(entries) {
  const segments = [];
  let current = { argv: [], redirects: [], subs: [], connector: null, pipeFrom: null };
  const push = () => {
    if (current.argv.length > 0 || current.redirects.length > 0 || current.subs.length > 0) {
      segments.push(current);
    }
    current = { argv: [], redirects: [], subs: [], connector: null, pipeFrom: null };
  };
  let functionDefinition = false;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (typeof entry === 'string') {
      // `name() { ... }` — a function definition (the fork-bomb shape) is dangerous.
      const next = entries[i + 1];
      const after = entries[i + 2];
      if (next && next.op === '(' && after && after.op === ')') {
        functionDefinition = true;
      }
      current.argv.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.op === 'sub') {
      current.subs.push(entry.inner);
      continue;
    }
    if (entry.op === 'glob') {
      current.argv.push({ glob: entry.pattern });
      continue;
    }
    if (entry.op === 'var' || entry.op === 'opaque') {
      current.argv.push(entry);
      continue;
    }
    if (typeof entry.op !== 'string') continue;
    const op = entry.op;
    if (CHAIN_OPS.has(op)) {
      push();
      continue;
    }
    if (op === '(' || op === ')') {
      push();
      continue;
    }
    if (REDIRECT_OPS.has(op)) {
      const target = entries[i + 1];
      if (target !== undefined && (typeof target === 'string' || isMarker(target))) {
        i += 1;
        current.redirects.push({ op, target });
      } else {
        current.redirects.push({ op, target: null });
      }
      continue;
    }
    // Unknown operator shape: keep it visible as an opaque argument (fail safe later).
    current.argv.push({ op: 'opaque', text: op });
  }
  push();

  // Attach connector / pipeFrom metadata by re-scanning entries in lockstep with
  // the segment list (both were produced in the same order).
  let segCursor = 0;
  let expectNew = true;
  let lastConnector = null;
  let lastWasPipe = false;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry && typeof entry === 'object' && typeof entry.op === 'string' && (CHAIN_OPS.has(entry.op) || entry.op === '(' || entry.op === ')')) {
      lastConnector = entry.op;
      lastWasPipe = entry.op === '|' || entry.op === '|&';
      expectNew = true;
      continue;
    }
    if (expectNew && segCursor < segments.length) {
      const seg = segments[segCursor];
      seg.connector = lastConnector;
      seg.pipeFrom = lastWasPipe && segCursor > 0 ? segCursor - 1 : null;
      segCursor += 1;
      expectNew = false;
      lastWasPipe = false;
    }
  }
  return { segments, functionDefinition };
}

/* ------------------------------------------------------------------ *
 * Path scope analysis
 * ------------------------------------------------------------------ */

function normalizeCommandName(word) {
  const text = typeof word === 'string' ? word : markerText(word);
  const base = text.split(/[/\\]/).pop() ?? text;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '').replace(/^["']|["']$/g, '');
}

/**
 * Resolve a redirect/destructive target against the (virtual) cwd and classify
 * its scope. Without a known root (renderer-side notice), absolute paths are
 * conservatively outside and relative paths assumed inside.
 */
function resolveTargetScope(raw, ctx) {
  if (raw === null || raw === undefined) return { kind: 'unknown', display: '(missing)' };
  if (typeof raw === 'object') {
    if (raw.glob !== undefined) {
      const pattern = raw.glob;
      const mod = pathModule(ctx.platform);
      if (mod.isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || pattern.split(/[/\\]/).includes('..')) {
        return { kind: 'outside', display: pattern };
      }
      return { kind: 'glob', display: pattern, rootLevel: !/[/\\]/.test(pattern) };
    }
    return { kind: 'unknown', display: markerText(raw) };
  }
  const display = String(raw).trim();
  if (!display) return { kind: 'unknown', display };
  if (NULL_SINK.test(display)) return { kind: 'sink', display };
  if (/^\d+$/.test(display) || display === '-') return { kind: 'fd', display };
  if (DEVICE_PATH.test(display)) return { kind: 'device', display };
  if (display.startsWith('~')) return { kind: 'outside', display };
  const mod = pathModule(ctx.platform);
  const driveLetter = /^[a-z]:[/\\]/i.test(display) || /^[a-z]:$/i.test(display);
  const absolute = mod.isAbsolute(display) || (ctx.platform === 'win32' && driveLetter);
  if (!ctx.cwd) {
    return absolute ? { kind: 'outside', display } : { kind: 'inside', display, assumed: true };
  }
  const resolved = absolute ? mod.resolve(display) : mod.resolve(ctx.cwd, display);
  if (!ctx.root) return { kind: 'outside', display, resolved };
  const rootKey = ctx.platform === 'win32' ? ctx.root.toLowerCase() : ctx.root;
  const resolvedKey = ctx.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const sep = mod.sep;
  const inside = resolvedKey === rootKey || resolvedKey.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep);
  return { kind: inside ? 'inside' : 'outside', display, resolved };
}

function isRootItself(scope, ctx) {
  if (scope.kind === 'glob') return scope.rootLevel;
  if (!scope.resolved || !ctx.root) return false;
  const mod = pathModule(ctx.platform);
  const a = ctx.platform === 'win32' ? scope.resolved.toLowerCase() : scope.resolved;
  const b = ctx.platform === 'win32' ? ctx.root.toLowerCase() : ctx.root;
  return a === b || a === mod.resolve(b);
}

/* ------------------------------------------------------------------ *
 * Segment classification
 * ------------------------------------------------------------------ */

/** Multi-character cmd.exe switches worth recognizing; anything else starting
 * with `/` is a POSIX path (/etc, /tmp), not a switch. */
const CMD_SWITCH_WORDS = new Set([
  'mir', 'copyall', 'dcopy', 'fat', 'fft', 'xo', 'xn', 'xf', 'xl', 'is', 'it', 'im',
  'np', 'nfl', 'ndl', 'njh', 'njs', 'eta', 'sl', 'dl', 'ts', 'fp', 'bytes', 'purge',
  'tee', 'log', 'unilog', 'unicode', 'move', 'create', 'delete', 'query', 'add',
  'regsvr32', 'silent', 'force', 'recurse', 'confirm', 'whatif', 'passive', 'quiet'
]);

function flagSet(argv) {
  const short = new Set();
  const long = new Set();
  const positional = [];
  for (const arg of argv) {
    if (typeof arg !== 'string') { positional.push(arg); continue; }
    if (arg === '--') continue;
    if (arg.startsWith('--')) long.add(arg.toLowerCase());
    else if (arg.startsWith('-') && arg.length > 1) {
      for (const c of arg.slice(1)) short.add(c);
      long.add(arg.toLowerCase());
    } else if (/^\/[a-z]$/i.test(arg) || (arg.length > 2 && arg.startsWith('/') && CMD_SWITCH_WORDS.has(arg.slice(1).toLowerCase()))) {
      // cmd-style switches (/s /q /f /mir) — never POSIX paths like /etc.
      for (const c of arg.slice(1).toLowerCase()) short.add(c);
    } else positional.push(arg);
  }
  return { short, long, positional };
}

function hasFlag(flags, ...names) {
  return names.some((name) => (name.length === 1 ? flags.short.has(name) : flags.long.has(name)));
}

/** Classify a write target: returns tier contribution + reason/danger strings. */
function classifyWriteTarget(raw, ctx, opLabel, result) {
  const scope = resolveTargetScope(raw, ctx);
  if (scope.kind === 'sink' || scope.kind === 'fd') return;
  if (scope.kind === 'outside' || scope.kind === 'device' || scope.kind === 'unknown') {
    result.tier = worstTier(result.tier, 'DANGEROUS');
    result.dangerous.push(`writes outside the workspace root (\`${opLabel} ${scope.display}\`)`);
    result.outOfRoot.push(scope.display);
    result.reasons.push(`output redirection (\`${opLabel} ${scope.display}\`)`);
    return;
  }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`output redirection (\`${opLabel} ${scope.display}\`)`);
}

function applyRedirects(segment, ctx, result) {
  for (const redirect of segment.redirects) {
    const { op, target } = redirect;
    if (INPUT_OPS.has(op)) continue;
    if (DUP_OPS.has(op)) {
      const text = markerText(target);
      if (/^\d+$/.test(text) || text === '-' || text === '') continue;
      classifyWriteTarget(target, ctx, op, result);
      continue;
    }
    if (op === '>(') continue;
    if (target === null) {
      result.tier = worstTier(result.tier, 'MUTATE');
      result.reasons.push('redirect with a missing target (unparseable)');
      continue;
    }
    classifyWriteTarget(target, ctx, op, result);
  }
}

/** rm-family: recursive+force aimed outside the root (or at it) is DANGEROUS. */
function classifyRemoval(name, argv, ctx, result) {
  const flags = flagSet(argv);
  const recursive = hasFlag(flags, 'r', 'R', '--recursive') || flags.long.has('-recurse');
  const force = hasFlag(flags, 'f', '--force') || flags.long.has('-force');
  const winRecursive = flags.short.has('s');
  const winForce = flags.short.has('q');
  const destructiveRecursion = (recursive && force) || (winRecursive && winForce)
    || (flags.long.has('-recurse') && flags.long.has('-force'));
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`${name}\``);
  const targets = flags.positional;
  if (targets.length === 0) return;
  for (const target of targets) {
    const scope = resolveTargetScope(target, ctx);
    if (scope.kind === 'sink' || scope.kind === 'fd') continue;
    if (destructiveRecursion) {
      // A root-level glob that can cover everything (`*`, `*.*`) is root destruction;
      // a narrower glob (`*.log`) stays inside the root.
      const coversRoot = scope.kind === 'glob' && /^(\.\/)?(\*|\*\.\*|\*\*\/?\*?)$/.test(scope.display);
      if (scope.kind === 'outside' || scope.kind === 'device' || scope.kind === 'unknown' || coversRoot || isRootItself(scope, ctx)) {
        result.tier = worstTier(result.tier, 'DANGEROUS');
        result.dangerous.push(`recursive forced delete at or outside the workspace root (\`${name} ${scope.display}\`)`);
        if (scope.kind === 'outside' || scope.kind === 'device') result.outOfRoot.push(scope.display);
        continue;
      }
    }
    if (scope.kind === 'outside' || scope.kind === 'device') {
      result.tier = worstTier(result.tier, 'DANGEROUS');
      result.dangerous.push(`delete outside the workspace root (\`${name} ${scope.display}\`)`);
      result.outOfRoot.push(scope.display);
    }
  }
}

/** cp/mv family: copies outside root stay MUTATE (owner), moves/deletes escalate. */
function classifyTransfer(name, argv, ctx, result, destructive) {
  const flags = flagSet(argv);
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`${name}\``);
  for (const target of flags.positional) {
    const scope = resolveTargetScope(target, ctx);
    if (scope.kind === 'outside' || scope.kind === 'device') {
      result.outOfRoot.push(scope.display);
      if (destructive) {
        result.tier = worstTier(result.tier, 'DANGEROUS');
        result.dangerous.push(`move/delete outside the workspace root (\`${name} ${scope.display}\`)`);
      }
    } else if (scope.kind === 'unknown' && destructive) {
      result.tier = worstTier(result.tier, 'DANGEROUS');
      result.dangerous.push(`move of an unresolved target (\`${name} ${scope.display}\`)`);
    }
  }
}

function subcommandOf(argv, valueFlags = []) {
  let cursor = 0;
  while (cursor < argv.length) {
    const arg = argv[cursor];
    if (typeof arg !== 'string') return { sub: null, rest: argv.slice(cursor) };
    if (arg.startsWith('-')) {
      cursor += valueFlags.includes(arg) ? 2 : 1;
      continue;
    }
    return { sub: arg.toLowerCase(), rest: argv.slice(cursor + 1), index: cursor };
  }
  return { sub: null, rest: [] };
}

function classifyGit(argv, ctx, result) {
  const { sub, rest } = subcommandOf(argv, ['-c', '-C', '--git-dir', '--work-tree', '--namespace']);
  if (!sub) { result.tier = worstTier(result.tier, 'READ'); return; }
  if (rest.includes('--help') || rest.includes('-h') || sub === 'help') {
    result.tier = worstTier(result.tier, 'READ');
    return;
  }
  if (GIT_READ_SUBCOMMANDS.has(sub)) {
    // `git diff --output patch.txt` writes a file.
    const outputIndex = rest.findIndex((arg) => arg === '--output' || String(arg).startsWith('--output='));
    if (outputIndex >= 0) {
      const target = rest[outputIndex].includes('=') ? rest[outputIndex].split('=').slice(1).join('=') : rest[outputIndex + 1];
      classifyWriteTarget(target ?? null, ctx, '--output', result);
    }
    result.tier = worstTier(result.tier, 'READ');
    return;
  }
  if (GIT_NETWORK_SUBCOMMANDS.has(sub)) {
    result.tier = worstTier(result.tier, 'NETWORK');
    if (GIT_NETWORK_WITH_REASON.has(sub)) result.reasons.push(`\`git ${sub}\``);
    if (sub === 'clone') {
      // clone writes a new working tree; a destination outside the root is an outside write.
      for (const arg of rest) {
        if (typeof arg === 'string' && !arg.startsWith('-') && !/^(https?|git|ssh|git@)/i.test(arg) && !arg.includes('://')) {
          const scope = resolveTargetScope(arg, ctx);
          if (scope.kind === 'outside' || scope.kind === 'unknown') {
            result.tier = worstTier(result.tier, 'DANGEROUS');
            result.dangerous.push(`clone destination outside the workspace root (\`${scope.display}\`)`);
            result.outOfRoot.push(scope.display);
          }
        }
      }
    }
    return;
  }
  if (GIT_MUTATE_SUBCOMMANDS.has(sub)) {
    const readForms = GIT_READ_FORMS[sub];
    const hasReadForm = readForms && rest.some((arg) => typeof arg === 'string' && readForms.has(arg.toLowerCase()));
    const bareListForm = rest.length === 0 && (sub === 'branch' || sub === 'tag' || sub === 'remote' || sub === 'config');
    if (hasReadForm || bareListForm) {
      result.tier = worstTier(result.tier, 'READ');
      return;
    }
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`git ${sub}\``);
    return;
  }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`git ${sub}\` (unrecognized subcommand)`);
}

function classifyNodePm(name, argv, ctx, result) {
  const { sub, rest } = subcommandOf(argv);
  if (!sub) {
    // `yarn --version` inspects; classic yarn with no subcommand runs an install.
    const infoOnly = argv.some((arg) => arg === '--version' || arg === '-v' || arg === '--help' || arg === '-h');
    if (name === 'yarn' && !infoOnly) {
      result.tier = worstTier(result.tier, 'INSTALL');
      result.reasons.push('`yarn` (install)');
    } else {
      result.tier = worstTier(result.tier, 'READ');
    }
    return;
  }
  if (NODE_PM_BUILD_SUBS.has(sub)) {
    result.tier = worstTier(result.tier, 'BUILD_TEST');
    if (sub === 'exec' || sub === 'create' || sub === 'init') {
      // `npm exec <cmd>` / `npx <cmd>` run another binary: classify it with its flags.
      const first = rest.findIndex((arg) => typeof arg === 'string' && !arg.startsWith('-') && arg !== '--');
      if (first >= 0) classifyArgv(rest.slice(first), ctx, result, 0);
      else { result.tier = worstTier(result.tier, 'MUTATE'); result.reasons.push(`\`${name} ${sub}\``); }
    }
    return;
  }
  if (NODE_PM_INSTALL_SUBS.has(sub)) {
    result.tier = worstTier(result.tier, 'INSTALL');
    result.reasons.push(`\`${name} ${sub}\``);
    return;
  }
  if (NODE_PM_NETWORK_SUBS.has(sub)) {
    result.tier = worstTier(result.tier, sub === 'publish' || sub === 'unpublish' ? 'NETWORK' : 'NETWORK');
    if (sub === 'publish' || sub === 'unpublish' || sub === 'deprecate') result.reasons.push(`\`${name} ${sub}\``);
    return;
  }
  if (NODE_PM_READ_SUBS.has(sub)) {
    if (sub === 'config' || sub === 'get') {
      const action = rest.find((arg) => typeof arg === 'string' && !arg.startsWith('-'));
      if (action && ['set', 'delete', 'rm', 'edit'].includes(action.toLowerCase())) {
        result.tier = worstTier(result.tier, 'MUTATE');
        result.reasons.push(`\`${name} config ${action}\``);
        return;
      }
    }
    result.tier = worstTier(result.tier, 'READ');
    return;
  }
  if (NODE_PM_MUTATE_SUBS.has(sub)) {
    if (sub === 'cache') {
      const action = rest.find((arg) => typeof arg === 'string');
      if (action && ['clean', 'clear', 'rm', 'verify'].includes(action.toLowerCase()) && action.toLowerCase() !== 'verify') {
        result.tier = worstTier(result.tier, 'MUTATE');
        result.reasons.push(`\`${name} cache ${action}\``);
        return;
      }
      result.tier = worstTier(result.tier, 'READ');
      return;
    }
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`${name} ${sub}\``);
    return;
  }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`${name} ${sub}\` (unrecognized subcommand)`);
}

function classifyPip(name, argv, ctx, result) {
  const { sub, rest } = subcommandOf(argv);
  if (!sub) { result.tier = worstTier(result.tier, 'MUTATE'); result.reasons.push(`\`${name}\``); return; }
  if (PIP_INSTALL_SUBS.has(sub)) {
    result.tier = worstTier(result.tier, 'INSTALL');
    result.reasons.push(`\`pip ${sub}\``);
    return;
  }
  if (PIP_READ_SUBS.has(sub)) { result.tier = worstTier(result.tier, 'READ'); return; }
  if (PIP_NETWORK_SUBS.has(sub)) { result.tier = worstTier(result.tier, 'NETWORK'); return; }
  if (PIP_MUTATE_SUBS.has(sub)) {
    if (sub === 'cache') {
      const action = rest.find((arg) => typeof arg === 'string');
      if (action && ['purge', 'remove', 'clean'].includes(action.toLowerCase())) {
        result.tier = worstTier(result.tier, 'MUTATE');
        result.reasons.push('`pip cache purge`');
        return;
      }
      result.tier = worstTier(result.tier, 'READ');
      return;
    }
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`pip ${sub}\``);
    return;
  }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`pip ${sub}\` (unrecognized subcommand)`);
}

function classifyPython(name, argv, ctx, result) {
  const flags = flagSet(argv);
  if (hasFlag(flags, '--version', '-V')) { result.tier = worstTier(result.tier, 'READ'); return; }
  const moduleIndex = argv.findIndex((arg) => arg === '-m');
  if (moduleIndex >= 0) {
    const module = argv[moduleIndex + 1];
    const moduleRest = argv.slice(moduleIndex + 2);
    if (typeof module === 'string') {
      const mod = module.toLowerCase();
      if (mod === 'pip' || mod === 'pip3') { classifyPip('pip', moduleRest, ctx, result); return; }
      if (mod === 'pytest' || mod === 'unittest' || mod === 'tox' || mod === 'nox') { result.tier = worstTier(result.tier, 'BUILD_TEST'); return; }
      if (mod === 'http.server' || mod === 'smtpd' || mod === 'webbrowser') { result.tier = worstTier(result.tier, 'NETWORK'); return; }
      if (mod === 'venv' || mod === 'virtualenv') { result.tier = worstTier(result.tier, 'MUTATE'); result.reasons.push(`\`${name} -m ${mod}\``); return; }
      if (mod === 'pip.__main__') { classifyPip('pip', moduleRest, ctx, result); return; }
    }
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`${name} -m\` (module execution)`);
    return;
  }
  if (hasFlag(flags, '-c')) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`${name} -c\` (arbitrary code)`);
    return;
  }
  if (flags.positional.length === 0 && argv.length === 0) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`${name}\` (interactive interpreter)`);
    return;
  }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`${name}\` (script execution)`);
}

function classifyNode(argv, ctx, result) {
  const flags = flagSet(argv);
  if (hasFlag(flags, '--version', '-v') && argv.length === 1) { result.tier = worstTier(result.tier, 'READ'); return; }
  if (argv.includes('--test') || argv.some((arg) => typeof arg === 'string' && arg.startsWith('--test'))) {
    result.tier = worstTier(result.tier, 'BUILD_TEST');
    return;
  }
  if (hasFlag(flags, '-e', '--eval', '-p', '--print')) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push('`node -e` (arbitrary code)');
    return;
  }
  if (argv.length === 0) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push('`node` (interactive interpreter)');
    return;
  }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push('`node` (script execution)');
}

function classifyShellInterpreter(name, argv, ctx, result, depth) {
  // cmd /c <line>, bash -c <line>, powershell -Command <line> — unwrap and classify.
  let inner = null;
  if (name === 'cmd') {
    const index = argv.findIndex((arg) => typeof arg === 'string' && /^\/(c|k)$/i.test(arg));
    if (index >= 0) inner = argv.slice(index + 1).map(markerText).join(' ');
  } else if (name === 'powershell' || name === 'pwsh') {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (typeof arg !== 'string') continue;
      if (PS_ENCODED_FLAGS.test(arg) || /^-(enc|ec)/i.test(arg) && PS_ENCODED_FLAGS.test(arg.split(':')[0])) {
        result.tier = worstTier(result.tier, 'DANGEROUS');
        result.dangerous.push('encoded PowerShell command (-EncodedCommand hides the real payload)');
        result.reasons.push(`\`${name} -EncodedCommand\``);
        return;
      }
      if (PS_COMMAND_FLAGS.has(arg.toLowerCase())) {
        inner = argv.slice(i + 1).map(markerText).join(' ');
        break;
      }
      if (PS_FILE_FLAGS.has(arg.toLowerCase())) {
        result.tier = worstTier(result.tier, 'MUTATE');
        result.reasons.push(`\`${name} -File\` (script execution)`);
        return;
      }
    }
  } else {
    const index = argv.findIndex((arg) => arg === '-c');
    if (index >= 0) inner = argv.slice(index + 1).map(markerText).join(' ');
  }
  if (inner !== null) {
    const trimmed = inner.trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1');
    if (!trimmed) {
      result.tier = worstTier(result.tier, 'MUTATE');
      result.reasons.push(`\`${name}\` (empty shell string)`);
      return;
    }
    const nested = classifyCommand(trimmed, { cwd: ctx.cwd, root: ctx.root, platform: ctx.platform, depth: depth + 1 });
    mergeResult(result, nested);
    return;
  }
  // A script file argument, or an interactive shell: arbitrary execution.
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`${name}\` (shell execution)`);
}

function classifyCurl(argv, ctx, result) {
  result.tier = worstTier(result.tier, 'NETWORK');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    const writes = (!arg.startsWith('--') && /^-[A-Za-z]*[oO]/.test(arg) && !/^-[A-Za-z]*O-?$/.test(arg))
      || arg.startsWith('--output') || arg === '--remote-name' || arg === '-O';
    if (!writes) continue;
    let target = null;
    if (arg.includes('=')) target = arg.split('=').slice(1).join('=');
    else if (/^-[A-Za-z]*o$/.test(arg) || arg === '--output') target = argv[i + 1] ?? null;
    else if (arg === '-O' || arg === '--remote-name') {
      // Remote name lands in the cwd: inside by construction.
      result.tier = worstTier(result.tier, 'MUTATE');
      result.reasons.push('`curl -o` (writes a file)');
      continue;
    }
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push('`curl -o` (writes a file)');
    if (target !== null) classifyWriteTarget(target, ctx, '-o', result);
    return;
  }
}

function classifyWget(argv, ctx, result) {
  result.tier = worstTier(result.tier, 'NETWORK');
  const readOnly = argv.some((arg, index) =>
    arg === '--spider'
    || /^-[A-Za-z]*O-$/.test(String(arg))
    || arg === '--output-document=-'
    || (arg === '-O' && argv[index + 1] === '-'));
  if (readOnly) return;
  result.reasons.push('`wget` (downloads files)');
  const outputIndex = argv.findIndex((arg) => arg === '-O' || arg === '--output-document' || String(arg).startsWith('--output-document='));
  if (outputIndex >= 0) {
    const arg = argv[outputIndex];
    const target = String(arg).includes('=') ? String(arg).split('=').slice(1).join('=') : argv[outputIndex + 1];
    if (target && target !== '-') classifyWriteTarget(target, ctx, '-O', result);
  } else {
    // Default: writes the downloaded file into the cwd.
    result.tier = worstTier(result.tier, 'MUTATE');
  }
}

function classifyFind(argv, ctx, result, depth) {
  if (argv.includes('-delete')) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push('`find -delete`');
    return;
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(argv[i])) continue;
    const tail = [];
    for (let cursor = i + 1; cursor < argv.length && argv[cursor] !== ';' && argv[cursor] !== '+'; cursor += 1) {
      tail.push(argv[cursor]);
    }
    if (tail.length > 0) classifyArgv(tail, ctx, result, depth);
    return;
  }
  result.tier = worstTier(result.tier, 'READ');
}

function classifyInPlaceEditors(name, argv, ctx, result) {
  if ((name === 'sed' || name === 'gsed') && argv.some((arg) => typeof arg === 'string' && (IN_PLACE_FLAG.test(arg) || arg.startsWith('--in-place')))) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push('`sed -i` (in-place edit)');
    return true;
  }
  if (name === 'perl' && argv.some((arg) => typeof arg === 'string' && IN_PLACE_FLAG.test(arg))) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push('`perl -i` (in-place edit)');
    return true;
  }
  if (/^[gnm]?awk$/.test(name)) {
    const usesInplace = argv.some((arg, index) =>
      typeof arg === 'string' && (
        ((arg === '-i' || arg === '--include') && String(argv[index + 1] ?? '').startsWith('inplace'))
        || (arg.startsWith('-i') && arg.slice(2).startsWith('inplace'))
        || arg.startsWith('--include=inplace')));
    if (usesInplace) {
      result.tier = worstTier(result.tier, 'MUTATE');
      result.reasons.push('`awk -i inplace` (in-place edit)');
      return true;
    }
    return false;
  }
  return false;
}

function classifyPermissionChange(name, argv, ctx, result) {
  const flags = flagSet(argv);
  const recursive = hasFlag(flags, 'R', '-R', '--recursive') || flags.long.has('-recurse');
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`${name}\``);
  if (!recursive) return;
  for (const target of flags.positional) {
    const scope = resolveTargetScope(target, ctx);
    if (scope.kind === 'outside' || scope.kind === 'device' || scope.kind === 'unknown' || isRootItself(scope, ctx)) {
      result.tier = worstTier(result.tier, 'DANGEROUS');
      result.dangerous.push(`recursive ${name} at or outside the workspace root (\`${name} ${scope.display}\`)`);
      if (scope.kind === 'outside') result.outOfRoot.push(scope.display);
    }
  }
}

function classifyDd(argv, ctx, result) {
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push('`dd`');
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('of=')) continue;
    classifyWriteTarget(arg.slice(3), ctx, 'of=', result);
  }
}

function classifyTee(argv, ctx, result) {
  const files = argv.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
  if (files.length === 0) { result.tier = worstTier(result.tier, 'READ'); return; }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push('`tee`');
  for (const file of files) classifyWriteTarget(file, ctx, 'tee', result);
}

function classifyTar(argv, ctx, result) {
  const flags = flagSet(argv);
  const extracting = hasFlag(flags, 'x', '--extract', '--get') || argv.some((arg) => typeof arg === 'string' && /^[a-z]*x[a-z]*$/i.test(arg) && arg.startsWith('-'));
  const creating = hasFlag(flags, 'c', '--create');
  if (extracting || creating) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`tar\` (${extracting ? 'extracts' : 'writes'} files)`);
    const dirIndex = argv.findIndex((arg) => arg === '-C' || arg === '--directory');
    if (dirIndex >= 0) classifyWriteTarget(argv[dirIndex + 1] ?? null, ctx, '-C', result);
    return;
  }
  result.tier = worstTier(result.tier, 'READ');
}

function classifyTextTool(name, argv, ctx, result) {
  // Build/test linters that can write with --fix / --write.
  const writes = argv.some((arg) => typeof arg === 'string' && (
    arg === '--fix' || arg === '--write' || arg === '-w' || arg.startsWith('--fix=') || arg === '--in-place'
  ));
  if (writes && ['eslint', 'stylelint', 'prettier', 'ruff', 'black', 'isort', 'tslint', 'biome', 'oxlint', 'clang-format', 'rustfmt', 'gofmt'].includes(name)) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`${name} --fix\` (writes files)`);
    return;
  }
  if (name === 'sort' && argv.some((arg) => typeof arg === 'string' && (arg.startsWith('-o') || arg.startsWith('--output')))) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push('`sort -o` (writes a file)');
    const index = argv.findIndex((arg) => typeof arg === 'string' && (arg.startsWith('-o') || arg.startsWith('--output')));
    const arg = argv[index];
    const target = arg.includes('=') ? arg.split('=').slice(1).join('=') : (arg === '-o' || arg === '--output' ? argv[index + 1] : arg.slice(2));
    if (target) classifyWriteTarget(target, ctx, '-o', result);
    return;
  }
  if (name === 'sort') {
    result.tier = worstTier(result.tier, 'READ');
    return;
  }
  if (name === 'tsc' || name === 'tsgo') {
    for (const flag of ['--outFile', '--outDir']) {
      const index = argv.findIndex((arg) => typeof arg === 'string' && (arg === flag || arg.startsWith(`${flag}=`)));
      if (index >= 0) {
        const arg = argv[index];
        const target = arg.includes('=') ? arg.split('=').slice(1).join('=') : argv[index + 1];
        if (target) classifyWriteTarget(target, ctx, flag, result);
      }
    }
    if (argv.includes('--noEmit')) { result.tier = worstTier(result.tier, 'READ'); return; }
    result.tier = worstTier(result.tier, 'BUILD_TEST');
    return;
  }
  if (name === 'prettier' && argv.some((arg) => arg === '--check' || arg === '--list-different')) {
    result.tier = worstTier(result.tier, 'BUILD_TEST');
    return;
  }
  result.tier = worstTier(result.tier, 'BUILD_TEST');
}

function classifyCargo(argv, ctx, result) {
  const { sub, rest } = subcommandOf(argv);
  if (!sub) { result.tier = worstTier(result.tier, 'READ'); return; }
  if (CARGO_BUILD_SUBS.has(sub)) {
    if (sub === 'fix') { result.tier = worstTier(result.tier, 'MUTATE'); result.reasons.push('`cargo fix` (writes files)'); return; }
    result.tier = worstTier(result.tier, 'BUILD_TEST');
    return;
  }
  if (CARGO_READ_SUBS.has(sub)) { result.tier = worstTier(result.tier, 'READ'); return; }
  if (CARGO_INSTALL_SUBS.has(sub)) {
    result.tier = worstTier(result.tier, 'INSTALL');
    result.reasons.push(`\`cargo ${sub}\``);
    return;
  }
  if (CARGO_NETWORK_SUBS.has(sub)) {
    result.tier = worstTier(result.tier, 'NETWORK');
    if (sub === 'publish') result.reasons.push('`cargo publish`');
    return;
  }
  if (CARGO_MUTATE_SUBS.has(sub)) {
    if (sub === 'fmt' && rest.includes('--check')) { result.tier = worstTier(result.tier, 'BUILD_TEST'); return; }
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`cargo ${sub}\``);
    return;
  }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`cargo ${sub}\` (unrecognized subcommand)`);
}

function classifyGo(argv, ctx, result) {
  const { sub, rest } = subcommandOf(argv);
  if (!sub) { result.tier = worstTier(result.tier, 'READ'); return; }
  if (GO_BUILD_SUBS.has(sub)) {
    if (sub === 'generate') { result.tier = worstTier(result.tier, 'MUTATE'); result.reasons.push('`go generate`'); return; }
    if (sub === 'mod' || sub === 'work') {
      const action = rest.find((arg) => typeof arg === 'string');
      if (action && ['download', 'tidy', 'vendor', 'edit', 'init', 'sync', 'use'].includes(action)) {
        result.tier = worstTier(result.tier, action === 'download' ? 'INSTALL' : 'MUTATE');
        result.reasons.push(`\`go ${sub} ${action}\``);
        return;
      }
      result.tier = worstTier(result.tier, 'READ');
      return;
    }
    result.tier = worstTier(result.tier, 'BUILD_TEST');
    return;
  }
  if (GO_READ_SUBS.has(sub)) {
    if (sub === 'mod') { result.tier = worstTier(result.tier, 'READ'); return; }
    result.tier = worstTier(result.tier, 'READ');
    return;
  }
  if (GO_INSTALL_SUBS.has(sub)) { result.tier = worstTier(result.tier, 'INSTALL'); result.reasons.push(`\`go ${sub}\``); return; }
  if (GO_MUTATE_SUBS.has(sub)) { result.tier = worstTier(result.tier, 'MUTATE'); result.reasons.push(`\`go ${sub}\``); return; }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`go ${sub}\` (unrecognized subcommand)`);
}

function classifySystemPm(name, argv, ctx, result) {
  const { sub, rest } = subcommandOf(argv);
  if ((name === 'bundle' || name === 'bundler') && !sub) {
    result.tier = worstTier(result.tier, 'INSTALL');
    result.reasons.push('`bundle install`');
    return;
  }
  if (name === 'uv' && sub === 'pip') { classifyPip('pip', rest, ctx, result); return; }
  if (!sub) { result.tier = worstTier(result.tier, 'READ'); return; }
  if (['install', 'reinstall', 'add', 'upgrade', 'update', 'sync', 'require', 'get'].includes(sub)) {
    result.tier = worstTier(result.tier, 'INSTALL');
    result.reasons.push(`\`${name} ${sub}\``);
    return;
  }
  if (['remove', 'purge', 'uninstall', 'autoremove', 'del', 'delete', 'erase', 'clean', 'cleanup'].includes(sub)) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`${name} ${sub}\``);
    return;
  }
  if (['search', 'info', 'show', 'list', 'status', 'check', 'audit', 'why', 'deps'].includes(sub)) {
    result.tier = worstTier(result.tier, sub === 'search' || sub === 'audit' ? 'NETWORK' : 'READ');
    return;
  }
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`${name} ${sub}\``);
}

/** Dispatch table: head name → handler(argv, ctx, result, depth). Unlisted heads fail safe to MUTATE. */
const HEAD_HANDLERS = {
  git: classifyGit,
  node: classifyNode, nodejs: classifyNode, deno: classifyNode,
  cargo: classifyCargo, go: classifyGo,
  curl: classifyCurl, wget: classifyWget,
  find: classifyFind,
  fd: (argv, ctx, result) => { result.tier = worstTier(result.tier, 'READ'); },
  tee: classifyTee, 'tee-object': classifyTee,
  tar: classifyTar, dd: classifyDd,
  npx: (argv, ctx, result) => classifyNodePm('npm', ['exec', ...argv], ctx, result),
  reg: (argv, ctx, result) => {
    const { sub } = subcommandOf(argv);
    if (sub === 'query') { result.tier = worstTier(result.tier, 'READ'); return; }
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`reg ${sub ?? ''}\``.trim());
  }
};
for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
  HEAD_HANDLERS[name] = (argv, ctx, result) => classifyNodePm(name, argv, ctx, result);
}
for (const name of ['pip', 'pip3', 'pipx']) {
  HEAD_HANDLERS[name] = (argv, ctx, result) => classifyPip(name, argv, ctx, result);
}
for (const name of ['python', 'python3', 'py']) {
  HEAD_HANDLERS[name] = (argv, ctx, result) => classifyPython(name, argv, ctx, result);
}
for (const name of ['sed', 'gsed', 'awk', 'gawk', 'mawk', 'nawk']) {
  HEAD_HANDLERS[name] = (argv, ctx, result) => { classifyInPlaceEditors(name, argv, ctx, result); };
}
// perl without -i still executes arbitrary code: never read-only.
HEAD_HANDLERS.perl = (argv, ctx, result) => {
  if (!classifyInPlaceEditors('perl', argv, ctx, result)) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push('`perl` (script execution)');
  }
};
for (const name of ['chmod', 'chown', 'chgrp']) {
  HEAD_HANDLERS[name] = (argv, ctx, result) => classifyPermissionChange(name, argv, ctx, result);
}
for (const name of ['sort', 'tsc', 'tsgo', 'eslint', 'stylelint', 'prettier', 'ruff', 'black', 'isort', 'biome']) {
  HEAD_HANDLERS[name] = (argv, ctx, result) => classifyTextTool(name, argv, ctx, result);
}
for (const name of ['apt', 'apt-get', 'dnf', 'yum', 'apk', 'brew', 'snap', 'pacman', 'zypper', 'emerge', 'winget', 'nuget', 'choco', 'scoop', 'gem', 'conda', 'mamba', 'uv', 'poetry', 'bundle', 'bundler']) {
  HEAD_HANDLERS[name] = (argv, ctx, result) => classifySystemPm(name, argv, ctx, result);
}

/** Heads that are always DANGEROUS regardless of arguments. */
const ALWAYS_DANGEROUS = new Map([
  ['format', 'disk formatting'],
  ['mkfs', 'filesystem creation'],
  ['diskpart', 'disk partitioning'],
  ['fdisk', 'disk partitioning'],
  ['parted', 'disk partitioning'],
  ['shutdown', 'system shutdown'],
  ['reboot', 'system reboot'],
  ['halt', 'system halt'],
  ['poweroff', 'system power off'],
  ['restart-computer', 'system reboot'],
  ['stop-computer', 'system shutdown'],
  ['invoke-expression', 'arbitrary string execution'],
  ['iex', 'arbitrary string execution'],
  ['regsvr32', 'system registration'],
  ['bcdedit', 'boot configuration'],
  ['vssadmin', 'shadow copy manipulation'],
  ['cipher', 'disk wiping / encryption'],
  ['wbadmin', 'backup catalog manipulation']
]);

const ALWAYS_MUTATE = new Set([
  'touch', 'mkdir', 'md', 'new-item', 'ni', 'mklink', 'ln', 'link', 'mkfifo', 'mknod',
  'truncate', 'patch', 'install', 'set-content', 'add-content', 'ac', 'out-file',
  'set-item', 'set-itemproperty', 'new-itemproperty', 'remove-itemproperty',
  'move-itemproperty', 'copy-itemproperty', 'rename-itemproperty',
  'taskkill', 'kill', 'pkill', 'stop-process', 'start-process', 'saps',
  'reg', 'regedit', 'net', 'netsh', 'schtasks', 'sc', 'setx', 'path',
  'attrib', 'compact', 'chkdsk', 'mode', 'subst', 'label',
  'git-gui', 'start', 'call', 'powershell_ise',
  'truncate', 'shred', 'rsync', 'unzip', 'zip', '7z', 'gzip', 'gunzip', 'bzip2', 'xz',
  'compress-archive', 'expand-archive', 'export-csv', 'export-clixml', 'set-acl',
  'invoke-item', 'ii', 'start-job', 'register-scheduledjob', 'new-service', 'set-service',
  'remove-service', 'stop-service', 'start-service', 'restart-service',
  'add-computer', 'remove-computer', 'rename-computer', 'set-executionpolicy',
  'enable-psremoting', 'disable-psremoting', 'new-localuser', 'remove-localuser',
  'set-localuser', 'add-localgroupmember', 'remove-localgroupmember', 'new-localgroup',
  'remove-localgroup', 'set-netfirewallrule', 'new-netfirewallrule', 'remove-netfirewallrule',
  'foreach-object', 'foreach', '%', 'invoke-command', 'invoke-wmimethod', 'iwmi',
  'invoke-cimmethod', 'set-wmiinstance', 'remove-wmiobject', 'rwmi',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'ansible', 'vagrant',
  'pm2', 'forever', 'nodemon', 'supervisorctl', 'systemctl', 'service', 'launchctl',
  'crontab', 'at', 'batch', 'wmic', 'wevtutil', 'auditpol', 'secedit', 'icacls', 'cacls',
  'takeown', 'runas', 'psexec', 'winrm', 'winrs', 'ssh-keygen', 'certutil', 'certreq',
  'makecab', 'expand', 'esentutl', 'ntdsutil', 'dsquery', 'dsmod', 'dsadd', 'dsrm',
  'nltest', 'klist', 'ksetup', 'setspn', 'ldifde', 'csvde', 'dnscmd', 'dhcpmgmt',
  'appcmd', 'iisreset', 'msiexec', 'winget-run', 'diskshadow', 'vshadow', 'wbadmin'
]);

const ALWAYS_NETWORK = new Set([
  'ssh', 'sftp', 'nc', 'netcat', 'ncat', 'socat', 'ping', 'nslookup', 'dig', 'host',
  'traceroute', 'tracert', 'telnet', 'ftp', 'tftp', 'http', 'https', 'aria2c',
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer',
  'bitsadmin', 'invoke-command', 'icm', 'enter-pssession', 'new-pssession',
  'send-mailmessage', 'test-netconnection', 'resolve-dnsname', 'test-connection'
]);

const ALWAYS_READ = new Set([
  'get-acl', 'get-authenticodesignature', 'get-childitem', 'get-command', 'get-content',
  'get-credential', 'get-culture', 'get-date', 'get-eventlog', 'get-executionpolicy',
  'get-host', 'get-item', 'get-itemproperty', 'get-location', 'get-member', 'get-process',
  'get-psdrive', 'get-pssnapin', 'get-service', 'get-tracesource', 'get-uiculture',
  'get-unique', 'get-variable', 'get-wmiobject', 'gwmi', 'get-winevent',
  'format-hex', 'fhx', 'out-gridview', 'ogv', 'show-command', 'get-computerinfo',
  'get-netadapter', 'get-netipaddress', 'get-netroute', 'get-dnsclientcache'
]);

/* ------------------------------------------------------------------ *
 * classifyArgv: one simple command's argv → tier contribution
 * ------------------------------------------------------------------ */

function classifyArgv(argv, ctx, result, depth) {
  let index = 0;
  // Leading environment assignments and reserved words are not the command word.
  while (index < argv.length) {
    const entry = argv[index];
    if (typeof entry === 'string' && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(entry)) { index += 1; continue; }
    if (typeof entry === 'string' && RESERVED_WORDS.has(entry)) {
      const word = entry;
      if (NOOP_KEYWORDS.has(word)) { index += 1; continue; }
      if (word === 'for' || word === 'select') {
        // `for VAR in words` carries no command; the body lives in later segments.
        return;
      }
      if (word === 'case') return;
      index += 1;
      continue;
    }
    break;
  }
  if (index >= argv.length) return;

  const head = argv[index];
  const rest = argv.slice(index + 1);

  if (typeof head !== 'string') {
    if (head && head.op === 'sub') {
      const nested = classifyCommand(head.inner ?? '', { cwd: ctx.cwd, root: ctx.root, platform: ctx.platform, depth: depth + 1 });
      mergeResult(result, nested);
      return;
    }
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push('unresolved expansion in command position');
    return;
  }

  const name = normalizeCommandName(head);

  if (ELEVATION_WRAPPERS.has(name)) {
    result.tier = worstTier(result.tier, 'DANGEROUS');
    result.dangerous.push(`\`${name}\` (elevated execution)`);
    const inner = rest.filter((arg) => typeof arg !== 'string' || !arg.startsWith('-'));
    if (inner.length > 0) classifyArgv(inner, ctx, result, depth);
    else result.reasons.push(`\`${name}\``);
    return;
  }

  if (TRANSPARENT_WRAPPERS.has(name)) {
    let cursor = 0;
    while (cursor < rest.length) {
      const arg = rest[cursor];
      if (typeof arg !== 'string') break;
      if (arg.startsWith('-')) {
        // Options that take a separate value.
        cursor += ['-n', '-I', '-s', '-S', '-u', '--replace', '--max-args', '--max-lines', '--delimiter', '--arg-file'].includes(arg) ? 2 : 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { cursor += 1; continue; }
      if (name === 'timeout' && /^\d+[smhd]?$/.test(arg)) { cursor += 1; continue; }
      if (name === 'nice' && /^-?\d+$/.test(arg)) { cursor += 1; continue; }
      if (arg === '{}') { cursor += 1; continue; }
      break;
    }
    const inner = rest.slice(cursor);
    if (inner.length === 0) {
      result.tier = worstTier(result.tier, name === 'env' || name === 'time' ? 'READ' : 'MUTATE');
      return;
    }
    classifyArgv(inner, ctx, result, depth);
    return;
  }

  if (SHELL_INTERPRETERS.has(name)) {
    classifyShellInterpreter(name, rest, ctx, result, depth);
    return;
  }

  if (ALWAYS_DANGEROUS.has(name) || name.startsWith('mkfs')) {
    result.tier = worstTier(result.tier, 'DANGEROUS');
    result.dangerous.push(`\`${name}\` (${ALWAYS_DANGEROUS.get(name) ?? 'filesystem creation'})`);
    result.reasons.push(`\`${name}\``);
    return;
  }

  // cd / pushd track the virtual cwd so later relative targets resolve honestly.
  if (name === 'cd' || name === 'chdir' || name === 'set-location' || name === 'sl' || name === 'pushd' || name === 'popd') {
    if (name === 'popd') {
      if (ctx.pushd.length > 0) ctx.cwd = ctx.pushd.pop();
      result.tier = worstTier(result.tier, 'READ');
      return;
    }
    const target = rest.find((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (target === undefined) {
      ctx.cwd = null;
      ctx.cwdUnknown = true;
    } else {
      const scope = resolveTargetScope(target, ctx);
      if (scope.resolved) {
        if (name === 'pushd') ctx.pushd.push(ctx.cwd);
        ctx.cwd = scope.resolved;
      } else if (scope.kind === 'unknown') {
        ctx.cwd = null;
        ctx.cwdUnknown = true;
      }
    }
    result.tier = worstTier(result.tier, 'READ');
    return;
  }

  if (RM_COMMANDS.has(name)) { classifyRemoval(name, rest, ctx, result); return; }
  if (COPY_COMMANDS.has(name)) { classifyTransfer(name, rest, ctx, result, false); return; }
  if (MOVE_COMMANDS.has(name)) { classifyTransfer(name, rest, ctx, result, true); return; }

  const handler = HEAD_HANDLERS[name];
  if (handler) {
    const before = result.tier;
    handler(rest, ctx, result, depth);
    // Handlers that only read still leave `before` untouched.
    void before;
    return;
  }

  if (READ_COMMANDS.has(name) || ALWAYS_READ.has(name)) {
    // `echo`/`printf` writing through a redirect is handled by applyRedirects.
    result.tier = worstTier(result.tier, 'READ');
    return;
  }
  if (BUILD_TEST_COMMANDS.has(name)) {
    if (name === 'dotnet') {
      const { sub } = subcommandOf(rest);
      if (sub && ['add', 'remove', 'nuget', 'user-secrets', 'dev-certs'].includes(sub)) {
        result.tier = worstTier(result.tier, sub === 'add' ? 'INSTALL' : 'MUTATE');
        result.reasons.push(`\`dotnet ${sub}\``);
        return;
      }
      if (sub && ['publish', 'run', 'watch'].includes(sub)) {
        result.tier = worstTier(result.tier, 'BUILD_TEST');
        return;
      }
    }
    if (name === 'composer') {
      const { sub } = subcommandOf(rest);
      if (sub && ['install', 'require', 'update', 'dump-autoload'].includes(sub)) {
        result.tier = worstTier(result.tier, 'INSTALL');
        result.reasons.push(`\`composer ${sub}\``);
        return;
      }
    }
    if (name === 'bundle' || name === 'bundler') {
      const { sub } = subcommandOf(rest);
      if (!sub || sub === 'install') { result.tier = worstTier(result.tier, 'INSTALL'); result.reasons.push('`bundle install`'); return; }
    }
    result.tier = worstTier(result.tier, 'BUILD_TEST');
    return;
  }
  if (INSTALL_COMMANDS.has(name)) {
    classifySystemPm(name, rest, ctx, result);
    return;
  }
  if (NETWORK_COMMANDS.has(name) || ALWAYS_NETWORK.has(name)) {
    result.tier = worstTier(result.tier, 'NETWORK');
    return;
  }
  if (ALWAYS_MUTATE.has(name)) {
    result.tier = worstTier(result.tier, 'MUTATE');
    result.reasons.push(`\`${name}\``);
    return;
  }

  // Unknown binary: fail safe. Never auto-run an unrecognized command.
  result.tier = worstTier(result.tier, 'MUTATE');
  result.reasons.push(`\`${name}\` (unrecognized command)`);
}

function mergeResult(target, source) {
  target.tier = worstTier(target.tier, source.tier);
  // Segment results use `dangerous`/`outOfRoot`; command results use
  // `dangerousReasons`/`outOfRootPaths`. Merge into whichever shape the target has.
  const dangers = target.dangerous ?? target.dangerousReasons;
  const paths = target.outOfRoot ?? target.outOfRootPaths;
  for (const reason of source.reasons ?? []) if (!target.reasons.includes(reason)) target.reasons.push(reason);
  for (const danger of source.dangerousReasons ?? source.dangerous ?? []) if (!dangers.includes(danger)) dangers.push(danger);
  for (const p of source.outOfRootPaths ?? source.outOfRoot ?? []) if (!paths.includes(p)) paths.push(p);
}

/* ------------------------------------------------------------------ *
 * Command-level classification
 * ------------------------------------------------------------------ */

function emptyResult() {
  return { tier: 'READ', reasons: [], dangerous: [], outOfRoot: [] };
}

/**
 * Classify a full command line. Worst segment wins.
 * @param {string} command
 * @param {{cwd?: string|null, root?: string|null, platform?: string, depth?: number}} options
 */
function classifyCommand(command, options = {}) {
  const platform = options.platform || process.platform;
  const mod = pathModule(platform);
  const root = options.root !== undefined
    ? (options.root ? mod.resolve(options.root) : null)
    : (options.cwd ? mod.resolve(options.cwd) : null);
  const result = {
    tier: 'READ',
    segments: [],
    reasons: [],
    dangerousReasons: [],
    outOfRootPaths: [],
    hasOpaqueExpansion: false,
    parseError: null,
    devServer: false,
    // True when the line needs a real shell (chains, redirects, globs,
    // expansions, substitutions, subshells) rather than a direct argv spawn.
    shellSyntax: false
  };
  if (typeof command !== 'string' || !command.trim()) {
    result.parseError = 'empty command';
    result.tier = 'MUTATE';
    result.reasons.push('empty command');
    return result;
  }
  if (command.length > MAX_PARSE_LENGTH) {
    result.tier = 'MUTATE';
    result.shellSyntax = true;
    result.parseError = 'command too long to parse safely';
    result.reasons.push('command too long to parse safely');
    return result;
  }
  const depth = options.depth ?? 0;
  if (depth > MAX_PARSE_DEPTH) {
    result.tier = 'MUTATE';
    result.shellSyntax = true;
    result.parseError = 'command nesting too deep to parse safely';
    result.reasons.push('command nesting too deep');
    return result;
  }

  let entries;
  let built;
  try {
    entries = tokenizeShell(command, platform);
    built = buildSegments(entries);
  } catch (error) {
    result.tier = 'MUTATE';
    result.shellSyntax = true;
    result.parseError = error instanceof Error ? error.message : String(error);
    result.reasons.push('command could not be parsed — approval required');
    return result;
  }

  // Any non-string entry is an operator, glob, expansion or substitution marker;
  // multiple segments mean a chain/pipe/subshell. Either way a shell must run it.
  result.shellSyntax = Boolean(
    built.functionDefinition
    || built.segments.length !== 1
    || entries.some((entry) => entry !== null && typeof entry === 'object')
  );
  // cmd.exe expansions/escapes are restored to literal text above, but they
  // still need cmd to interpret them; route any line containing them to a shell.
  if (platform === 'win32' && /[%!^]/.test(command)) result.shellSyntax = true;

  if (built.functionDefinition) {
    result.tier = 'DANGEROUS';
    result.dangerousReasons.push('shell function definition (fork-bomb shape)');
    result.reasons.push('shell function definition');
  }

  const ctx = {
    root,
    cwd: root,
    cwdUnknown: false,
    platform,
    pushd: []
  };

  const segmentResults = [];
  for (const segment of built.segments) {
    const segResult = emptyResult();
    // Nested command substitutions ride along with their segment.
    for (const inner of segment.subs) {
      const nested = classifyCommand(inner, { cwd: ctx.cwd, root: ctx.root, platform, depth: depth + 1 });
      mergeResult(segResult, nested);
      if (nested.hasOpaqueExpansion) result.hasOpaqueExpansion = true;
    }
    for (const arg of segment.argv) {
      if (arg && typeof arg === 'object' && (arg.op === 'var' || arg.op === 'opaque')) result.hasOpaqueExpansion = true;
    }
    classifyArgv(segment.argv, ctx, segResult, depth);
    applyRedirects(segment, ctx, segResult);
    segmentResults.push({ segment, segResult });
    result.segments.push({
      argv: segment.argv.map((arg) => (typeof arg === 'string' ? arg : markerText(arg))),
      head: segment.argv.length > 0 ? normalizeCommandName(segment.argv[0]) : null,
      tier: segResult.tier,
      reason: segResult.reasons[0] ?? null,
      dangerous: segResult.dangerous.slice(),
      redirects: segment.redirects.map((redirect) => ({ op: redirect.op, target: markerText(redirect.target) })),
      connector: segment.connector,
      pipeFrom: segment.pipeFrom
    });
    mergeResult(result, segResult);
  }

  // Download piped into an interpreter that executes stdin: DANGEROUS.
  for (let i = 0; i < segmentResults.length; i += 1) {
    const { segment } = segmentResults[i];
    if (segment.pipeFrom === null) continue;
    const head = segment.argv.find((arg) => typeof arg === 'string' && !arg.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
    const headName = head ? normalizeCommandName(head) : '';
    if (!STDIN_INTERPRETERS.has(headName)) continue;
    // An interpreter with -c / a script file is not reading the pipe as code.
    const readsStdin = !segment.argv.some((arg) => arg === '-c' || arg === '-e' || (typeof arg === 'string' && /^\/(c|k)$/i.test(arg)))
      && !segment.argv.some((arg, idx) => idx > 0 && typeof arg === 'string' && !arg.startsWith('-') && /\.(sh|py|js|pl|rb|ps1)$/i.test(arg));
    if (!readsStdin) continue;
    let cursor = segment.pipeFrom;
    let downloader = null;
    while (cursor !== null && cursor >= 0) {
      const upstream = segmentResults[cursor];
      const upHead = upstream.segment.argv.find((arg) => typeof arg === 'string');
      const upName = upHead ? normalizeCommandName(upHead) : '';
      if (DOWNLOADERS.has(upName)) { downloader = upName; break; }
      cursor = upstream.segment.pipeFrom;
    }
    if (downloader) {
      result.tier = worstTier(result.tier, 'DANGEROUS');
      const danger = `\`${downloader} | ${headName}\` pipes a download straight into a shell`;
      if (!result.dangerousReasons.includes(danger)) result.dangerousReasons.push(danger);
      const segInfo = result.segments[i];
      segInfo.tier = 'DANGEROUS';
      segInfo.dangerous.push(danger);
    }
  }

  // Unresolved cwd after a `cd` makes later destructive relative targets unprovable.
  if (ctx.cwdUnknown && result.tier !== 'DANGEROUS') {
    for (const { segment, segResult } of segmentResults) {
      const head = segment.argv.find((arg) => typeof arg === 'string');
      const headName = head ? normalizeCommandName(head) : '';
      if (RM_COMMANDS.has(headName) && segResult.tier !== 'READ') {
        result.tier = 'DANGEROUS';
        if (!result.dangerousReasons.includes('destructive command after an unresolved directory change')) {
          result.dangerousReasons.push('destructive command after an unresolved directory change');
        }
      }
    }
  }

  result.devServer = looksLikeDevServer(result.segments);
  return result;
}

/** Dev-server-style long runner detection for the background-job readiness probe. */
function looksLikeDevServer(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return false;
  const first = segments[0];
  const head = first.head;
  if (!head) return false;
  const args = first.argv.slice(1).map((arg) => String(arg).toLowerCase());
  if (DEV_SERVER_PM_HEADS.has(head)) {
    const runIndex = args.indexOf('run');
    const script = runIndex >= 0 ? args[runIndex + 1] : args.find((arg) => !arg.startsWith('-'));
    return Boolean(script && DEV_SERVER_PM_SUBS.has(script));
  }
  if (DEV_SERVER_ALWAYS_HEADS.has(head)) return true;
  if (DEV_SERVER_SUB_HEADS.has(head)) return args.some((arg) => DEV_SERVER_SUBS.has(arg));
  const scriptPattern = DEV_SERVER_SCRIPT_PATTERNS[head];
  if (scriptPattern && args.some((arg) => scriptPattern.test(arg))) return true;
  return false;
}

/** Extract the first ready URL from streamed output (readiness probe evidence). */
function extractReadyUrl(text) {
  const match = String(text ?? '').match(READY_URL_PATTERN);
  return match ? match[0].replace(/[),.;]+$/, '') : null;
}

module.exports = {
  TIERS,
  TIER_RANK,
  AUTO_TIERS,
  DIALOG_TIERS,
  worstTier,
  classifyCommand,
  tokenizeShell,
  buildSegments,
  normalizeCommandName,
  resolveTargetScope,
  looksLikeDevServer,
  extractReadyUrl,
  READINESS_LOG_PATTERN,
  READY_URL_PATTERN,
  MAX_PARSE_DEPTH
};