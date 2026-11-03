import assert from 'node:assert/strict';
import test from 'node:test';
import { rankCommands, type Command } from './commands';

function command(id: string, title: string, extra: Partial<Command> = {}): Command {
  return { id, title, category: 'Test', run: () => {}, ...extra };
}

test('an empty query keeps registry order', () => {
  const commands = [command('a', 'Beta'), command('b', 'Alpha')];
  assert.deepEqual(rankCommands(commands, '').map((entry) => entry.id), ['a', 'b']);
  assert.deepEqual(rankCommands(commands, '   ').map((entry) => entry.id), ['a', 'b']);
});

test('a title hit ranks above a category/keyword hit', () => {
  const commands = [
    command('meta', 'Something else', { keywords: 'save' }),
    command('title', 'Save file')
  ];
  assert.deepEqual(rankCommands(commands, 'save').map((entry) => entry.id), ['title', 'meta']);
});

test('the earlier a title match starts, the higher it ranks', () => {
  const commands = [command('later', 'Reformat document'), command('first', 'Format document')];
  assert.deepEqual(rankCommands(commands, 'format').map((entry) => entry.id), ['first', 'later']);
});

test('a shortcut is searchable', () => {
  const commands = [
    command('plain', 'Toggle terminal'),
    command('keyed', 'Toggle sidebar', { shortcut: 'Ctrl+B' })
  ];
  assert.deepEqual(rankCommands(commands, 'ctrl+b').map((entry) => entry.id), ['keyed']);
});

test('a subsequence of the title still matches', () => {
  const commands = [command('sub', 'Save file'), command('none', 'Open settings')];
  // "sfe" is a subsequence of "Save file" (s…f…e) but not of "Open settings".
  assert.deepEqual(rankCommands(commands, 'sfe').map((entry) => entry.id), ['sub']);
});

test('commands that do not match at all are dropped', () => {
  const commands = [command('a', 'Save file'), command('b', 'Open settings')];
  assert.deepEqual(rankCommands(commands, 'zzz'), []);
});

test('ties keep registry order so the list is stable', () => {
  const commands = [command('a', 'Run tests'), command('b', 'Run tests again')];
  assert.deepEqual(rankCommands(commands, 'run tests').map((entry) => entry.id), ['a', 'b']);
});

test('matching is case-insensitive', () => {
  const commands = [command('a', 'Open Settings')];
  assert.deepEqual(rankCommands(commands, 'SETTINGS').map((entry) => entry.id), ['a']);
});
