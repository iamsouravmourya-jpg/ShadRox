import assert from 'node:assert/strict';
import test from 'node:test';
import { findFileEditingCommand, formatCommandRiskNotice } from './agent/commandGuard.ts';

/** Convenience: true when the guard flags the command. */
function blocks(command: string): boolean {
  return findFileEditingCommand(command) !== undefined;
}

// Expectations mirror Cline's command-guard.test.ts (Apache-2.0) for the
// ported logic; only the structured-argv cases are dropped because ShadRox
// routes a single argv string through the gate.

test('read-only commands pass', () => {
  const allowed = [
    'ls -la',
    'pwd',
    'cat package.json',
    'head -n 50 src/index.ts',
    'grep -rn "runCommand" src/',
    'find . -name "*.ts" -not -path "*/node_modules/*"',
    'git status --short',
    'git log --oneline -20',
    'git diff HEAD~1',
    'git fetch origin main',
    'wc -l src/*.ts',
    'ps aux',
    'node --version',
    'npm ls --depth=0',
    'npm view zod versions',
    'bun test src/agent',
    'cargo check',
    'cargo tree',
    'pip show requests',
    'brew list',
    'sed -n "1,20p" src/index.ts',
    "sed 's/foo/bar/' input.txt",
    'sort -u names.txt',
    "awk '{print $1}' data.csv",
    'diff a.txt b.txt',
    'curl -s https://example.com/api',
    'echo hello world',
    'env | sort',
    'xargs -n1 echo < list.txt',
    'stat src/index.ts',
    'tree -L 2 src'
  ];
  for (const command of allowed) {
    assert.equal(findFileEditingCommand(command), undefined, `should allow: ${command}`);
  }
});

test('redirection to /dev sinks, fd duplication and tmp capture is allowed', () => {
  assert.equal(blocks('ls > /dev/null'), false);
  assert.equal(blocks('ls 2> /dev/null'), false);
  assert.equal(blocks('make check 2>&1 | tail -n 50'), false);
  assert.equal(blocks('echo warn >&2'), false);
  assert.equal(blocks('cmd &> /dev/null'), false);
  assert.equal(blocks('npm run build > /tmp/build.log 2>&1'), false);
  assert.equal(blocks('npm test >> /tmp/test-output.txt'), false);
  assert.equal(blocks('cargo build 2>&1 | tee /tmp/cargo.log'), false);
  assert.equal(blocks('long_cmd > $TMPDIR/out.log'), false);
  assert.equal(blocks('echo x > %TEMP%\\out.log'), false);
  assert.equal(blocks('echo x > $env:TEMP\\out.log'), false);
});

test('operators inside quotes, argument position, heredocs and comments do not flag', () => {
  assert.equal(blocks("grep '=>' src/index.ts"), false);
  assert.equal(blocks('echo "a > b"'), false);
  assert.equal(blocks("git log --grep='rm -rf'"), false);
  assert.equal(blocks('man rm'), false);
  assert.equal(blocks('which mv cp rm'), false);
  assert.equal(blocks('git log -- rm.txt'), false);
  assert.equal(blocks('python3 <<\'EOF\'\nx = 10\nprint(x > 5)\nEOF'), false);
  assert.equal(blocks('echo a \\> b'), false);
  assert.equal(blocks('ls # > notes.txt'), false);
  assert.equal(blocks('echo $((3 > 2))'), false);
});

test('file-mutating commands are blocked with the ported reason strings', () => {
  assert.equal(findFileEditingCommand('rm -rf build'), '`rm`');
  assert.equal(findFileEditingCommand('mv a.txt b.txt'), '`mv`');
  assert.equal(findFileEditingCommand('touch new-file.ts'), '`touch`');
  assert.equal(findFileEditingCommand('mkdir -p src/new-dir'), '`mkdir`');
  assert.equal(findFileEditingCommand('chmod +x script.sh'), '`chmod`');
  assert.equal(findFileEditingCommand('dd if=/dev/zero of=file bs=1M count=1'), '`dd`');
  assert.equal(findFileEditingCommand('del /f file.txt'), '`del`');
  assert.equal(findFileEditingCommand('Copy-Item a.txt b.txt'), '`copy-item`');
  assert.equal(findFileEditingCommand("Set-Content -Path f.txt -Value \"x\""), '`set-content`');
});

