const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildGitArgv,
  buildIsolatedGitEnv,
  collectRepoFilterDrivers,
  extractFolderArgument,
  isSameOriginAsRenderer,
  isTrustedRendererEvent,
  parseGitConfig,
  resolveGitExecutable
} = require('./desktop-security.cjs');

const RENDERER_ORIGIN = 'http://127.0.0.1:43121';

function frame(url) {
  return { url, isDestroyed: () => false };
}

function eventFor({ sender, senderFrame, mainFrame }) {
  return { sender, senderFrame, mainFrame };
}

function windowFor(mainFrame) {
  const webContents = { mainFrame };
  return { webContents };
}

test('the desktop bridge only answers the main window main frame on its own origin', () => {
  const mainFrame = frame(`${RENDERER_ORIGIN}/index.html`);
  const mainWindow = windowFor(mainFrame);

  assert.equal(
    isTrustedRendererEvent(eventFor({
      sender: mainWindow.webContents,
      senderFrame: mainFrame,
      mainFrame
    }), mainWindow, RENDERER_ORIGIN),
    true,
    'The app document itself must keep full access.'
  );

  const hostileChild = frame('http://127.0.0.1:5173/');
  const cases = [
    ['a child frame of the main window', eventFor({
      sender: mainWindow.webContents, senderFrame: hostileChild, mainFrame
    })],
    ['a nested frame that happens to share the app origin', eventFor({
      sender: mainWindow.webContents,
      senderFrame: frame(`${RENDERER_ORIGIN}/nested-iframe`),
      mainFrame
    })],
    ['the srcDoc preview frame', eventFor({
      sender: mainWindow.webContents,
      senderFrame: frame('about:srcdoc'),
      mainFrame
    })],
    ['a frame that already navigated away (null senderFrame)', eventFor({
      sender: mainWindow.webContents, senderFrame: null, mainFrame
    })],
    ['a destroyed frame', eventFor({
      sender: mainWindow.webContents,
      senderFrame: { url: `${RENDERER_ORIGIN}/`, isDestroyed: () => true },
      mainFrame
    })],
    ['a main frame served from another origin', eventFor({
      sender: mainWindow.webContents,
      senderFrame: frame('https://evil.example/'),
      mainFrame
    })],
    ['a main frame with an unparseable url', eventFor({
      sender: mainWindow.webContents, senderFrame: frame('not a url'), mainFrame
    })],
    ['another webContents', eventFor({
      sender: { mainFrame: frame(`${RENDERER_ORIGIN}/`) },
      senderFrame: frame(`${RENDERER_ORIGIN}/`),
      mainFrame
    })]
  ];
  for (const [label, event] of cases) {
    assert.equal(
      isTrustedRendererEvent(event, mainWindow, RENDERER_ORIGIN),
      false,
      `Rejected sender: ${label}.`
    );
  }

  assert.equal(isTrustedRendererEvent(eventFor({
    sender: mainWindow.webContents, senderFrame: mainFrame, mainFrame
  }), null, RENDERER_ORIGIN), false, 'No window yet means no trusted renderer.');
  assert.equal(isTrustedRendererEvent(eventFor({
    sender: mainWindow.webContents, senderFrame: mainFrame, mainFrame
  }), mainWindow, null), false, 'The origin is not known until the window is created.');
});

test('origin comparison ignores path but not port, host spelling, or scheme', () => {
  assert.equal(isSameOriginAsRenderer(`${RENDERER_ORIGIN}/deep/path?x=1`, RENDERER_ORIGIN), true);
  assert.equal(isSameOriginAsRenderer('http://127.0.0.1:43122/', RENDERER_ORIGIN), false);
  assert.equal(isSameOriginAsRenderer('https://127.0.0.1:43121/', RENDERER_ORIGIN), false);
  assert.equal(isSameOriginAsRenderer('', RENDERER_ORIGIN), false);
  assert.equal(isSameOriginAsRenderer('shadrox-preview://workspace-id/index.html', RENDERER_ORIGIN), false);
});

