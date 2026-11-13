# ShadRox benchmark

A reproducible scorecard for agent work. Every case here runs offline, with no
model, no API key and no network: a recorded reply is pushed through the same
plan → verify → stage → commit rail the desktop app uses
(`electron/workspace.cjs`, `electron/change-verify.cjs`), and the result is
decided only by the evidence the case itself declares.

```
benchmark/
  cases/
    <case-id>/
      case.json      what the case asserts
      prompt.md      the user's turn, kept for context and for re-runs
      reply.md       the golden reply — the patch the case expects
      fixture/       the repo state the agent starts from
  README.md
```

## Running it

| Command | What it does |
| --- | --- |
| `npm run benchmark` | Grades every case against its own golden reply, and every case against its untouched fixture first. Exits non-zero if a case fails **or** if a case already passed before the patch. |
| `npm run benchmark -- --case <case-id>` | One case only. |
| `npm run benchmark -- --case <case-id> --reply <file>` | Grades a reply an agent really produced against that case. |
| `npm run benchmark -- --json` | The same runs as one JSON document, for CI or a ledger import. |

The scorecard line per case is `PASS|FAIL  kind  id  ···/xxx  reason`, where each
`·`/`x` is one declared check or command, oldest first. The reason is the
ledger's own wording (`outcomeOfTurn`), so a benchmark row and a real turn row
read the same way.

## case.json

```jsonc
{
  "id": "bugfix-average-off-by-one",   // must equal the folder name
  "kind": "bugfix",                     // bugfix | refactor | feature | test
  "title": "average() divides by the count, not one more",
  "notes": "what this shape is testing, for whoever reads the scorecard",
  "checks": [
    { "name": "Divides by the real count", "file": "average.mjs", "match": "return total / values\\.length;" },
    { "name": "Off-by-one divisor removed", "file": "average.mjs", "match": "values\\.length \\+ 1", "absent": true }
  ],
  "commands": [
    { "name": "node check.mjs", "argv": ["node", "check.mjs"], "timeoutMs": 30000 }
  ],
  "allowDestructive": false
}
```

- `checks` are regular-expression sources tested against one file each, in the
  folder **after** the patch. `absent: true` inverts the assertion, which is how
  a case pins "the bad line is gone" without depending on what replaced it.
- `commands` run with `execFile`, never a shell: `argv` is the literal argument
  list, `cwd` is the case folder's temporary copy. A non-zero exit fails the row;
  the transcript (first 600 characters) is kept in the report.
- `allowDestructive` is only for a reply that rewrites a whole existing file the
  way the app's own guard would refuse.
- A case with no checks and no commands is rejected at load time — a case that
  asserts nothing always passes, which is worse than no case.

## The rules the suite enforces

`src/lib/benchmark/benchmark.test.ts` runs as part of `npm test` and proves, for
every folder under `cases/`:

1. **The untouched fixture fails its own assertions.** Run the same checks and
   commands with no patch (`gradeBaseline`). If they already pass, the case does
   not measure the change it claims to measure, and both the test and
   `npm run benchmark` fail.
2. **The golden reply passes all of them, through the real rail.** A reply that
   is refused at plan or verify time, or that writes nothing, fails.
3. **Every folder is named like its `id`, and every kind is covered** — one case
   each for `bugfix`, `refactor`, `feature` and `test`.
4. **Commands are argv lists, not shell strings** — no `;`, `|`, `&&`, `$()` or
   backticks, so a case file can never run something it did not literally name.
5. **A path outside the fixture lands nothing** — a reply that targets `../…`
   fails the case instead of touching the machine.

## Adding a case

1. `mkdir -p benchmark/cases/<kind>-<short-name>/fixture`
2. Put the smallest repo state that still fails in `fixture/`. Fixture paths must
   be plain relative names (`[A-Za-z0-9._-]` segments, no `..`, no absolute
   paths); the loader rejects anything else.
3. Write `prompt.md` as the user's own words, and `reply.md` as the reply you
   expect: fenced blocks with `path=<file>` — either a whole new file, or
   `<<<<<<< ORIGINAL / ======= / >>>>>>> UPDATED` blocks anchored on text that is
   really in the fixture and appears exactly once.
4. Declare the minimum evidence that proves it: the lines that must change, the
   lines that must disappear, and one command that exercises behaviour. Prefer
   `node --test <file>` or `node <script>.mjs` with an explicit path — a bare
   directory argument is not portable across Node versions, and an empty glob
   exits `0`.
5. `npm run benchmark -- --case <kind>-<short-name>` — the baseline must fail and
   the golden reply must pass. `npm test` then keeps both true.

## What the four shipped cases are for

| Case | Shape | The trap it catches |
| --- | --- | --- |
| `bugfix-average-off-by-one` | one line, wrong divisor | a "fix" that rewrites the loop instead of the divisor, or a reply that only claims the fix |
| `feature-todo-toggle-count` | new exports, spec already written | stubs: naming `toggle()`/`remaining()` without behaviour passes no check here, because the given spec runs the real assertions |
| `refactor-extract-display-name` | helper extraction across two call sites | behaviour drift — the command pins the exact old output, and the `absent` checks prove the duplication is gone |
| `test-covers-flag-parser` | tests only | a "test task" that quietly edits the code to suit its own tests: the implementation row fails when the parser is rewritten |
