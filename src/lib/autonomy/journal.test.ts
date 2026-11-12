import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_JOURNAL_CHARS, MAX_JOURNAL_ENTRIES, createRunJournal, type JournalEntry } from './journal';
import type { RunStorage } from './runStore';

function memoryStorage(): RunStorage & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map)
  };
}

const JOURNAL_KEY = 'shadrox.autonomy.journal:/ws/a';

test('a journal written by one run is readable by the next instance over the same storage', () => {
  const storage = memoryStorage();
  const first = createRunJournal(storage, '/ws/a', { now: () => 1 });
  first.append('Planning: ship it', 'run-1');
  first.append('"m1": passed.', 'run-1');

  const reloaded = createRunJournal(storage, '/ws/a');
  assert.deepEqual(reloaded.lines('run-1'), ['Planning: ship it', '"m1": passed.']);
});

test('append is append-only: nothing an earlier line said is rewritten', () => {
  const journal = createRunJournal(memoryStorage(), '/ws/a', { now: () => 7 });
  journal.append('first', 'run-1');
  journal.append('second', 'run-1');
  journal.append('third', 'run-1');

  const entries = journal.entries();
  assert.deepEqual(entries.map((entry) => entry.text), ['first', 'second', 'third']);
  assert.deepEqual(entries.map((entry) => entry.at), [7, 7, 7]);
  assert.deepEqual(entries.map((entry) => entry.runId), ['run-1', 'run-1', 'run-1']);
});

test('a run id narrows the journal to that run without hiding the rest', () => {
  const journal = createRunJournal(memoryStorage(), '/ws/a');
  journal.append('earlier run', 'run-1');
  journal.append('this run', 'run-2');

  assert.deepEqual(journal.lines('run-2'), ['this run']);
  assert.deepEqual(journal.lines('run-1'), ['earlier run']);
  assert.deepEqual(journal.lines(), ['earlier run', 'this run'], 'the whole tail survives a new run');
});

test('the journal keeps the tail: the oldest lines fall off before the newest do not', () => {
  const journal = createRunJournal(memoryStorage(), '/ws/a');
  for (let i = 0; i < MAX_JOURNAL_ENTRIES + 25; i += 1) journal.append(`line ${i}`, 'run-1');

  const entries = journal.entries();
  assert.equal(entries.length, MAX_JOURNAL_ENTRIES);
  assert.equal(entries[0]?.text, `line 25`, 'the head was dropped, not the tail');
  assert.equal(entries[entries.length - 1]?.text, `line ${MAX_JOURNAL_ENTRIES + 24}`);
});

test('a line is capped rather than pasted whole', () => {
  const journal = createRunJournal(memoryStorage(), '/ws/a');
  const entry = journal.append('x'.repeat(MAX_JOURNAL_CHARS * 3));

  assert.ok(entry);
  assert.equal((entry as JournalEntry).text.length, MAX_JOURNAL_CHARS);
  assert.equal(journal.entries()[0]?.text.length, MAX_JOURNAL_CHARS);
});

test('a workspace does not read another workspace\'s history', () => {
  const storage = memoryStorage();
  createRunJournal(storage, '/ws/a').append('mine', 'run-1');
  const other = createRunJournal(storage, '/ws/b');

  assert.deepEqual(other.lines(), []);
  assert.deepEqual(Object.keys(storage.dump()), [JOURNAL_KEY]);
});

test('an empty or whitespace line is not stored', () => {
  const journal = createRunJournal(memoryStorage(), '/ws/a');
  assert.equal(journal.append(''), null);
  assert.equal(journal.append('   \n  '), null);
  assert.deepEqual(journal.entries(), []);
});

test('a credential never reaches storage in any of its common shapes', () => {
  const storage = memoryStorage();
  const journal = createRunJournal(storage, '/ws/a');
  journal.append('connecting with sk-proj-abcdefghijklmnopqrstuvwxyz1234');
  journal.append('Groq rejected gsk_abcdefghijklmnopqrstuvwxyz12');
  journal.append('Google key AIzaabcdefghijklmnopqrstuvwxyz0123456789');
  journal.append('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5EYjG', 'run-1');
  journal.append('provider settings were apiKey: "sk-abcdefghijklmnop"', 'run-1');
  journal.append('the gateway wants token=hunter2secretvalue', 'run-1');

  const raw = storage.dump()[JOURNAL_KEY] ?? '';
  for (const secret of [
    'abcdefghijklmnopqrstuvwxyz1234',
    'gsk_abcdefghijklmnopqrstuvwxyz12',
    'AIzaabcdefghijklmnopqrstuvwxyz0123456789',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'dozjgNryP4J3jVmNHl0w5EYjG',
    'hunter2secretvalue'
  ]) {
    assert.ok(!raw.includes(secret), `stored journal must not contain ${secret}`);
  }
  assert.match(journal.lines()[0] ?? '', /\[redacted]/);
  assert.match(journal.lines()[4] ?? '', /apiKey: "\[redacted]"/);
  assert.match(journal.lines()[5] ?? '', /token=\[redacted]/);
});

test('a corrupt or foreign blob is an empty journal, not a crash', () => {
  const storage = memoryStorage();
  storage.setItem(JOURNAL_KEY, '{ not json');
  assert.deepEqual(createRunJournal(storage, '/ws/a').entries(), []);

  storage.setItem(JOURNAL_KEY, JSON.stringify({ goal: 'an object, not the array' }));
  assert.deepEqual(createRunJournal(storage, '/ws/a').entries(), []);

  storage.setItem(JOURNAL_KEY, JSON.stringify(['a bare string', 42, { text: 'no timestamp' }, { at: 3, text: 'kept' }]));
  const journal = createRunJournal(storage, '/ws/a');
  assert.deepEqual(journal.entries(), [{ at: 3, text: 'kept' }], 'only a whole entry is kept');
});

test('a storage that refuses does not take the run down with it', () => {
  const hostile: RunStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('denied');
    }
  };
  const journal = createRunJournal(hostile, '/ws/a');
  assert.equal(journal.append('line', 'run-1'), null);
  assert.deepEqual(journal.entries(), []);
  assert.doesNotThrow(() => journal.lines());

  const empty = createRunJournal(null, '/ws/a');
  assert.equal(empty.append('line', 'run-1'), null);
  assert.deepEqual(empty.entries(), []);
});
