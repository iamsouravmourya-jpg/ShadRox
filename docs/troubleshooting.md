# Troubleshooting

Common problems on the Windows beta, and where to look when something fails.

## SmartScreen warns about the installer

The Windows installer is **not code-signed**, so SmartScreen may show "Windows protected your PC". This is expected for the beta.

1. Verify the download came from `https://github.com/iamsouravmourya-jpg/ShadRox/releases` (the direct asset is `ShadRox-v0.1.2-Setup.exe`).
2. Choose **More info → Run anyway**.

Do not run installers from mirrors or re-uploads you cannot verify.

## Preview: port conflicts and stale servers

ShadRox **never kills a foreign process** to free a port:

- If the project's pinned port is occupied by another process (even one that answers nothing), the preview **relocates to a free port** — for Vite-style servers it walks upward port by port. The foreign listener survives.
- A URL the dev server prints itself outranks the pre-startup port scan, and the printed host is kept as-is (rewriting `localhost` to `127.0.0.1` can break Next.js HMR).
- Stale-server cleanup only kills process trees **recorded against the same project root** (kept in `preview-orphans.json` in the app's user-data folder). Another workspace's live preview, or any unrelated server, is foreign too: relocate, never kill.
- Next.js records its dev server in `.next/dev/lock`. If the recorded PID is still alive and the URL matches, ShadRox reuses it; if the PID is gone (e.g. after a force-kill), the stale lock is removed so a fresh server can start.

**White or stale preview pane?** Use the preview pane's restart control, or ask the agent to run `preview_control restart` — it re-points the pane at the live URL after a crash or port change. A dev server that logs once and then goes quiet is healthy; silence is not a hang (see [agent-tools.md](./agent-tools.md#background-jobs-and-job_control)).

## pnpm / bun / yarn projects

The preview runtime picks the package manager in this order:

1. The `packageManager` field in `package.json`, if that manager is installed.
2. The lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`/`bun.lock`), if its manager is installed.
3. **The `node_modules` layout on disk** — a `node_modules/.pnpm` store means pnpm built it; `node_modules/.bun` means bun. The store wins over a foreign lockfile, because a lockfile only records what the project was *once* installed with.
4. npm as the fallback.

If the lockfile's manager is not installed, ShadRox installs with npm using `--no-package-lock --legacy-peer-deps` (so it does not rewrite the dependency tree or write a competing lockfile) and shows a notice: install that manager for an exact reproduction. If you see `'bun.cmd' is not recognized` or peer-dependency failures, install the manager the project actually uses, or delete `node_modules` and let ShadRox reinstall with a consistent one.

## OneDrive, file locks, and "changed on disk" errors

Saves are atomic and verified: ShadRox writes a temp file, then hard-links or renames it over the target, and reads the bytes back to confirm.

- **OneDrive/FAT32/network volumes refuse hard links** — ShadRox falls back to rename (and to copy+unlink across volumes), so saves still work there.
- If a file **changed on disk since it was read** (OneDrive sync, another editor, a Git operation), the save is refused with "This file changed on disk. Reload it before saving to avoid overwriting external changes." Reload the file and re-apply; ShadRox will not silently clobber the external change.
- If saves fail with permission/lock errors while OneDrive is actively syncing, pause syncing (or move the project out of the synced folder) and retry. Keep important work in Git regardless — checkpoints and the agent's undo do not replace backups.

## A command was killed or "timed out"

- A non-server command that produces **no output for 120 seconds** is killed (any output resets the timer). Long silent builds should print progress, or run them in the interactive terminal instead.
- **Every background job has a 30-minute ceiling**, output or not; the output says so when it fires.
- Dev servers and jobs proven ready are exempt from the idle kill — only the ceiling bounds them.
- A command still running after 30 seconds is not a failure: it became a background job. Read its real result with `job_control` before concluding anything.

## The agent refuses to edit or run

- **Ask and Plan modes are read-only.** Switch the Run settings menu to **Agent** to allow writes, commands, and MCP tools.
- A delete needs your click in a native dialog; a cancelled delete is final for that call — the agent is told not to retry or pick another file.
- A command in the MUTATE/NETWORK/DANGEROUS tiers needs your approval; DANGEROUS always asks, in red, and can never be pre-approved.
- "Not written — …" means pre-apply verification refused the change; the file on disk is untouched.

## Where logs live

| Record | Location | Notes |
|---|---|---|
| Flight recorder (agent turn traces) | App local storage, keys `shadrox.flight.*` | Local-only JSONL: every model request, tool call, command decision, verification, and stop, scrubbed of credential-shaped text. Bounded: 4,000 events/run, 24 runs, 400 KB/run. Default on; toggle in Settings. Fail-open — logging never breaks a turn |
| Command proof ledgers | User-data folder, `proof-ledgers/` (keys in `proof-keys/`) | Signed, redacted command + hashes + exit code; never output text. Verify offline with `npm run verify:proofs` |
| Machine receipts / consent / preview orphans / MCP config | User-data folder: `machine-receipts/`, `workspace-consent.json`, `preview-orphans.json`, `mcp-servers.json`, `secure-store.json`, `runtime.json` | Main-process state |
| Next.js dev server logs | Project's `.next/dev/logs/` | Written by Next.js itself |
| Dev console | Terminal running `npm run dev:desktop` | Main-process `console` output and renderer devtools |

The user-data folder is Electron's per-app directory — on Windows under `%APPDATA%`, named after the app (`ShadRox` for the installed app). Nothing in these records is sent anywhere.

## Updates

The app checks for a newer release 15 seconds after start and every 6 hours, and shows a badge when one exists. It does **not** download or install updates by itself — download the new installer from GitHub Releases and run it.

## Sign-in and source builds

- Google sign-in is required; the Continue button stays disabled until you accept the Terms and Privacy Policy.
- Running from source needs a Supabase project configured in `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). See [features.md](./features.md#building-from-source).
- In the browser dev build your provider key sits in `localStorage` in plain text — see [byok.md](./byok.md#where-keys-are-stored).

Still stuck? Open an issue at <https://github.com/iamsouravmourya-jpg/ShadRox/issues>. For suspected vulnerabilities, use private reporting per [SECURITY.md](../SECURITY.md) — never a public issue.

## Keep reading

- [Features](./features.md) · [BYOK & keys](./byok.md) · [Agent tools](./agent-tools.md) · [Troubleshooting](./troubleshooting.md) · [FAQ](./faq.md)
- [README](../README.md) · [Website](https://www.shadrox.cyou) · [Releases](https://github.com/iamsouravmourya-jpg/ShadRox/releases) · [Contributors](https://www.shadrox.cyou/contributors)