test('output redirection to workspace files is blocked', () => {
  assert.equal(findFileEditingCommand('echo hi > out.txt'), 'output redirection (`> out.txt`)');
  assert.equal(blocks("echo 'export const x = 1' > src/new.ts"), true);
  assert.equal(blocks('cat template.txt >> config.yaml'), true);
  assert.equal(blocks('cmd &> output.log'), true);
  assert.equal(blocks('echo x > /tmp/../home/user/project/src/index.ts'), true);
  assert.equal(blocks('echo x > C:\\project\\out.log'), true);
});

test('in-place editors, tee outside tmp and downloaders are blocked', () => {
  assert.equal(findFileEditingCommand("sed -i 's/a/b/' file.txt"), '`sed -i` (in-place edit)');
  assert.equal(blocks("perl -pi -e 's/a/b/' file.txt"), true);
  assert.equal(blocks("gawk -i inplace '{gsub(/a/,\"b\")}1' file.txt"), true);
  assert.equal(blocks('sort -o sorted.txt input.txt'), true);
  assert.equal(findFileEditingCommand('ls | tee files.txt'), '`tee`');
  assert.equal(findFileEditingCommand('curl -o src/out.ts https://x.test'), '`curl -o` (writes a file)');
  assert.equal(blocks('curl -s https://x.test/api'), false);
  assert.equal(findFileEditingCommand('wget https://x.test/file.zip'), '`wget` (downloads files)');
  assert.equal(blocks('wget --spider https://x.test'), false);
});

test('state-changing git subcommands are blocked, read-only forms pass', () => {
  assert.equal(findFileEditingCommand('git add -A'), '`git add`');
  assert.equal(findFileEditingCommand("git commit -m 'msg'"), '`git commit`');
  assert.equal(blocks('git push origin main'), true);
  assert.equal(blocks('git push --force origin main'), true);
  assert.equal(blocks('git reset --hard HEAD~1'), true);
  assert.equal(blocks('git -C /repo -c user.name=x commit -m hi'), true);
  assert.equal(blocks('git stash list'), false);
  assert.equal(blocks('git worktree list'), false);
  assert.equal(blocks('git switch --help'), false);
  assert.equal(blocks('git stash'), true);
});

test('package-manager mutations are blocked, builds and listings pass', () => {
  assert.equal(findFileEditingCommand('npm install lodash'), '`npm install`');
  assert.equal(blocks('pnpm add -D vitest'), true);
  assert.equal(blocks('brew install jq'), true);
  assert.equal(blocks('apt-get install -y curl'), true);
  assert.equal(findFileEditingCommand('python -m pip install requests'), '`pip install`');
  assert.equal(blocks('python3 -m pip show requests'), false);
  assert.equal(blocks('go build ./...'), false);
  assert.equal(blocks('winget list'), false);
  assert.equal(findFileEditingCommand('yarn'), '`yarn` (install)');
  assert.equal(blocks('yarn --version'), false);
});

test('wrappers, pipelines and shell nesting do not hide a mutation', () => {
  assert.equal(findFileEditingCommand('sudo rm -rf /data'), '`rm`');
  assert.equal(blocks('env FOO=1 mv a b'), true);
  assert.equal(blocks('timeout 30 rm file'), true);
  assert.equal(blocks('xargs rm < list.txt'), true);
  assert.equal(blocks('cd /tmp && rm -rf cache'), true);
  assert.equal(blocks('ls; touch marker'), true);
  assert.equal(blocks('echo $(rm file)'), true);
  assert.equal(blocks('FOO=bar rm file'), true);
  assert.equal(blocks('for f in *.log; do rm $f; done'), true);
  assert.equal(blocks('for f in *.log; do echo $f; done'), false);
  assert.equal(findFileEditingCommand("find . -name '*.log' -delete"), '`find -delete`');
  assert.equal(blocks("find . -name '*.tmp' -exec rm {} \\;"), true);
  assert.equal(blocks("find . -type f -exec grep -l TODO {} +"), false);
});

test('formatCommandRiskNotice names the construct and shows the command', () => {
  const message = formatCommandRiskNotice('rm -rf build', '`rm`');
  assert.match(message, /`rm`/);
  assert.match(message, /can modify files/);
  assert.match(message, /rm -rf build/);
});
