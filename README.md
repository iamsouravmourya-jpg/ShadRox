# Devora

A browser-based AI coding workspace. You open a folder or a few files straight from your own disk, chat with an AI model about that code, and the assistant edits the open files for you.

Devora brings its own key model (**BYOK**): you paste a Groq or Google Gemini API key, it is validated in the browser, and every model that key can actually use shows up in the picker. There is also an optional shared **Devora key** that lives in a server environment variable, so people without their own key can still use the app.

The whole app is a static Vite build plus a handful of stateless proxy functions. There is no database, no queue, no worker, and nothing about your workspace is written to a Devora server.

---

## Honest status

This is a working early build, not a finished product. It is worth knowing up front:

- **Editor changes are not written back to disk yet.** Edits you make and edits the AI makes live in browser memory (and in a local IndexedDB snapshot). Reloading restores the snapshot, but your real files on disk stay untouched. `FileSystemFileHandle.createWritable()` is planned, not implemented.
- **Preview runs real HTML and Markdown only.** React/TSX/CSS cannot be executed in the preview iframe yet — there is no bundler in the browser.
- **Sign-in is a stub.** There is no Supabase/OAuth yet; `Continue` just writes a demo session token.
- **The shared Devora key has no auth or rate limit yet.** If you enable it in production, anyone who finds the URL can spend it. See `TODO(phase-3)` in [chat.ts](api/ai/chat.ts).
- **Folder/file pickers are Chromium-only** (File System Access API). Drag and drop works in other browsers.

---

## Core ideas

**1. Files stay on disk.** Folders are mounted with `showDirectoryPicker()` and read recursively in the browser. Nothing is uploaded to Devora.

**2. Keys stay in the browser.** A BYOK key is stored in `localStorage` and forwarded per request as a passthrough credential. Devora never persists or logs it.

**3. The server is a thin proxy.** The API routes exist for three reasons: streaming model output through one normalised contract, keeping the shared Devora key off the client, and avoiding CORS. They hold no state between requests.

