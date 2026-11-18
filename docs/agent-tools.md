# Agent tools and safety model

The agent is a bounded tool loop, not a one-shot patch parser: it requests workspace tools, receives their real results, and continues reasoning. Providers with native function calling use it; a ShadRox text protocol (` ```shadrox:tools ` blocks) is the fallback. Every tool result is wrapped as untrusted data (`[[SHADROX_UNTRUSTED_DATA_BEGIN]]` … `END`) — instructions found inside results are ignored.

## Access modes

The composer's Run settings menu is the capability boundary:

| Mode | Reads | Writes / commands / MCP |
|---|---|---|
| Ask | yes | refused |
| Plan | yes | refused (edits staged for review only) |
| Agent | yes | allowed, under the guards below |

Any tool that is not a known native read/write/execute/control tool — every MCP tool and any unknown name — fails closed to `external` and is denied in Ask/Plan. A refusal is shown in the trace with its reason; it is not a silent no-op.

## Tool surface

| Tool | What it does |
|---|---|
| `list_directory` | List one directory of the opened folder (paged) |
| `read_file` | Read a file, optionally a 1-based line range. `.env` files are readable but secret values are masked (below) |
| `find_files` | Find files by path name |
| `search_text` | Search file contents; paraphrase-tolerant fallback (below) |
| `write_file` | Create a file or overwrite one it has read; refuses destructive whole-file rewrites |
| `edit_file` | Replace an exact, unique snippet in an existing file |
| `delete_file` | Delete one file or an empty folder; needs `confirm: true` **and** a native user dialog, then a disk read-back proves absence |
| `problems` | Real compiler diagnostics (project or named files) |
| `git_state` | Working-tree status and diff |
| `run_command` | One shell command line (max 2000 chars) in the opened folder; real exit code, stdout, stderr; risk-tiered (below) |
| `job_control` | `list` / `status` / `read_output` / `stop` for background command jobs |
| `preview_control` | `start` / `stop` / `restart` the live preview pane (below) |
| `terminal_state` | Read the interactive terminal: cwd, running command, last exit, silent seconds, awaiting-input, last failure class. Never types |
| `terminal_answer` | Type one printable line (max 200 chars) into a command that is waiting for input — only after the user approves the exact bytes in a dialog. Never for passwords, tokens, or secrets |
| `debugger_state` | Read a paused debug session: top frame, scopes, bounded locals (10 frames / 3 scopes / 30 variables / 200 chars per value). Read-only; refuses when nothing is paused |
| `outline` | Symbols defined in a file, with line numbers |
| `update_tasks` | Set/update the turn's plan (`pending` / `doing` / `done` / `blocked`) |
| `finish` | End the turn with a summary (and an optional `blocked` reason) |

User-configured MCP tools join the same list and share the round budget. Tool output is capped (24,000 chars per result) with an honest truncation note.

## File writes are verified, not arbitrary

`write_file` and `edit_file` save to disk immediately during the turn, through the same verified save path as the reviewed patch pipeline:

1. Pre-apply change-set verification — nothing reaches disk that the verifier refused or could not check.
2. A rewrite-risk guard refuses a `write_file` that would erase most of an existing file (use `edit_file` instead). `edit_file` requires the original snippet to match exactly one place.
3. A version-pinned atomic save: the bridge refuses paths outside the workspace, symlinks, read-only rule docs, and files that changed on disk since the read; then it reads the saved bytes back to confirm.
4. Plugin and automation manifests are protected paths — agent edits to them are blocked.

Reply edit blocks (`path=` fences) are applied by the host between rounds through the same pipeline. The patch parser keeps nested code fences inside an edited Markdown file from splitting the edit block, preserves the file's Windows CRLF line endings, refuses an unterminated whole-file rewrite rather than partially writing it, and tolerates a blank context line in a multi-file diff. Deletes are the one tool with no in-chat undo: a person must click, and a read-back that cannot prove absence is reported as *unverified*, never as success.

## Command approval: risk tiers

`run_command` lines are parsed with a real shell tokenizer (shell-quote plus a Windows adaptation layer) into segments — chains, pipes, redirects, substitutions — and each segment is classified. **The worst segment decides the tier.** Compound commands like `npm i && npm test` are allowed.

| Tier | Behavior | Examples |
|---|---|---|
| READ | auto-runs | `ls`, `cat`, `git status`, `git diff`, `git log`, `tsc --noEmit`, `rg foo` |
| BUILD_TEST | auto-runs | `npm test`, `npm run build`, `pytest`, `jest`, `cargo build`, `go test`, `eslint .` |
| INSTALL | auto-runs | `npm install`, `pip install`, `pnpm add`, `winget install`, `go get` |
| MUTATE | native approval dialog | `git commit`, `mkdir`, `sed -i`, `node script.js`, `eslint --fix`, redirects into workspace files |
| NETWORK | native approval dialog | `curl`, `wget`, `git push`, `git clone`, `ssh`, `npm publish` |
| DANGEROUS | **always** the dialog, with a red warning; never pre-approved by any scope | `rm -rf` at/outside the workspace root, writes outside the root, `sudo`/`runas`, `curl … \| sh`, encoded PowerShell (`-EncodedCommand`), `format`/`diskpart`/`mkfs`, `shutdown`, `Invoke-Expression`, shell function definitions (fork-bomb shape) |

Fail-safe rules:

- An **unrecognized command is MUTATE** — an unknown binary never auto-runs.
- Writes, deletes, or moves aimed **outside the workspace root** escalate to DANGEROUS; a recursive forced delete at the root itself (or a root-covering glob like `*`) is DANGEROUS.
- A model field (`confirm: true`, "the user said so") is never authorization. The workspace is re-checked between approval and execution.
- On Windows, a binary-shaped file planted in the project root that would shadow a PATH tool (CreateProcess searches cwd first) is refused outright; `.cmd`/`.bat` shims are resolved to trusted absolute executables and quoted safely.
- Approval is not a sandbox: an approved command can still change the machine. Approve only what you understand.

Auto-run commands stay visible in the terminal dock with their real output and exit code. A non-zero exit produces a **failure receipt** on the chat message (with the turn's undo checkpoint id) and a repair brief for the model; ShadRox never applies a repair patch by itself. A successful re-run of the same command after a proposed repair is shown as a verified heal.

## Background jobs and `job_control`

Timeouts are about **silence**, not wall-clock duration:

- A command still running after **30 seconds** of foreground waiting becomes a background job: `run_command` returns `exit null`, a job id (`J1`, `J2`, …), and the output tail. That is not a failure and earns no repair receipt.
- **Dev servers background immediately** (`npm run dev`, `vite`, `uvicorn`, `next dev`, …) and report readiness from their logs — a ready URL is probed before it is trusted. A ready server logs once and then serves quietly: silence is health, not a hang.
- A **silent non-server job is killed after 120 seconds** of no output (any stdout/stderr resets the timer). Dev servers and jobs proven ready are exempt from the idle kill.
- **Every job has a 30-minute absolute ceiling**, output or not.
- Each job keeps a rolling **200 KB** output buffer with stable absolute offsets. `job_control read_output` returns the last 8,192 chars by default (up to 204,800, or an explicit character range). `stop` terminates the whole process tree. Up to 20 finished jobs stay readable; closing a workspace cleans up its jobs.

The model is told explicitly: a backgrounded command has NOT finished — read its output and exit status before drawing conclusions, and never restart a healthy server just because its logs went silent.

## The loop: 60 rounds, progress-based stuck detection

- A turn gets **60 tool rounds** by default, each holding up to **16 calls** that run in parallel. Calls beyond the cap are reported and stay runnable next round.
- At **80% of the budget** (round 48) the model gets one soft wrap-up note. At the cap, one final stream is forced ("answer now with what you have"); the stop carries a resumable state summary so a Continue button can pick up later.
- **Stuck detection is progress-based, not repetition-based.** Real progress signals: a new file read, a file content-hash change, a diagnostics count decrease, a command exit-code change, a mutation landing, a task marked done — plus any result that says something new. **8 consecutive steps** with zero progress and zero new information earn one nudge, then a forced final answer. Repeating a call is not a crime; seeing nothing new is.
- **Duplicate calls are never refused.** A succeeded call repeated in the same turn is served from a result cache prefixed `[unchanged since step N]`. Cache entries are invalidated by real workspace mutations (a mutation epoch) and content hashes — a verified delete, an approved command, a landed write, or an MCP write makes earlier reads runnable again. Failed or refused calls are never cached, so they stay retryable.
- An exploration-style ask ("explain this project", "scan…") answered without a single workspace read gets one nudge to inspect first.
- Every boundary (model request, tool call, command decision, verification, stop) lands in a local, scrubbed **flight recorder** — see [troubleshooting.md](./troubleshooting.md#where-logs-live).

## Paraphrase-tolerant search

Users paraphrase and typo when quoting text from their app, so a full-phrase miss is never proof the text is absent:

- The model is instructed to search **1–3 distinctive words** (a noun, a year, an identifier), never a whole quoted sentence.
- If a multi-word plain-text `search_text` query finds nothing, the tool automatically retries with the query's distinctive tokens (up to 6; numbers first, then longest words; stop words dropped) and returns **partial matches ranked by how many query words each file contains** — best files first, with matching lines.
- The result tells the model to read the top-ranked file before claiming anything is missing. Regex queries do not get the fallback.

Example: searching `"Copyright 2024 Acme Inc all rights reserved"` and missing falls back to tokens like `2024`, `acme`, `copyright`, `reserved`, and surfaces the footer file that contains most of them.

## `.env` files: readable, secrets masked

`read_file` on any `.env*` file returns the content with secret-shaped values replaced: keys matching `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `PASS`, `PRIVATE`, `CREDENTIAL`, `SIGNATURE`, `DATABASE_URL`, `_DSN`, or `AUTH` show as `<set>` or `<empty>` — presence, never the secret. Non-secret lines pass through unchanged, so configuration can still be diagnosed. Secret values never enter the model context or the transcript.

## `preview_control`

The embedded preview pane is managed separately from raw processes:

- `start` runs the project's dev/static server and points the pane at its URL. A one-time install/run consent dialog may appear; if the tool returns `approval-required`, the user must approve — the agent is told not to retry blindly. With multiple detected projects, it asks which to run.
- `stop` halts the preview; `restart` stops then starts so the pane re-points after a crash or port change.
- Use it when the preview is white or stale instead of killing servers by hand. `run_command`/`job_control` manage processes; `preview_control` manages the pane.

## Proof ledger

Every assistant command appends a line to a local **Ed25519-signed ledger** under the app's user-data folder: the redacted command, hashes of the command and its output, and the exit code — never the output text. Credential-shaped parts (tokens, passwords, `Authorization` headers, credentials in URLs) are replaced before signing. Ledger keys live in the OS encrypted store; an edited, reordered, or torn ledger is detected on read. `npm run verify:proofs` re-checks every ledger offline and exits non-zero on any failure. This is not remote attestation and does not protect a machine an attacker already controls.

Settings also reports the token usage the provider returns for each turn (including cache hits where reported). ShadRox bills nothing and keeps no meter.

## Agent benchmark

`npm run benchmark` grades the agent end-to-end **without calling any model**. Each case in `benchmark/cases/<case-id>/` pins a fixture, a prompt, the expected reply, and the commands that must pass afterwards; the reply is replayed through the same parse → verify → atomic-apply → Git rail the product uses.

```sh
npm run benchmark                              # grade every case
npm run benchmark -- --case id                 # grade one case
npm run benchmark -- --case id --reply reply.md  # grade a reply an agent really produced
npm run benchmark -- --json                    # machine-readable output
```

The suite refuses a hollow pass: each case must fail its baseline and assert at least one real check, so an edit that never applied or a command that tests nothing shows up as a failure. Cases cover `bugfix`, `refactor`, `feature`, and `test`. See `benchmark/README.md` for the case format.

## Limits to keep in mind

The loop is an early implementation and can make mistakes. Reads and inspections are unguarded; edits go through the verified pipeline; commands follow the tier table. Agent loops, autonomous runs, teams, plugins, and automations are evolving — verify important work yourself and keep backups or Git.