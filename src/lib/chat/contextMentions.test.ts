/*
 * Grammar cases are ported from cline's Apache-2.0 test suite at
 * apps/vscode/src/shared/__tests__/context-mentions.test.ts (see the
 * attribution header in contextMentions.ts); resolver tests run against a
 * temp fixture folder on disk.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile, readFile as fsReadFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  expandChatMentions,
  expandContextMentions,
  filePathFromMention,
  isFileMention,
  mentionRegex,
  mentionRegexGlobal,
  createWorkspaceMentionSources,
  parseContextMentions,
  type MentionSources
} from './contextMentions.ts';

// --- grammar: ported from cline's context-mentions.test.ts ------------------

const matchOf = (input: string): string | null => mentionRegex.exec(input)?.[0] ?? null;

test('Windows paths match in full, backslashes and all', () => {
  assert.equal(matchOf(String.raw`@/C:\folder\file.txt`), String.raw`@/C:\folder\file.txt`);
  assert.equal(matchOf(String.raw`@/C:\file.txt`), String.raw`@/C:\file.txt`);
  assert.equal(matchOf(String.raw`@/C:\Users\name\path\to\文件夹\file.txt`), String.raw`@/C:\Users\name\path\to\文件夹\file.txt`);
  assert.equal(matchOf('@/path123/file-name_2.0.txt'), '@/path123/file-name_2.0.txt');
});

test('unquoted paths stop at the first space', () => {
  assert.equal(matchOf('@/path with spaces/file.txt'), '@/path');
});

test('Unix paths match', () => {
  assert.equal(matchOf('@/usr/local/bin/file'), '@/usr/local/bin/file');
  assert.equal(matchOf('@/path/to/file.txt'), '@/path/to/file.txt');
  assert.equal(matchOf('@//etc/host'), '@//etc/host');
});

test('URLs match across protocols and structures', () => {
  assert.equal(matchOf('@http://example.com'), '@http://example.com');
  assert.equal(matchOf('@https://example.com/path/to/file.html'), '@https://example.com/path/to/file.html');
  assert.equal(matchOf('@ftp://server.example.com/file.zip'), '@ftp://server.example.com/file.zip');
  assert.equal(matchOf('@file://localhost/path/to/file'), '@file://localhost/path/to/file');
  assert.equal(matchOf('@ssh://git@github.com/repo'), '@ssh://git@github.com/repo');
  assert.equal(matchOf('@https://example.com?q=test&p=1'), '@https://example.com?q=test&p=1');
  assert.equal(matchOf('@https://example.com#section'), '@https://example.com#section');
  assert.equal(matchOf('@http://localhost:3000'), '@http://localhost:3000');
  assert.equal(matchOf('@https://example.com/'), '@https://example.com/');
});

test('git commit hashes: 7-40 lowercase hex only', () => {
  assert.equal(matchOf('@abcdef1'), '@abcdef1');
  assert.equal(matchOf('@abcdef1234567890'), '@abcdef1234567890');
  assert.equal(matchOf('@abcdef1234567890abcdef1234567890abcdef12'), '@abcdef1234567890abcdef1234567890abcdef12');
  assert.equal(matchOf('@abcdef'), null);
  assert.equal(matchOf('@abcdef1234567890abcdef1234567890abcdef123'), null);
  assert.equal(matchOf('@ghijklm'), null);
  assert.equal(matchOf('@ABCDEF1'), null);
});

test('special keywords match as exact words', () => {
  assert.equal(matchOf('@problems'), '@problems');
  assert.equal(matchOf('@git-changes'), '@git-changes');
  assert.equal(matchOf('@terminal'), '@terminal');
  assert.equal(matchOf('@problemsolver'), null);
  assert.equal(matchOf('@terminals'), null);
  assert.equal(matchOf('@git-changeset'), null);
  assert.equal(matchOf('@problem'), null);
  assert.equal(matchOf('@git-change'), null);
});

test('invalid patterns reject, valid prefixes match only until invalid characters', () => {
  assert.equal(matchOf(String.raw`C:\folder\file.txt`), null);
  assert.equal(matchOf('@'), null);
  assert.equal(matchOf(String.raw`@ C:\file.txt`), null);
  assert.equal(matchOf("@'/path/file.tar.gz'"), null);
  assert.equal(matchOf(String.raw`@/C:\folder\file.txt invalid suffix`), String.raw`@/C:\folder\file.txt`);
});

test('mentions match inside sentences', () => {
  assert.equal(matchOf(String.raw`Check the file at @/C:\folder\file.txt for details.`), String.raw`@/C:\folder\file.txt`);
  assert.equal(matchOf('Review @problems and @git-changes.'), '@problems');
  assert.equal(matchOf(String.raw`Multiple: @/file1.txt and @/C:\file2.txt and @terminal`), '@/file1.txt');
});

test('global regex finds every mention, in order', () => {
  const text = 'Check @/path/file1.txt and @/C:\\folder\\file2.txt and report any @problems to @git-changes';
  assert.deepEqual(text.match(mentionRegexGlobal), ['@/path/file1.txt', String.raw`@/C:\folder\file2.txt`, '@problems', '@git-changes']);
});

test('special characters in paths', () => {
  assert.equal(matchOf('@/path/with-dash/file_underscore.txt'), '@/path/with-dash/file_underscore.txt');
  assert.equal(matchOf(String.raw`@/C:\folder+plus\file(parens)[]brackets.txt`), String.raw`@/C:\folder+plus\file(parens)[]brackets.txt`);
  assert.equal(matchOf('@/path/with/file#hash%percent.txt'), '@/path/with/file#hash%percent.txt');
  assert.equal(matchOf('@/path/with/file@symbol$dollar.txt'), '@/path/with/file@symbol$dollar.txt');
});

test('international characters in paths', () => {
  assert.equal(matchOf('@/path/to/你好/file.txt'), '@/path/to/你好/file.txt');
  assert.equal(matchOf(String.raw`@/C:\用户\документы\файл.txt`), String.raw`@/C:\用户\документы\файл.txt`);
  assert.equal(matchOf('@/путь/к/файлу.txt'), '@/путь/к/файлу.txt');
});

test('trailing punctuation is never part of the mention', () => {
  assert.equal(matchOf('@/path/file.txt.'), '@/path/file.txt');
  assert.equal(matchOf('@problems:'), '@problems');
  assert.equal(matchOf('@terminal;'), '@terminal');
  assert.equal(matchOf('@/path/file.txt!'), '@/path/file.txt');
  assert.equal(matchOf('@/path/file.txt?'), '@/path/file.txt');
  assert.equal(matchOf('@git-changes,'), '@git-changes');
  assert.equal(matchOf('@/path/file.txt!?'), '@/path/file.txt');
  assert.equal(matchOf('@problems...'), '@problems');
  assert.equal(matchOf('@terminal!!'), '@terminal');
});

test('punctuation is excluded in running text too', () => {
  assert.deepEqual(
    String.raw`Check the file at @/C:\folder\file.txt! for details.`.match(mentionRegexGlobal),
    [String.raw`@/C:\folder\file.txt`]
  );
  assert.deepEqual('Review @problems, and @git-changes.'.match(mentionRegexGlobal), ['@problems', '@git-changes']);
  assert.deepEqual(
    String.raw`Multiple: @/file1.txt, and @/C:\file2.txt; and @terminal?`.match(mentionRegexGlobal),
    ['@/file1.txt', String.raw`@/C:\file2.txt`, '@terminal']
  );
});

test('mentions at end of string', () => {
  assert.equal(matchOf('Check @/path/file.txt'), '@/path/file.txt');
  assert.equal(matchOf('Review @problems'), '@problems');
  assert.equal(matchOf('Open @terminal'), '@terminal');
  assert.equal(matchOf('See @git-changes'), '@git-changes');
});

test('mentions in markdown and code comments', () => {
  assert.deepEqual('See @/docs/README.md, check @problems, and visit @https://example.com.'.match(mentionRegexGlobal), [
    '@/docs/README.md',
    '@problems',
    '@https://example.com'
  ]);
  assert.deepEqual('// TODO: Fix @problems in @/src/index.js (see @git-changes)'.match(mentionRegexGlobal), [
    '@problems',
    '@/src/index.js',
    '@git-changes'
  ]);
});

test('quoted paths may contain spaces', () => {
  assert.equal(matchOf('@"/path with space.txt"'), '@"/path with space.txt"');
  assert.equal(matchOf('@"/path/ends/with-space "'), '@"/path/ends/with-space "');
  assert.equal(matchOf('@"/ path-starts-with-space.txt"'), '@"/ path-starts-with-space.txt"');
  assert.equal(matchOf('@"/path with space.txt!"'), '@"/path with space.txt!"');
  assert.equal(matchOf('@"/path with space.txt!"!'), '@"/path with space.txt!"');
});

test('quotes inside unquoted paths do not trigger the quoted form', () => {
  assert.equal(matchOf('@/path"/file".tar.gz'), '@/path"/file".tar.gz');
});

test('path edge cases', () => {
  assert.equal(matchOf('@/'), '@/');
  assert.equal(matchOf('@"/"'), '@"/"');
  assert.equal(matchOf('@/path/to/.hidden/file'), '@/path/to/.hidden/file');
  assert.equal(matchOf('@/path/file...txt'), '@/path/file...txt');
  assert.equal(matchOf('@/path/file.tar.gz'), '@/path/file.tar.gz');
});

test('paths stop at every kind of whitespace', () => {
  assert.equal(matchOf('@/path/file.txt\trest'), '@/path/file.txt');
  assert.equal(matchOf('@/path/file.txt\nrest'), '@/path/file.txt');
  assert.equal(matchOf('@/path/file.txt\rrest'), '@/path/file.txt');
  assert.equal(matchOf('@/path/file.txt rest'), '@/path/file.txt');
});

test('parseContextMentions returns unique tokens without the @', () => {
  assert.deepEqual(parseContextMentions('Compare @/a.ts and @/b.ts and @problems and @/a.ts again'), ['/a.ts', '/b.ts', 'problems']);
  assert.deepEqual(parseContextMentions('email me @foo@example.com maybe'), []);
});

test('plain @words that the grammar does not know stay out of parsing entirely', () => {
  assert.deepEqual(parseContextMentions('ping @foo about @barbaz'), []);
});

test('isFileMention and filePathFromMention follow the cline shapes', () => {
  assert.equal(isFileMention('/src/a.ts'), true);
  assert.equal(isFileMention('"/src/a b.ts"'), true);
  assert.equal(isFileMention('problems'), false);
  assert.equal(isFileMention('https://x.com'), false);
  assert.equal(filePathFromMention('/src/a.ts'), 'src/a.ts');
  assert.equal(filePathFromMention('"/src/a b.ts"'), 'src/a b.ts');
});

// --- resolver: expandContextMentions against a temp fixture folder ----------

const fixture = async (): Promise<{ dir: string; sources: MentionSources }> => {
  const dir = await mkdtemp(join(tmpdir(), 'shadrox-mentions-'));
  await writeFile(join(dir, 'hello.txt'), 'line one\nline two');
  await writeFile(join(dir, 'empty.txt'), '');
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;');
  await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 2;');
  await mkdir(join(dir, 'src', 'nested'));
  await writeFile(join(dir, 'my file.txt'), 'spaced');
  const sources: MentionSources = {
    readFile: async (path) => {
      try {
        return await fsReadFile(join(dir, path), 'utf8');
      } catch {
        return null;
      }
    },
    listDirectory: async (path) => {
      try {
        const entries = await readdir(join(dir, path), { withFileTypes: true });
        return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
      } catch {
        return null;
      }
    },
    problems: async () => 'error src/a.ts:1 missing semicolon',
    gitChanges: async () => 'status:\n M src/a.ts'
  };
  return { dir, sources };
};

test('a file mention rewrites to a phrase and appends the content block', async () => {
  const { dir, sources } = await fixture();
  try {
    const out = await expandContextMentions('explain @/hello.txt please', sources);
    assert.ok(out.includes("'hello.txt' (see below for file content)"));
    assert.ok(out.startsWith('explain '), 'the prose around the mention survives');
    assert.ok(out.includes('<file_content path="hello.txt">\nline one\nline two\n</file_content>'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('folder mentions list the directory', async () => {
  const { dir, sources } = await fixture();
  try {
    const out = await expandContextMentions('what is in @/src/?', sources);
    assert.ok(out.includes("'src/' (see below for folder content)"));
    assert.ok(out.includes('<folder_content path="src/">'));
    assert.ok(out.includes('a.ts'));
    assert.ok(out.includes('nested/'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('quoted paths with spaces resolve', async () => {
  const { dir, sources } = await fixture();
  try {
    const out = await expandContextMentions('read @"/my file.txt" now', sources);
    assert.ok(out.includes('<file_content path="my file.txt">\nspaced\n</file_content>'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multiple mentions expand once each; repeats share one block', async () => {
  const { dir, sources } = await fixture();
  try {
    const out = await expandContextMentions('diff @/hello.txt vs @/src/a.ts — and @/hello.txt again', sources);
    // Every written occurrence gets its pointer phrase; one shared block below.
    assert.equal(out.split('<file_content path="hello.txt">').length - 1, 1, 'one block even though the file is mentioned twice');
    assert.ok(out.includes('export const a = 1;'));
    assert.equal((out.match(/\(see below for file content\)/g) ?? []).length, 3, 'two phrases for hello.txt, one for a.ts');
    assert.equal((out.match(/<file_content/g) ?? []).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('@problems and @git-changes append their blocks', async () => {
  const { dir, sources } = await fixture();
  try {
    const out = await expandContextMentions('check @problems and @git-changes.', sources);
    assert.ok(out.includes('Workspace Problems (see below for diagnostics)'));
    assert.ok(out.includes('<problems>\nerror src/a.ts:1 missing semicolon\n</problems>'));
    assert.ok(out.includes('Working directory changes (see below for details)'));
    assert.ok(out.includes('<git_changes>\nstatus:\n M src/a.ts\n</git_changes>'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unknown mentions and unresolvable types stay plain text and never error', async () => {
  const { dir, sources } = await fixture();
  try {
    const input = 'mail @foo, open @https://example.com, see @abcdef1234567, show @terminal, ping @barbaz';
    const out = await expandContextMentions(input, sources);
    assert.equal(out, input, 'nothing resolves, so nothing rewrites and nothing appends');
    const terminalOnly = await expandContextMentions('@terminal and @/hello.txt', sources);
    assert.ok(terminalOnly.includes('@terminal'), 'terminal stays literal even beside a working mention');
    assert.ok(terminalOnly.includes('<file_content path="hello.txt">'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing file degrades to the literal mention, not an error block', async () => {
  const { dir, sources } = await fixture();
  try {
    const out = await expandContextMentions('read @/nope.txt ok?', sources);
    assert.equal(out, 'read @/nope.txt ok?');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a throwing provider degrades to the literal mention', async () => {
  const { dir } = await fixture();
  try {
    const sources: MentionSources = {
      readFile: () => {
        throw new Error('disk on fire');
      },
      problems: () => {
        throw new Error('ls down');
      }
    };
    const out = await expandContextMentions('@/hello.txt and @problems', sources);
    assert.equal(out, '@/hello.txt and @problems');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bare @/ is never expanded to the workspace root', async () => {
  const { dir, sources } = await fixture();
  try {
    const out = await expandContextMentions('list @/ everything', sources);
    assert.equal(out, 'list @/ everything');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty file still gets a block, marked as empty', async () => {
  const { dir, sources } = await fixture();
  try {
    const out = await expandContextMentions('note: @/empty.txt', sources);
    assert.ok(out.includes('<file_content path="empty.txt">\n(empty file)\n</file_content>'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('oversized content is clipped and the total budget stops further expansion', async () => {
  const { dir, sources } = await fixture();
  try {
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(5000));
    const clipped = await expandContextMentions('@/big.txt', sources, { maxCharsPerBlock: 100 });
    assert.ok(clipped.includes('[... truncated: 5000 characters total]'));
    const capped = await expandContextMentions('@/big.txt then @/hello.txt', sources, { maxTotalChars: 120 });
    assert.ok(capped.includes('big.txt'));
    assert.ok(capped.includes('@/hello.txt'), 'the second mention stays literal once the budget is spent');
    assert.ok(!capped.includes('<file_content path="hello.txt">'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- ShadRox workspace adapter: createWorkspaceMentionSources / expandChatMentions

test('live workspace buffers win over the bridge and match case-insensitively', async () => {
  const files = [{ name: 'src/App.tsx', content: 'live buffer' }];
  const readCalls: string[] = [];
  const bridge = {
    readFile: async (_id: string, path: string) => {
      readCalls.push(path);
      return { content: 'disk copy' };
    },
    listDirectory: async () => ({ entries: [] }),
    diagnostics: async () => ({ diagnostics: [] }),
    gitRead: async () => ({ isRepo: false, status: '', diff: '' })
  };
  const out = await expandChatMentions('look at @/SRC/app.tsx', { files, bridge, workspaceId: 'ws1' });
  assert.ok(out.includes('live buffer'));
  assert.deepEqual(readCalls, [], 'the bridge is not consulted for a buffer the editor already holds');
  const fromDisk = await expandChatMentions('and @/other.ts', { files, bridge, workspaceId: 'ws1' });
  assert.ok(fromDisk.includes('disk copy'));
  assert.deepEqual(readCalls, ['other.ts'], 'the leading slash is stripped for the bridge call');
});

test('folder mentions fall back to a buffer-derived listing without a bridge', async () => {
  const files = [
    { name: 'src/a.ts', content: '' },
    { name: 'src/lib/deep.ts', content: '' },
    { name: 'README.md', content: '' }
  ];
  const out = await expandChatMentions('tree of @/src/', { files, bridge: null, workspaceId: null });
  assert.ok(out.includes('<folder_content path="src/">'));
  assert.ok(out.includes('a.ts'));
  assert.ok(out.includes('lib/'));
  assert.ok(!out.includes('README.md'), 'only children of the mentioned folder');
});

test('problems and git-changes need a native bridge; without one they stay literal', async () => {
  const text = '@problems @git-changes';
  assert.equal(await expandChatMentions(text, { files: [], bridge: null, workspaceId: null }), text);
  const bridge = {
    readFile: async () => ({ content: '' }),
    listDirectory: async () => ({ entries: [] }),
    diagnostics: async () => ({
      diagnostics: [{ severity: 'error', file: '/abs/src/a.ts', line: 0, message: 'TS2304: name not found' }],
      truncated: false
    }),
    gitRead: async () => ({ isRepo: true, status: 'M src/a.ts', diff: 'diff --git a/src/a.ts' })
  };
  const out = await expandChatMentions(text, { files: [], bridge, workspaceId: 'ws' });
  assert.ok(out.includes('error /abs/src/a.ts:1 TS2304: name not found'), 'problems reuse the tool formatting, 1-based lines');
  assert.ok(out.includes('<git_changes>\nstatus:\nM src/a.ts\n\ndiff:\ndiff --git a/src/a.ts\n</git_changes>'));
});

test('createWorkspaceMentionSources turns a bridge failure into a literal, never a throw', async () => {
  const sources = createWorkspaceMentionSources({
    files: [],
    bridge: {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      listDirectory: async () => {
        throw new Error('EACCES');
      },
      diagnostics: async () => {
        throw new Error('ls crashed');
      },
      gitRead: async () => {
        throw new Error('no git');
      }
    },
    workspaceId: 'ws'
  });
  const out = await expandContextMentions('@/a.ts @/dir/ @problems @git-changes', sources);
  assert.equal(out, '@/a.ts @/dir/ @problems @git-changes');
});

test('expandChatMentions is a no-op without any @ and without any mention', async () => {
  assert.equal(await expandChatMentions('no mentions here', { files: [], bridge: null }), 'no mentions here');
  assert.equal(await expandChatMentions('email @foo please', { files: [], bridge: null }), 'email @foo please');
});