test('git is resolved to one absolute executable and a workspace-planted binary never wins', () => {
  const workspace = 'C:\\Users\\victim\\Downloads\\hostile-project';
  const planted = path.win32.join(workspace, 'git.exe');
  const plantedOnPath = path.win32.join(workspace, 'bin', 'git.exe');
  const trusted = 'C:\\Program Files\\Git\\cmd\\git.exe';

  const seen = [];
  const options = {
    platform: 'win32',
    env: {
      PATH: `${workspace}\\bin;C:\\Windows\\System32`,
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows'
    },
    workspaceRoot: workspace,
    neutralCwd: 'C:\\Windows\\System32',
    existsSync: (candidate) => {
      seen.push(candidate);
      return candidate === trusted || candidate === planted || candidate === plantedOnPath;
    },
    runWhere: () => [planted, plantedOnPath, trusted]
  };

  assert.equal(resolveGitExecutable(options), trusted);
  assert.ok(seen.every((candidate) => path.win32.isAbsolute(candidate)),
    'Only absolute candidates may be considered; a relative name re-opens the cwd search.');

  const onlyPlanted = {
    ...options,
    env: { PATH: `${workspace}\\bin`, SystemRoot: 'C:\\Windows' },
    existsSync: (candidate) => candidate === planted || candidate === plantedOnPath,
    runWhere: () => [planted, 'git.exe']
  };
  assert.equal(resolveGitExecutable(onlyPlanted), null,
    'With no git outside the opened folder the feature reports unavailable instead of exec-ing one.');

  const probeCalls = [];
  const fromWhere = resolveGitExecutable({
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
    existsSync: (candidate) => candidate === 'X:\\tools\\Git\\cmd\\git.exe',
    neutralCwd: 'C:\\Windows\\System32',
    runWhere: (callOptions) => {
      probeCalls.push(callOptions);
      return ['X:\\tools\\Git\\cmd\\git.exe'];
    }
  });
  assert.equal(fromWhere, 'X:\\tools\\Git\\cmd\\git.exe');
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0].neutralCwd, 'C:\\Windows\\System32',
    'The where probe must not run with the workspace as its current directory.');

  const posix = resolveGitExecutable({
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    existsSync: (candidate) => candidate === '/usr/bin/git'
  });
  assert.equal(posix, '/usr/bin/git');
  assert.ok(path.posix.isAbsolute(posix));
});

test('git runs with an isolated environment that cannot load user config', () => {
  const env = buildIsolatedGitEnv({
    platform: 'win32',
    env: {
      PATH: 'C:\\tools\\bin',
      USERPROFILE: 'C:\\Users\\victim',
      HOME: 'C:\\Users\\victim',
      GIT_CONFIG_GLOBAL: 'C:\\Users\\victim\\.gitconfig',
      GIT_CONFIG_SYSTEM: 'C:\\ProgramData\\gitconfig',
      GIT_PAGER: 'less',
      GIT_TERMINAL_PROMPT: '1',
      NPM_TOKEN: 'secret'
    },
    neutralHome: 'C:\\Users\\victim\\AppData\\Local\\Temp',
    device: 'NUL'
  });

  assert.equal(env.GIT_CONFIG_GLOBAL, 'NUL');
  assert.equal(env.GIT_CONFIG_SYSTEM, 'NUL');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.HOME, 'C:\\Users\\victim\\AppData\\Local\\Temp');
  assert.equal(env.USERPROFILE, 'C:\\Users\\victim\\AppData\\Local\\Temp');
  assert.equal(env.PATH, 'C:\\tools\\bin', 'git still needs PATH to load its own helpers.');
  assert.equal(env.NPM_TOKEN, undefined, 'Arbitrary user environment is not inherited.');
  assert.equal(buildIsolatedGitEnv({ platform: 'linux', env: {}, device: '/dev/null' }).GIT_CONFIG_GLOBAL, '/dev/null');
});

test('every git call is pinned to a fixed, conversion-free argv', () => {
  const safety = {
    platform: 'win32',
    filterDrivers: ['lfs'],
    safeDirectories: ['C:\\Users\\victim\\project']
  };
  const status = buildGitArgv(['status', '--porcelain=v1', '--branch'], safety);
  const diff = buildGitArgv(['diff', '--no-color', '--unified=2', 'HEAD'], safety);
  const log = buildGitArgv(['log', '-n', '8', '--pretty=%s'], safety);
  const probe = buildGitArgv(['rev-parse', '--is-inside-work-tree'], safety);

  for (const argv of [status, diff, log, probe]) {
    assert.ok(argv.includes('--no-pager'), 'pager.* config can never launch a program.');
    assert.ok(argv.includes('--no-optional-locks'), 'no index write, so no post-index-change hook.');
    const overrides = argv.map((arg, index) => (argv[index - 1] === '-c' ? arg : null)).filter(Boolean);
    assert.ok(overrides.includes('core.fsmonitor=false'), 'core.fsmonitor cannot name a watcher.');
    assert.ok(overrides.includes('diff.external='), 'diff.external is blanked.');
    assert.ok(overrides.some((value) => value.startsWith('core.hooksPath=')), 'hooks are parked on the null device.');
    assert.ok(overrides.includes('filter.lfs.clean='), 'repo filter drivers are disarmed.');
    assert.ok(overrides.includes('safe.directory=C:\\Users\\victim\\project'));
  }

  assert.deepEqual(status.slice(status.indexOf('status')), ['status', '--porcelain=v1', '--branch', '--']);
  assert.deepEqual(diff.slice(diff.indexOf('diff')),
    ['diff', '--no-textconv', '--no-ext-diff', '--no-color', '--unified=2', 'HEAD', '--']);
  assert.ok(diff.includes('--no-textconv') && diff.includes('--no-ext-diff'),
    'textconv and external diff must be off for the diff call itself too.');
  assert.deepEqual(log.slice(log.indexOf('log')), ['log', '--no-textconv', '--no-ext-diff', '-n', '8', '--pretty=%s']);
  assert.deepEqual(probe.slice(probe.indexOf('rev-parse')), ['rev-parse', '--is-inside-work-tree']);
});