**4. The AI writes whole files, not diffs.** When you ask for a change, the model replies with a fenced code block whose info line names the file and whose body is the complete new file. Devora resolves that name against the files you actually have open and writes it. Full details in [The file edit protocol](#the-file-edit-protocol).

---

## Features

### Workspace

| Action | How it works |
| :--- | :--- |
| Open a folder | `showDirectoryPicker()` → recursive read, relative paths preserved (`src/App.tsx`) |
| Open files | `showOpenFilePicker({ multiple: true })` → flat file names |
| Drag and drop | Stage 2 cards accept dropped files; the same handler covers both cards |
| Reopen a recent | Restores from a local snapshot — no picker |
| New / close file | `+` in the tab strip, `×` on a tab (a workspace always keeps at least one file) |

Reading a folder skips dotfiles, binary extensions (images, fonts, archives, `*.lock`) and the usual noise directories (`node_modules`, `.git`, `dist`, `.next`, `out`, `coverage`, `.cache`, `.vercel`, `.turbo`, `vendor`, `__pycache__`). A mount is capped at **400 files**.

### Recently opened

Two layers, because they answer different questions:

- **Metadata** in `localStorage` (`devora.recents`) — name, path, file count, kind, timestamp. Last **8** entries, de-duplicated by path.
- **Content snapshot** in **IndexedDB** (`devora-workspace` → `snapshots`, keyed by path) — the actual files, so the entry can be restored directly instead of asking for the folder again.

IndexedDB is used for snapshots because a mounted folder blows past the ~5 MB `localStorage` quota. Snapshots are written immediately on mount and then debounced by 600 ms as you type. When an entry falls out of the recent list, its snapshot is pruned.

Entries created before snapshots existed cannot be restored directly — Devora says so and asks you to pick once more.

### Chat

- Streaming replies over SSE, with a **Stop** button that aborts the upstream request.
- Model picker grouped into **Free** and **Pro**, with context window shown for models that report one.
- **Attach a workspace file** as extra context for a single turn.
- **Voice input** via the Web Speech API (`hi-IN`).
- **Refine prompt** (the wand): sends your text — in any language — through a small pipeline that detects the language, translates it, extracts intent, and returns a tightened prompt. The detected language and intent are shown as a card on your message.
- Clear chat.

### The file edit protocol

This is the part that makes the chat *do* things instead of just printing code.

The system prompt tells the model which files exist (up to 80 names), plus the active file's content (first 12,000 characters) and any attached file's content. It then requires this shape for a change:

````
```tsx path=src/App.tsx
// complete new file contents, nothing omitted
```
````

On the client, the finished reply is scanned by `extractFilePatches()`. For each fenced block it works out a target using these signals, in order, and **every signal is matched against the real open file names** — the model cannot aim a write at a file you do not have:

1. An explicit declaration in the info line — `path=`, `file=`, `filename=`, `filepath=`.
2. A quoted file name — ` ```tsx title="App.tsx" `.
3. A real open file named in the info line or on the line directly above the block.
4. A real open file named inside a comment in the first 3 lines of the block.
5. If exactly one file is open and the fence language fits that file's extension.

Rules that keep this safe:

- **Nothing is written unless it maps to a real file** (or the block explicitly names a new one). A block that carries code but no resolvable target is counted as *unmapped* and reported with a toast instead of being silently dropped.
- **An unterminated fence is never written.** If the stream stops mid-block, half a file would corrupt your code, so the scan bails out.
- **Language has to agree** for the single-file fallback, and the match is a strict token comparison — with `app.js` open, a ` ```json ` example will not be applied.
- An existing file whose content already matches is reported as *unchanged*.

After the write, the chat shows a one-line note per file (`• src/App.tsx — update ho gaya, code editor me dekho`) instead of repeating hundreds of lines of code. Code blocks that are *not* tied to a file stay visible, so genuine examples still read normally.

Because the write target and the chat note come from the same resolution function, what the chat claims is exactly what was written.

### Preview

- **`.html`** files render as-is in a sandboxed iframe.
- **`.md`** files are converted by a small built-in Markdown → HTML step.
- Anything else (or an HTML file that is not active) falls back to the workspace's `index.html` if one exists, and the preview header says why.
- If nothing can be rendered, the pane explains the limitation instead of showing fake output.
- Viewport switcher (desktop / tablet / mobile), manual reload, and a runtime error banner fed by a `postMessage` bridge that forwards `error`, `unhandledrejection` and `console.error` out of the sandbox.

The iframe runs with `sandbox="allow-scripts allow-forms allow-modals allow-popups"` — deliberately without `allow-same-origin`, so sandboxed code cannot reach the parent document.

### BYOK

Both providers are first-class and use the same flow:

1. Paste a key in **Settings → Models & Keys**.
2. `Save & test` posts it to `/api/byok/validate`.
3. The handler calls the provider's model-list endpoint, keeps only chat-capable models, and returns them with latency.
4. The client splits them into Free/Pro and picks a sensible default.

Failure modes are reported explicitly, because a silent "nothing happened" is the worst outcome:

- A key pasted into the wrong provider's field is detected by prefix (`gsk_` = Groq, `AIza` = Gemini) and says so.
- A key that does not look like the right provider's format is rejected before any network call.
- A missing or malformed server response, a 20-second timeout, and a network failure each produce a distinct message.
- Validation state is announced through a `role="status"` live region.

Only keys that **passed validation** are used for chat. Tier classification is a curated list checked against provider docs in **October 2026**; anything unrecognised is treated as `pro` rather than promising a free model that isn't. Non-chat models (speech, TTS, moderation, embeddings, image and video generation) are filtered out of the picker entirely.

The **"Devora ki shared key"** checkbox sends no key from the client, so the request falls back to `DEVORA_GEMINI_API_KEY` on the server.

### Settings drawer

Three tabs, deliberately small: **Models & Keys** (provider, BYOK key, shared key, model list, temperature), **GitHub**, **Secrets**.

- **GitHub** — connect with a Personal Access Token (`repo` scope), see your account and recent repositories, choose a repo, write a commit message, push the workspace. The token stays in component memory for the session and is never persisted. Pushes send files one at a time so a single failure does not abort the batch, and report which files succeeded or failed. Capped at **60 files per push**. (`/api/github/create-repo` exists and works, but the drawer does not expose repository creation yet.)
- **Secrets** — local key/value pairs with reveal/hide. They never leave the browser; only their **names** are included in the model's context so it knows what exists.

### Bug report

The bug icon copies a diagnostics block to your clipboard: workspace name and file count, active file, provider, model, the last preview runtime error, and the user agent.

---

## Tech stack

| Layer | Choice |
| :--- | :--- |
| UI | React 19, TypeScript, Tailwind CSS v4 |
| Build | Vite 8 (`@vitejs/plugin-react`, `@tailwindcss/vite`) |
| Icons | `lucide-react` |
| Dev server | Express + Vite in middleware mode (`tsx server.ts`, port 3000) |
| Production | Static `dist/` on any CDN + Vercel serverless functions under `api/` |
| AI transport | Plain `fetch` — no provider SDK, one normalised SSE contract |
| Browser storage | `localStorage` for settings, IndexedDB for workspace snapshots |
| Markdown | A small in-repo renderer — no markdown dependency |

There is no state library, no router, no UI kit, and no editor dependency.

---

## Project structure

```
Devora/
├── api/                        # Same handlers run locally and on Vercel
│   ├── _http.ts                # Request/response helpers, SSE helpers
│   ├── ai/chat.ts              # Streaming chat proxy (Gemini + Groq)
│   ├── byok/validate.ts        # Key validation + real model discovery
│   ├── prompt/refine.ts        # Language → intent → structured prompt
│   └── github/
│       ├── validate.ts         # PAT → user + recent repos
│       ├── create-repo.ts      # Create a repository
│       └── push.ts             # Commit workspace files (one PUT per file)
├── src/
│   ├── components/
│   │   ├── Stage1Auth.tsx      # Landing / demo sign-in
│   │   ├── Stage2Hub.tsx       # Open folder/files, recently opened
│   │   ├── ChatPanel.tsx       # Messages, model menu, voice, attach, refine
│   │   ├── CodeEditor.tsx      # Tabs + line gutter + textarea
│   │   ├── PreviewPane.tsx     # Sandboxed iframe, viewports, error banner
│   │   ├── SettingsDrawer.tsx  # Models & Keys / GitHub / Secrets
│   │   └── Logo.tsx
│   ├── hooks/
│   │   ├── useWorkspace.ts     # Mount, recents, snapshots, patch writes
│   │   ├── useByok.ts          # Providers, keys, models, validation state
│   │   └── useSpeechRecognition.ts
│   ├── lib/
│   │   ├── workspace.ts        # File System Access API + drop handling
│   │   ├── languages.ts        # Extension → language, skip rules
│   │   ├── providers.ts        # Provider metadata, tier rules, key heuristics
│   │   ├── ai.ts               # Client wrappers for the API routes
│   │   ├── markdown.tsx        # Chat renderer, patch extraction, masking
│   │   ├── preview.ts          # Preview document builder + error bridge
│   │   ├── snapshots.ts        # IndexedDB snapshot store
│   │   ├── storage.ts          # localStorage keys and recent list
│   │   └── types.ts            # Shared types
│   ├── App.tsx                 # Stage routing, layout, chat orchestration
│   ├── main.tsx
│   └── index.css               # Tailwind import + base theme
├── server.ts                   # Local dev server
├── vercel.json                 # Framework, rewrites, function duration
├── metadata.json               # App manifest
├── LICENSE                     # Proprietary — Sourav Maurya
└── README.md
```

---

## How a request flows

1. You type a message. `App.tsx` builds a system instruction from the workspace: file names, the active file's content, any attached file, secret names.
2. `streamChat()` posts to `/api/ai/chat` with `{ provider, model, apiKey?, messages, systemInstruction }`.
3. The handler picks the key — your BYOK key if present, otherwise the server's Devora key — and streams from Gemini (`streamGenerateContent?alt=sse`) or Groq (`chat/completions` with `stream: true`).
4. Both providers are normalised into the same events: `{type:'delta',text}`, then `{type:'done',tokens,provider,model,tier}`, or `{type:'error',message}`. The stream ends with `data: [DONE]`.
5. The client appends deltas live.
6. When the reply completes, `extractFilePatches()` resolves the file writes, `applyFilePatches()` updates the workspace, and the chat is rendered through `maskFileWrites()` so the code the AI just wrote is not repeated back at you.

---

## Getting started

Requires **Node.js 18+** (20 or 22 recommended) and a Chromium-based browser for the pickers.

```bash
git clone https://github.com/iamsouravmourya-jpg/Devora.git
cd Devora
npm install
npm run dev
```

Open `http://localhost:3000`. The dev server mounts the exact handler files Vercel deploys, so local behaviour matches production — including the SSE streaming.

### Scripts

| Script | Purpose |
| :--- | :--- |
| `npm run dev` | Express + Vite middleware dev server on port 3000 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the built `dist/` with Vite |
| `npm run typecheck` | `tsc --noEmit` (also aliased as `npm run lint`) |
| `npm start` | Same as `dev` |

---

## Environment variables

Users bring their own key, so these are only needed if you want the shared Devora key to work. Copy `.env.example` to `.env` locally, or set them in Vercel → Project → Settings → Environment Variables.

| Variable | Required | Purpose |
| :--- | :--- | :--- |
| `DEVORA_GEMINI_API_KEY` | No | Primary key used when a request carries no BYOK key |
| `GEMINI_API_KEY` | No | Fallback for the above; either one is enough |
| `PORT` | No | Dev server port (default `3000`) |

`.env*` is gitignored; `.env.example` is committed.

---

## Deploying to Vercel

`vercel.json` already sets the framework, build command, output directory, and a catch-all rewrite to `index.html` that excludes `/api/*`. Import the repository in Vercel and deploy — no further configuration is required.

Two things worth knowing:

- **API modules must use explicit `.js` extensions on relative imports.** `package.json` has `"type": "module"`, so Vercel evaluates the functions as ESM, where extensionless relative imports fail with `ERR_MODULE_NOT_FOUND`. That surfaces as an opaque `500` from the function itself rather than a `4xx` from your handler. `tsx` resolves them locally, so this only breaks in production.
- **`/api/health` is dev-only.** It is defined inline in `server.ts` and has no counterpart in `api/`, so on Vercel it is not routed.

### Adding an API route

Create the file under `api/`, default-export an `async (req, res)` handler, and use the helpers in `api/_http.ts` (`readJsonBody`, `sendJson`, `sendError`, `sendSseHeaders`, `sseSend`, `sseEnd`). It works on Vercel immediately; to use it locally, add a `mount(...)` line in `server.ts`.

---

## API reference

All routes are `POST` and return JSON unless noted.

| Route | Body | Returns |
| :--- | :--- | :--- |
| `POST /api/byok/validate` | `{ provider, apiKey }` | `{ ok, provider, latencyMs, models[] }`, or `401` with `{ ok: false, error }` |
| `POST /api/ai/chat` | `{ provider, model, apiKey?, messages[], systemInstruction?, temperature? }` | SSE stream of `delta` / `done` / `error` events |
| `POST /api/prompt/refine` | `{ rawPrompt, provider, apiKeyByProvider? }` | `{ detectedLanguage, translatedText, intent, refinedPrompt }` |
| `POST /api/github/validate` | `{ token }` | `{ user, repos[] }` |
| `POST /api/github/create-repo` | `{ token, name, description?, isPrivate? }` | `{ success, repo }` |
| `POST /api/github/push` | `{ token, owner, repo, files[], commitMessage? }` | `{ success, results[], repoUrl }` |
| `GET /api/health` | — | `{ status, hasDevoraKey }` — **dev server only** |

Copy is in Hinglish inside the API error messages, matching the app's UI language.

`api/ai/chat.ts` and `api/prompt/refine.ts` export `config = { maxDuration: 60 | 30 }`, mirrored by `functions["api/**/*.ts"].maxDuration` in `vercel.json`.

---

## Where data lives

| Key | Store | Contents |
| :--- | :--- | :--- |
| `devora.byok.gemini` / `devora.byok.groq` | localStorage | BYOK API keys |
| `devora.model.gemini` / `devora.model.groq` | localStorage | Selected model per provider |
| `devora.provider.active` | localStorage | Active provider |
| `devora.session` | localStorage | Session token (demo value today) |
| `devora.recents` | localStorage | Recent workspaces, max 8 |
| `devora-workspace` → `snapshots` | IndexedDB | Full workspace copies, keyed by path |

Not persisted anywhere: your GitHub token, the Devora shared key, and any key you are still testing.

---

## Browser support

| Capability | Requirement |
| :--- | :--- |
| Open folder / open files | File System Access API — Chrome, Edge, Brave, Opera |
| Drag and drop files | Any modern browser (fallback for the above) |
| Voice input | Web Speech API (`SpeechRecognition`) |
| Everything else | Standard modern browser |

Firefox and Safari get a clear message pointing at drag and drop instead of a broken picker.

---

## Known limitations

- No disk write-back — see [Honest status](#honest-status).
- No browser bundler, so no live React/TSX preview.
- The editor is a plain `textarea` with a line gutter: no syntax highlighting, no autocomplete, no find-and-replace.
- 400 files per mount, 60 files per GitHub push, 8 recent workspaces.
- The active file's context is truncated at 12,000 characters, and at most 80 file names are listed, so very large workspaces are only partially visible to the model.
- Model tiers are curated data, not a live pricing feed. Unknown models default to `pro`.
- Recents and keys are per browser profile — there is no sync.
- No tests yet; `npm run typecheck` is the current safety net.

---

## Roadmap

- Write edits back to disk with `createWritable()`.
- Bundle React/TSX in the browser so the preview covers real projects.
- Supabase auth, plans, and per-user rate limiting in front of the shared key.
- A real editor (CodeMirror or Monaco) behind the same component interface.
- Diff review before applying AI edits, for people who want to approve each change.

---

## License

Proprietary. Copyright © 2026 **Sourav Maurya**. All rights reserved.

Devora is an independent, closed-source product. The source is published for
reference only — no license or right of use is granted. See [LICENSE](LICENSE)
for the full terms.

Third-party dependencies keep their own licenses.