test('repo config is parsed for filter drivers, includes and worktree config', () => {
  const parsed = parseGitConfig([
    '[core]',
    '\trepositoryformatversion = 0',
    '[filter "lfs"]',
    '\tprocess = git-lfs filter-process',
    '\trequired = true',
    '[filter]',
    '\tweird.clean = sh -c evil',
    '[include]',
    '\tpath = configs/filters.cfg',
    '[includeIf "gitdir:~/work/"]',
    '\tpath = ./configs/conditional.cfg',
    '[remote "origin"]',
    '\turl = https://example.invalid/repo'
  ].join('\n'));

  assert.deepEqual(parsed.filterDrivers.sort(), ['lfs', 'weird']);
  assert.deepEqual(parsed.includePaths, ['configs/filters.cfg', './configs/conditional.cfg']);
  assert.equal(parsed.ok, true);

  assert.deepEqual(parseGitConfig('[filter "broken]\nclean = evil\n').ok, false,
    'An unterminated header must not be silently trusted.');
  assert.deepEqual(parseGitConfig('[filter "x"]\nclean = "unterminated\n').ok, false,
    'An unterminated value must not be silently trusted.');
});

test('filter driver collection follows the include chain and fails closed', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'shadrox-git-config-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const gitDir = path.join(root, '.git');
  await fsp.mkdir(path.join(gitDir, 'configs'), { recursive: true });
  await fsp.writeFile(path.join(gitDir, 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '[extensions]',
    '\tworktreeConfig = true',
    '[include]',
    '\tpath = configs/filters.cfg'
  ].join('\n'));
  await fsp.writeFile(path.join(gitDir, 'configs', 'filters.cfg'), '[filter "nested"]\n\tclean = evil\n');
  await fsp.writeFile(path.join(gitDir, 'config.worktree'), '[filter "worktree"]\n\tprocess = evil\n');

  const collected = await collectRepoFilterDrivers(gitDir);
  assert.equal(collected.complete, true);
  assert.deepEqual([...collected.drivers].sort(), ['nested', 'worktree']);

  await fsp.writeFile(path.join(gitDir, 'config'), '[filter "hidden]\n\tclean = evil\n');
  const broken = await collectRepoFilterDrivers(gitDir);
  assert.equal(broken.complete, false, 'Unparseable repo config means no working-tree commands.');

  await fsp.writeFile(path.join(gitDir, 'config'), '[include]\n\tpath = ../elsewhere.cfg\n');
  const escaped = await collectRepoFilterDrivers(gitDir, {
    fileExists: (target) => target === path.join(gitDir, 'config') || target.endsWith('elsewhere.cfg'),
    statSync: () => ({ size: 12 }),
    readFile: (target) => (target.endsWith('elsewhere.cfg')
      ? Promise.reject(new Error('EACCES'))
      : fsp.readFile(target, 'utf8'))
  });
  assert.equal(escaped.complete, false, 'An include that cannot be read is treated as unknown.');
});

test('a second launch only contributes an existing directory from its command line', () => {
  const target = fs.realpathSync(os.tmpdir());
  const options = { platform: process.platform, workingDirectory: process.cwd() };
  assert.equal(extractFolderArgument(['C:\\Program Files\\ShadRox\\ShadRox.exe', target, '--flag'], options), target);
  assert.equal(extractFolderArgument([process.execPath, '--flag'], options), null);
  assert.equal(extractFolderArgument([process.execPath, path.join(target, 'does-not-exist')], options), null);
  assert.equal(extractFolderArgument([process.execPath, 'not-an-absolute-path'], options), null);
  assert.equal(extractFolderArgument(null, options), null);
  assert.equal(
    extractFolderArgument([process.execPath, target], { ...options, applicationDirectory: target }),
    null,
    'Paths inside the app install directory are never workspace candidates.'
  );
});
