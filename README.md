# ShadRox

ShadRox is a desktop coding workspace for opening a local project, browsing and editing its files, asking an AI provider for help, running a local preview, and using a terminal in the project folder.

The application is built with React, TypeScript, Vite, and Electron. Project files are opened from the user's computer and the desktop app writes accepted edits back to that folder. AI chat is optional and requires a provider key that the user brings (BYOK): Google Gemini, Groq, or any OpenAI-compatible endpoint of their own. The shared operator key exists in the code but is switched off for the beta; see **Beta scope**.

> **Project status:** ShadRox is an early beta/development project. Every install starts with a Google sign-in; the account row (email, name, avatar URL, app version, platform) lives in Supabase. Versioning restarted at **0.0.1**; the current installable build is **0.0.2**. The Windows build is one unsigned NSIS installer, `ShadRox-Setup.exe`, and updates itself from GitHub Releases. Paid tiers (Starter and Pro) are defined and visible in the UI but cannot be selected yet (`PLANS_LOCKED`); billing enforcement is not live, and the plan labels in the UI are not active subscriptions.

## Accounts and sign-in

Sign-in is compulsory: the installed app does not show the workspace until a session exists. The first screen is a single **Continue with Google** button. Pressing it starts the standard OAuth 2.0 PKCE flow for native apps (RFC 8252):

1. The renderer creates a PKCE verifier, then opens Supabase's `/auth/v1/authorize?provider=google` URL in the system browser through `shell.openExternal`.
2. Electron starts a one-shot HTTP listener on `http://127.0.0.1:51789/auth/callback` before the browser opens.
3. After Google sign-in, Supabase redirects to that loopback URL with `?code=…`. Supabase replaces any client-supplied `state` with its own CSRF value, so the callback is validated by PKCE: only this client holds the verifier. The renderer exchanges the code at `/auth/v1/token?grant_type=pkce`, closes the listener, and the main process brings the ShadRox window back to the foreground.
4. The session (`shadrox.auth.session`) and the PKCE verifier are written to the OS-encrypted store (`safeStorage`/DPAPI on Windows), never to `localStorage`. Access tokens are refreshed before expiry; signing out revokes the refresh token and clears both keys.
5. A best-effort profile upsert writes the account row to `public.profiles` with the user's own access token, so RLS (`auth.uid() = id`) applies.

What is stored server-side: Supabase's `auth.users` row (email, provider identity) and one `public.profiles` row (email, full name, avatar URL, provider, app version, last platform). No project files, no prompts, and no Gemini/Groq key are sent to ShadRox. If Supabase env vars are missing at build time, the first screen says sign-in is not configured rather than opening the workspace.

### Supabase project setup

1. Create a Supabase project and copy the project URL and **anon** public key (Project Settings → API). Never put the `service_role` key in the desktop app or the landing page.
2. Authentication → Providers → Google: enable it and paste a Google Cloud OAuth client ID/secret. In Google Cloud Console create an OAuth client of type **Web application** with authorized redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`. The loopback URL (`http://127.0.0.1:51789/auth/callback`) belongs only in Supabase's redirect allow list, never in the Google console. While the Google consent screen is in **Testing**, add every tester's Google address as a test user (or publish the app); an address that is not listed cannot sign in.
3. Authentication → URL Configuration: set the Site URL to `https://shadrox.cyou`. Add `http://127.0.0.1:51789/auth/callback` to the redirect allow list. Both the exact port and path are required; the desktop listener is bound to that address. The Google client ID/secret go in the Supabase Google provider, not in Vercel.
4. Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor. It creates `public.profiles`, owner-only RLS policies, the `handle_new_user` trigger, and the `updated_at` trigger, and is safe to re-run.
5. Confirm a test Google sign-in fills `auth.users` and `public.profiles`.

## Beta landing page

The ShadRox-branded beta landing page lives in `landing/` as a separate Next.js app; it is not the desktop workspace. Its original shield-and-S mark matches the ShadRox app branding. From the repository root, install its locked dependencies once and run the preview with:

```sh
corepack pnpm --dir landing install --frozen-lockfile
npm run dev:landing
```

The landing page opens at `http://localhost:3001`; the existing desktop-app development server continues to use port `3000`. The page is informational: **Download for Windows** links straight to the latest installer, and there is no web login or waitlist. Download URLs live in `landing/lib/download.ts`:

- Latest installer: `https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-Setup.exe`
- All releases: `https://github.com/iamsouravmourya-jpg/ShadRox/releases`

The download link never changes between versions because every release publishes the same asset name (`build.artifactName` is `ShadRox-Setup.${ext}`) and `/releases/latest/` always resolves to the newest release. Bump `APP_VERSION` in `landing/lib/download.ts` when the page copy should name a new version.

Vercel deploys the static export from `landing/out` using the root `vercel.json`, while keeping the existing `api/` functions available. Keep the Vercel project connected to this repository's `main` branch and use the repository root as its Root Directory; the deployment config selects the landing build instead of the desktop Vite app. The landing page needs no Supabase keys today; if a web account surface is added later, add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to Vercel.

## What the installed app looks like

The Windows build is one unsigned NSIS installer, `ShadRox-Setup.exe`. It installs per-user, so there is no admin prompt, and it adds a Start-menu shortcut. Launching it does not drop you into an empty editor: a signed-out launch shows the sign-in screen, and a signed-in launch opens the Workspace Hub.

### Screen 0 — Sign in

```
┌──────────────────────────────────────────────────────────────────┐
│  ◆ ShadRox                              Desktop beta · Windows   │
│                                                                  │
│                    One account. One workspace.                   │
│        Continue with Google to start. Your project files         │
│        stay on this device; the account stores only your         │
│        email, name, and app version.                             │
│                                                                  │
│               [ G  Continue with Google ]                        │
│                                                                  │
│        Sign-in opens your browser and returns here.              │
│                                                                  │
│                        shadrox.cyou                              │
└──────────────────────────────────────────────────────────────────┘
```

- The first screen blocks the workspace until a session exists. **Continue with Google** opens the system browser; when the callback arrives, ShadRox brings itself to the front and shows the hub. A failed attempt shows the reason instead of a blank window.
- The account chip in the hub and workspace titlebar shows the avatar and email; **Sign out** in Settings or the hub clears the encrypted session and returns to this screen.
- If the build has no `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, the screen states that sign-in is not configured. That is a build-time problem, not something the user can fix.

### Screen 1 — Workspace Hub

```
┌──────────────────────────────────────────────────────────────────┐
│  ◆ ShadRox                              Desktop beta · Windows   │
│                                                                  │
│                          ●  BETA                                 │
│                                                                  │
│                   Open a project. Start building.                │
│        Your project stays on this device. AI chat sends only     │
│        the prompt and code context you choose to your provider.  │
│                                                                  │
│            [ Add your API key to start chatting ]                │
│                                                                  │
│      ┌────────────────────┐      ┌────────────────────┐          │
│      │    Open Folder     │      │    Open Files      │          │
│      │  Mount workspace   │      │ Any file formats   │          │
│      └────────────────────┘      └────────────────────┘          │
│                                                                  │
│  Recently opened                                  Click to reopen│
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  my-app        folder   42 files                     ×     │  │
│  │  scratch.html  file      3 files                     ×     │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

- **Add your API key** opens Settings → Models & Keys. Until a Gemini or Groq key is saved, chat refuses to spend; the app never falls back to a ShadRox key during the beta.
- **Open Folder** is the normal path: the folder is mounted, read recursively (with size, binary, traversal and symlink guards), and every later save writes back into that same folder.
- **Open Files** mounts individual files without a project root.
- **Recently opened** reopens a workspace from its local snapshot in one click. In the browser build this is also where write permission is re-granted; in the desktop app the folder is re-opened directly.

### Screen 2 — Workspace

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ‹  ◆ my-app   42 files   2 unsaved     Save  Auto-save off   Code Preview ⚙│
├───────────────────────────────┬────────────────────────────────────────────┤
│  CHAT            Gemini ▾  ⚡ │ EXPLORER            ⌕ filter       + New    │
│  ╭ Code │ Plan │ Complex ╮    │ ▾ src                                      │
│  │                         │  │   ▾ components                             │
│  │ user: add validation    │  │     ChatPanel.tsx                          │
│  │ assistant: …            │  │     CodeEditor.tsx                         │
│  │ ┌─────────────────────┐ │  │   App.tsx                                  │
│  │ │ form.html  2 s/r    │ │  ├────────────────────────────────────────────┤
│  │ │ [Accept] [Skip]     │ │  │ App.tsx ×  ChatPanel.tsx ×                 │
│  │ └─────────────────────┘ │  ├────────────────────────────────────────────┤
│  │                         │  │  1  export function App() {                │
│  │ [ ask ShadRox…      ➤ ] │  │  2    const workspace = useWorkspace();    │
│  ╰─────────────────────────╯  │  …                                         │
│                               ├────────────────────────────────────────────┤
│                               │ TERMINAL [System|AI] my-app                │
└───────────────────────────────┴────────────────────────────────────────────┘
```

- **Titlebar** shows the back arrow to the hub, the workspace name, file count, an amber "unsaved" badge, **Save**, **Auto-save**, the **Code / Preview** switch and Settings. The window uses a custom titlebar, so the native frame does not double up with it.
- **Left pane (35%) — chat.** Model picker, Code / Plan / Complex mode, streamed replies with reasoning, resume after a dropped stream, a checkpoint timeline in the header that restores an earlier state, and the patch-review cards. Accepted edits are written straight to disk and the card says **Saved to disk**; if a write cannot happen it says **Applied in editor** and tells you why.
- **Right pane — editor.** The Explorer sidebar lists the folder tree and can filter or create files; open files become tabs; the CodeMirror editor carries dirty markers, quick open and inline AI. The status bar counts TypeScript errors and warnings for the workspace and opens the Problems panel; the outline panel lists the active file's declarations.
- **Preview** replaces the editor with the `shadrox-preview://` pane for static sites and supported Node projects, including a device-size selector and live logs.
- **Terminal** docks under the editor and runs inside the workspace folder. Two tabs, one click apart: **System** is your own shell with your full environment (use it to install Node, git or a package manager), **AI** is the credential-stripped environment the assistant's commands run in. Both stay alive while you switch. Commands the assistant initiates still ask once for approval.
- **Settings** is a right-side drawer: signed-in account and sign-out, plan, BYOK keys, model list, automatic-update card, GitHub, appearance.

Keyboard: `Ctrl/⌘+S` save, `Ctrl/⌘+P` quick open (`@` for symbols in the active file, `#` for symbols across the workspace), `Ctrl/⌘+Shift+F` search inside files, `Ctrl/⌘+K` inline AI edit on the selection, `F12` or `Ctrl/⌘+Click` go to definition.

## What it can do

- Open a folder or selected files from the desktop app.
- Browse folder contents on demand and load text files when selected. The desktop workspace applies size, generated-file, binary-file, path traversal, and symbolic-link safeguards.
- Edit source in a CodeMirror-based editor and save changes to the local project. AI-proposed changes can be reviewed and applied through the chat workflow; checkpoint/history features are also available in the app.
- Accept multi-file edits as SEARCH/REPLACE patches: each block is matched independently, applied right-to-left, and a block that does not match fails alone instead of blocking the rest of the reply. A block that matches more than one place is refused as ambiguous rather than silently editing the first hit, and the review UI shows why each block failed.
- Apply a multi-file reply as one atomic set. Every patch is resolved in memory first; if any file cannot be resolved the whole set is marked **Blocked** with the reason and nothing is written. On the desktop, the resolved set is staged as a single transaction, and if the commit fails part-way the files already written are restored to their pre-apply contents instead of leaving a half-applied edit on disk.
- Reject a broken edit before it reaches disk. With a folder workspace open, the resolved files are parsed first — TypeScript/JavaScript syntax, JSON/JSONC, CSS brace balance, and HTML tag closure — and the apply reports the file, line, and message when the set would not parse. This is a static gate, not a sandbox: no code from the change is executed.
- Heal a change that lands but leaves type errors. After a successful apply, the language service compares diagnostics against a pre-apply snapshot. A `Cannot find name` (TS2304) that exactly one workspace file exports is fixed deterministically by inserting the import — no model call. Any other newly introduced, fixable type error is offered as one **Fix N type errors** button in that reply's card; it sends one bounded SEARCH/REPLACE request limited to the affected files and is never spent silently or looped.
- Resolve merge conflicts in the editor. When the open file contains `<<<<<<<` / `=======` / `>>>>>>>` markers, a banner shows the hunk count and the number of unmerged paths git reports, with **Ours**, **Theirs**, and **Both** actions. The file is rewritten and saved through the normal transactional writer; unparseable markers are reported instead of being guessed.
- Render static previews that ship their own CSP. Before a served HTML page gets the click-to-source bridge, its own `Content-Security-Policy` `<meta>` tag is removed by a quote-aware tag scanner, so a page that blocks its own framing can still render in the preview frame. Response headers and all other markup are untouched.
- Rewind through checkpoints from the chat header. Every assistant reply that touched files records a content-addressed checkpoint; the timeline slider lists them newest-first, shows the time, label, and file count, and restores one behind a two-step confirm. Restoring is a normal write, so the review cards report **Saved to disk** like any other edit.
- Jump from a rendered static preview back to source. Clicking an element in a served `index.html` maps the click to the nearest `id`/`class`/tag in the source file and opens the editor on that line. The preview page's script has no access to the desktop bridge; it posts one short message, and the path is baked in at serve time.
- Use inline AI in the editor: ghost-text completion at the caret (Tab to accept, Escape to dismiss) and a Ctrl+K quick edit that rewrites the selection, or the line under a bare caret.
- See TypeScript errors and warnings in the editor, the status-bar counter, and the Problems panel, navigate with F12/Ctrl+Click, and jump through the active file's outline or workspace symbols from quick open. Diagnostics use the unsaved buffer, so a file under edit is checked as typed rather than as last saved.
- Resume an interrupted reply. A dropped stream keeps the partial text and survives a reload, and continuing re-sends it as context so the model picks up where it stopped instead of starting over. The persisted snapshot always describes the conversation on screen, so a regenerate, stop, or cleared chat can never restore a stale one over live work.
- Generate a commit message from the workspace's git status, diff, and recent subjects through a read-only git bridge; outside a git folder it falls back to the editor's unsaved-file list.
- Chat using Gemini, Groq, or your own OpenAI-compatible endpoint through the app's local API handlers with your own key (BYOK). The shared operator key is compiled in but gated off, so a request without a key is refused rather than served from ShadRox's plan. The app supports a Code mode, a read-only Plan mode, and a Complex mode. Model availability depends on the provider and key. Each request is trimmed to the selected model's context window, in the renderer and again at the server route that spends the key.

**Custom endpoint (the third BYOK option).** Settings → *Models & Keys* → **Custom endpoint** takes a base URL and a key, and ShadRox calls `/models` and `/chat/completions` on it. Anything that speaks the OpenAI chat-completions dialect works: the preset list covers OpenRouter, DeepSeek, xAI, Together, Fireworks, Mistral, Cerebras, SiliconFlow, GitHub Models, Groq's compat URL, Ollama and LM Studio, and the URL field is free text, so a credit-reselling gateway that is not on the list is one paste away. Gateways that do not implement `/models` are expected — a missing listing saves the key and asks for the model ids under **Model ids**, which then join the picker. Their models are badged **Your endpoint** rather than being claimed as free or Pro, and every cost on that path is the user's own. Local servers are reached over plain `http://127.0.0.1:*` because the desktop app runs this API itself on loopback; the hosted Vercel functions refuse `http`, private ranges and internal hostnames, because there the same field would otherwise be an open proxy. See `api/ai/_endpoint.ts`.
- Preview static sites and supported Node-based web projects inside the desktop app.
- Open an interactive terminal in the workspace and view terminal output.
- Connect GitHub actions from Settings using a GitHub token, including validation, repository creation, and pushing a project, where configured.

## Code intelligence

The desktop app runs a real TypeScript language service over the opened folder and exposes four surfaces through it: diagnostics (editor squiggles, status-bar counts, Problems panel), go-to-definition (`F12`/Ctrl+Click), the active-file outline, and workspace symbol search. All of them accept the editor's unsaved buffers as overrides, so navigation and squiggles match what is on screen rather than what is on disk.

- **One worker per workspace.** TypeScript's language service is synchronous, and a cold program build over a few hundred files blocks whichever thread runs it. `electron/ts-service.cjs` therefore runs inside a `worker_threads` worker (`electron/ts-worker.cjs`), keeps one session per opened workspace, and shuts it down when the workspace closes. If a packaged build cannot start a worker, the service falls back to the main thread rather than dropping the feature.
- **Bounded work.** At most 2,000 project files of 2 MiB each, 500 diagnostics, 100 navigation results, and a 3-level outline. Files are discovered from `tsconfig.json`/`jsconfig.json` when present and from a guarded directory walk otherwise; generated and dependency folders are skipped.
- **Cached, not re-read.** Reads, existence checks, directory probes, module resolution, file stats, and parsed snapshots are all cached between requests and invalidated when a buffer changes or the on-disk view is refreshed, so a warm diagnostics pass is milliseconds instead of tens of seconds. Both the renderer and the service key paths with forward slashes, because TypeScript normalizes to `/` while Windows `path` calls return `\`.
- **Failures stay contained.** A broken or slow language service logs once and is swallowed: diagnostics never become a render error, and a stale response is discarded by request id instead of overwriting newer results.
- **TypeScript version.** `typescript@7.x` is the native port: its root export exposes only `version`, and its `tsc` silently exits without type checking. The app therefore depends on `typescript-legacy@npm:typescript@5.9.3` for the language service, and `lint`/`typecheck` call that package's `tsc` explicitly. Do not point either at the `typescript` package by name.

Not implemented yet: quick fixes/code actions, rename symbol, find-references UI (the bridge exposes `ts:references`, but no panel or keybinding is wired), and semantic tokens. They are the natural next steps on top of this service.

## Local context retrieval

Chat context is chosen from the whole workspace, not from a list of file names. `src/lib/retrieval.ts` builds a BM25 index over chunked files — chunks start at top-level declarations so a snippet is a whole function rather than an arbitrary slice — and returns the strongest whole-file snippets that fit the selected model's context budget, alongside a compact repo map (path, line count, and declared symbols). Everything runs in the renderer; no index server and no embeddings API call.

`src/lib/localEmbeddings.ts` adds a semantic re-rank on top: the top 24 lexical candidates are embedded locally and merged with the lexical scores, while the repo map and budget still come from the lexical pass. The transformer is loaded lazily by `@huggingface/transformers` (all-MiniLM-L6-v2) only if the package is installed; the chat path still calls the synchronous `retrieveContext`, so semantic ranking is a tested seam and not yet wired into chat. When no embedder is available — or the import, the model load, or the vectors fail — retrieval returns the lexical result unchanged.

## Plans and BYOK

ShadRox is free-first by design. The goal is a zero-cost acquisition surface that competes with other AI coding tools on the free tier.

### Pricing Tiers

- **Free (BYOK) — ₹0/month, forever.** Unlimited access with your own keys: Groq Llama 3.3 70B (free), Gemini 1.5 Flash (₹0.075/1M tokens), DeepSeek V3 (₹0.14/1M tokens), or any OpenAI-compatible endpoint (OpenRouter, Together, OpenAI, Ollama, LM Studio). The user pays their AI provider directly; ShadRox's marginal cost is ₹0. All editor features included: disk write-back, preview, checkpoints, terminal, planning system, multi-agent coordination, plugins, and automations.

- **Starter — ₹299/month (inclusive).** Shared key access with intelligent model routing: Groq Llama 3.3 70B (unlimited), Gemini 1.5 Flash (500k tokens/month), DeepSeek V3 (200k tokens/month). 1,000 credits/month (1 credit = 1 request or 1 file edit). Automatic model selection picks the cheapest capable model for each task, so you never worry about switching models to save money. Includes multi-agent coordination, advanced planning with AI decomposition, and priority support.

- **Pro — ₹1,499/month (inclusive).** Everything in Starter plus premium models: Claude 3.5 Sonnet (200k tokens/month), GPT-4o (100k tokens/month), larger context windows, semantic retrieval, priority model routing, and priority support. 3,000 credits/month. Ideal for professional developers and complex refactors.

- **Team — ₹2,999/month (up to 5 users).** Everything in Pro plus team collaboration features, shared workspace, team analytics, and admin dashboard. 5 team members included.

### Model Strategy

**Default Models (Smart Routing):**
- **Groq Llama 3.3 70B** - Default for all tiers (free, fast, excellent code)
- **Gemini 1.5 Flash** - Code edits (₹0.075/1M input, ₹0.30/1M output)
- **DeepSeek V3** - Complex reasoning (₹0.14/1M input, ₹0.28/1M output)
- **Claude 3.5 Sonnet** - Premium tasks (₹3/1M input, ₹15/1M output) - Pro/Team only
- **GPT-4o** - Premium backup (₹2.5/1M input, ₹10/1M output) - Pro/Team only

**Cost Optimization:**
- Groq first (often free)
- Cache aggressively (30-40% cost reduction)
- Smart model routing (50-70% cost reduction)
- Context budgeting (trim prompts smartly)

**Credit System:**
- 1 credit ≈ 1 request or 1 file edit
- 6 credits = complex refactor
- 0.1 credit = autocomplete
- Failed requests refunded automatically

**No BYOK gate, no BYOK trial.** An earlier plan of paywalling remote custom endpoints behind Starter was dropped: charging for access to a model the user is already paying for themselves is the fastest way to lose goodwill. The free tier costs ShadRox nothing. Paid tiers compete on setup and routing quality instead.

Beta note: paid tiers are visible in the UI but cannot be selected yet (`PLANS_LOCKED`). Server-side entitlement enforcement (Supabase session + per-user usage meter) is the gating work before the shared key is turned on for real testers — during the beta the shared key is switched off entirely (see **Beta scope**), so the point is moot until launch. The free BYOK tier needs none of it because it carries no ShadRox cost.

## Local project and AI data

ShadRox is designed around a local desktop workspace: opening, browsing, editing, and saving project files happens on the user's computer. The desktop app runs a local Express process for the UI and API routes; this local process is not a ShadRox-hosted account backend.

When the user sends a chat or prompt-refinement request, the prompt and the project context selected for that request are sent to the chosen provider — Gemini, Groq, or the user's own endpoint — via the app's API route. A provider API key is required for BYOK use. In the desktop app, provider keys are read from the OS-encrypted store (Electron `safeStorage`, so DPAPI on Windows) and held in memory for the session — they are not written back to `localStorage`, and any legacy plaintext copy left by an older build is deleted on startup. The custom endpoint's base URL is the deliberate exception: it is kept in plain `localStorage`, because it is a server address rather than a credential, and it is never sent anywhere except the endpoint itself. Non-secret settings keep using `localStorage` as before. Browser mode has no encrypted store available, so there the key does live in `localStorage`. ShadRox's own server never persists a user key: a BYOK request passes it through to the provider for that one call. A ShadRox shared provider key can optionally be supplied through environment variables by an operator; it is policy-gated (Pro-tier models only) and never stored server-side. Requests using that key are still sent to the selected AI provider.

GitHub operations send the token and requested repository data to GitHub through the app's API handlers. Review provider and GitHub terms before sending private code or credentials. The only centralized account service is Supabase Auth, and the only data it receives is the sign-in identity and the profile fields listed in **Accounts and sign-in**. There is still no ShadRox cloud project sync, and the API routes do not trust a Supabase session for AI spend because shared keys are disabled during the beta.

## Preview support

The preview pane supports these local workflows:

| Project | How preview works |
| --- | --- |
| Static site with `index.html` | Served from the opened workspace through ShadRox's internal `shadrox-preview://` protocol. |
| Static site nested in a workspace | If no runnable Node project is selected, discovered folders with `index.html` can be offered as preview roots. |
| Node-based web project | ShadRox discovers a `package.json` with a `dev`, `start`, `preview`, or `serve` script, asks the user to approve running it (and dependency installation when needed), then probes a loopback HTTP/HTTPS endpoint for readiness. |
| Multiple runnable subprojects | The user can choose which detected project folder to run. |

The preview runtime supports common package managers (npm, pnpm, Yarn, and Bun) when available. It scans nested project directories with safety limits, skips generated/vendor folders, and stops managed preview processes when the preview/workspace is closed. HTTPS readiness probing accepts self-signed certificates for local readiness checks; that does not make arbitrary remote certificates trusted.

For static sites served through `shadrox-preview://`, clicking an element reveals it in the source. The main process injects a small bridge-free script into the served HTML; the script posts one short message naming the page and the nearest `id`/`class`/tag, and the renderer locates that element in the file and opens the editor on its line. The injected script runs inside the previewed workspace's page and has no desktop bridge access, so it can send a reveal message but cannot call any IPC handler. Click-to-source does not apply to projects started through a dev server, because those pages are not served by ShadRox.

Preview is not a universal runtime. Python, Go, PHP, Java, .NET, and other backend projects do not have dedicated runtime adapters. A site's own `Content-Security-Policy` meta tag is stripped from pages served by `shadrox-preview://`, but a dev server that sends framing-blocking response headers can still refuse to render, because those responses are not proxied. Browser capabilities are sandboxed, and app-level certificate handling is restricted to local loopback preview hosts.

## Terminal and command execution

The desktop terminal uses `node-pty` to create an interactive shell rooted in the opened project. Closing the workspace tears down its terminal sessions. The dock has two tabs, and switching between them is one click; both shells stay alive while you toggle, so scrollback and a running install survive the switch.

| Tab | Shell | Environment |
| --- | --- | --- |
| **System** | PowerShell on Windows (falls back to `ComSpec` if PowerShell is absent), `$SHELL` elsewhere | The user's full environment, so `winget`, `choco`, `nvm`, `npm i -g` and a proxy config all behave as they would outside the app. |
| **AI** | `ComSpec` on Windows, `/bin/sh` elsewhere | A copy of the environment with credential-shaped variables removed (`*API_KEY`, `*KEY`, `*TOKEN`, `*SECRET`, `*PASSWORD`, `*CREDENTIAL`, `*SESSION`, `*AUTH`, plus the named ShadRox/Supabase/Groq/Gemini keys). |

The AI tab is the shell the assistant's one-shot commands run in: `executeCommand` gets the same scrubbed environment, so a command the model types cannot read a stored provider key out of `$env`. It exists so the user can see and reproduce what the assistant can do — installing toolchains is deliberately a System-tab job, because the assistant's shell has no business holding the user's credentials. Nothing connects assistant output to that pty; commands the assistant initiates still go through the confirmed one-shot handler. Both tabs are still real shells with the operating-system permissions of the ShadRox process; commands typed in either can modify files or reach the network.

The terminal opens for any workspace with a directory behind it, including a single-file workspace, and is independent of whether the project preview is available.

Preview scripts and dependency installation are separate managed actions that require an approval step in the UI. The app also exposes a one-shot command API with confirmation. Approval for one preview action does not mean arbitrary terminal commands are harmless.

## Security model

The threat model is unusual for a desktop app: ShadRox opens an arbitrary folder chosen by the user and then runs that folder's code in a preview frame, while holding the user's provider API keys. These are the controls that keep the two apart.

- **Only the app's own main frame gets desktop powers.** Electron injects preload scripts into every frame, and preview content lives inside the main window's document, so `electron/desktop-security.cjs` accepts an IPC call only when it comes from the main window's main frame, on the pinned backend origin, and the preload exposes the bridge only when `window.top === window`. A previewed workspace's JavaScript therefore never sees `terminal:create`, `secure:*`, or `workspace:*`.
- **Read-only git, hardened against a hostile repository.** `git` is resolved once to an absolute path from trusted locations, and any candidate inside the opened workspace is rejected — a planted `git.exe` cannot be chosen. Every call runs with a minimal environment (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at the null device, `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`), a fixed argv with no shell, and `-c core.fsmonitor=false -c core.hooksPath=NUL -c diff.external=` plus `--no-textconv --no-ext-diff`. Repo-declared clean/smudge/process filter drivers are enumerated from the repository's own config chain and individually disarmed; if the config chain cannot be fully enumerated, status and diff return empty rather than risk executing a driver.
- **Workspace writes stay inside the workspace.** Path normalization plus `lstat`/`realpath` checks reject `..`, absolute, drive-letter, UNC and alternate-data-stream paths, and symlink or junction escapes.
- **Provider keys are never server-side.** BYOK requests pass the key straight through to the provider for that single call. The Vercel functions do not persist keys, and provider error text is sanitized before it reaches the renderer so a key or an outgoing URL cannot be echoed back.
- **Command environments drop the keys.** Any shell the assistant's commands run in — the one-shot handler and the AI terminal tab — gets a copy of the process environment with credential-shaped variables removed, so `env`/`Get-ChildItem env:` cannot leak a stored key. The System terminal tab is the user's own shell and is not scrubbed; that is the trade that lets it install toolchains.
- **Shared-key spend is policy-gated — and switched off for the beta.** One module decides which key a request may spend. `SHADROX_ALLOW_SHARED_KEY=1` is the master gate: while it is unset, an unkeyed request is refused *before* the operator key is looked up, so neither the UI nor a hand-crafted `fetch` in devtools can spend it. Turning the gate back on restores the previous policy — the caller's key always wins, and the shared key serves Pro-tier models only. Prompt refinement uses the same gate rather than reading an environment key directly. A best-effort per-IP token bucket limits shared-key requests only — BYOK traffic is never throttled because it costs the operator nothing. The bucket is per warm serverless container and trusts `x-forwarded-for`, so it is a cost brake, not an entitlement system; that still needs accounts.
- **Sandboxed renderer.** No Node integration, context isolation on, sandbox on, and navigation restricted to the app's own origin.
- **Sign-in is PKCE and loopback-only.** The desktop OAuth flow uses an S256 PKCE challenge, opens the provider URL in the system browser, and accepts the callback only on `127.0.0.1:51789/auth/callback`. The main process validates the URL shape and rejects a second concurrent sign-in. Validation is PKCE-only because Supabase supplies its own `state` and does not echo the client's; the verifier never leaves the app, and the loopback listener exists for one sign-in only. Session tokens live in the encrypted store, and the renderer never receives the Google secret or the Supabase service key.
- **The profile API cannot read other users.** `public.profiles` has RLS with `auth.uid() = id` on select, insert, and update; the client uses only the public anon key with the signed-in user's access token.

## Architecture

| Area | Location | Responsibility |
| --- | --- | --- |
| React UI | `src/` | Sign-in screen, hub, chat, editor, preview, settings, and terminal interface. |
| Renderer helpers | `src/lib/`, `src/hooks/` | AI requests, provider metadata, context budgeting, BM25/hybrid retrieval (`retrieval.ts`, `localEmbeddings.ts`), the SEARCH/REPLACE patch engine, atomic multi-file apply planning (`atomicApply.ts`), checkpoint timeline model (`timeline.ts`), editor completion/quick-edit extensions, workspace state, persistence, preview logic including click-to-source lookup (`previewSource.ts`), and the PKCE/auth client (`src/lib/authCore.ts`, `src/hooks/useAuth.ts`). |
| Electron main process | `electron/main.cjs` | Native dialogs, IPC handlers, the one-shot OAuth loopback listener, local preview protocol (including the injected source bridge), managed preview and PTY lifecycle, single-instance handling, read-only git access, and desktop security settings. |
| TypeScript language service | `electron/ts-service.cjs`, `electron/ts-worker.cjs` | Per-workspace `LanguageServiceHost` with bounded project discovery, buffer overrides, cached disk access, diagnostics, definition, references, outline and workspace symbols; runs off the main thread in a worker with a main-thread fallback. |
| Change verification | `electron/change-verify.cjs` | Static, write-free pre-apply gate: parses a resolved change set (TypeScript/JavaScript syntax, JSON/JSONC, CSS brace balance, HTML tag closure) and reports issues by file and 0-based line before anything is written. |
| Self-healing apply | `src/lib/autoFix.ts`, `src/lib/typeErrorRefine.ts` | Deterministic import insertion for unresolved names (single export match), and the bounded type-error micro-request offered after an apply; diagnostics are diffed against a pre-apply snapshot so only introduced errors are touched. |
| Conflict resolution | `src/lib/conflicts.ts`, `electron/git-conflicts.cjs` | Conflict-marker parser producing base/ours/theirs hunks, Ours/Theirs/Both resolution, and read-only unmerged-index listing through the hardened git argv. |
| Preview CSP strip | `electron/csp-strip.cjs` | Single-pass, quote-aware removal of a served page's own CSP `<meta>` tag before the click-to-source bridge is injected; headers are untouched. |
| Preview source bridge | `electron/preview-source.cjs` | Injects a bridge-free click listener into served static HTML, idempotently, with the file path baked in as a JSON literal; only short reveal messages cross into the renderer. |
| Desktop trust + git hardening | `electron/desktop-security.cjs` | Testable predicates for which renderer frames may call IPC, the git executable lookup, the isolated git environment, and the argument set that disarms repo-controlled git hooks, external diffs, textconv, and filter drivers. |
| Automatic updates | `electron/updater.cjs` | electron-updater wiring for Windows/macOS: quiet startup and periodic checks, automatic download, one restart dialog, and a status channel for the Settings UI. Inactive in development and in the browser build. |
| Preload bridge | `electron/preload.cjs` | Narrow, named renderer-to-main API exposed with `contextBridge`; raw Node and Electron APIs are not exposed to the renderer. |
| Workspace layer | `electron/workspace.cjs` | Lazy directory listing, read-on-click, scoped file access, and guarded local writes. |
| Local API server | `server.ts`, `api/` | Express routes used for AI, key validation, prompt refinement, GitHub actions, and local frontend serving. |
| Desktop packaging | `scripts/package-desktop.js`, `package.json` | Builds the web renderer, derives the API layer's `src/lib` runtime dependency set by walking the import graph from `server.ts`, stages exactly that set, installs runtime dependencies, and invokes Electron Builder. |
| Account schema | `supabase/schema.sql` | `public.profiles`, owner-only RLS, and the triggers that create a profile on sign-up and stamp `updated_at`. |

The renderer is configured without Node integration and runs with context isolation and sandboxing; see **Security model** for how desktop capabilities are restricted to the app's own frame.

## Requirements

- Node.js compatible with the installed Vite/Electron toolchain (Node 22.12+ is recommended; the project has also been developed with a newer Node release).
- npm. Optional project previews may additionally need pnpm, Yarn, or Bun to match the opened project.
- Windows or macOS for the configured desktop packaging targets. The development UI can also run in a browser.
- A Gemini, Groq, or custom-endpoint API key. The beta is BYOK-only: without a valid provider key, AI requests are refused.
- A Supabase project with Google auth enabled for anyone building or running the app from source. Without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at build time, the app opens on "sign-in is not configured" and cannot be used.

Native dependencies such as `node-pty` may need platform build tools during installation. Windows native builds generally need Python, Visual Studio C++ Build Tools, and a Windows SDK. macOS native builds require the Apple command-line build tools. Package downloads require network access.

## Get started

Beta testers: download the installer from `https://shadrox.cyou` (or directly from `https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-Setup.exe`), accept the SmartScreen prompt ("More info" → "Run anyway"), launch ShadRox, continue with Google, open a folder, and paste a Gemini or Groq key in Settings → Models & Keys. Downloading requires no account; using the app does.

From the repository root, for development:

```sh
npm install
npm run dev:desktop
```

This starts the local API/Vite server and opens the Electron app. To run only the browser development server:

```sh
npm run dev
```

Copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` so sign-in works in development. Add the shared-key variables only if you are developing the gated operator path (`SHADROX_ALLOW_SHARED_KEY=1` alongside provider keys) or need to change the local server port. `VITE_*` values are compiled into the renderer at build time, so a desktop installer built without them will open on the unconfigured sign-in screen. Beta testers do not need a `.env`; they add their own provider key in the app. Keep `.env` private and never commit real keys.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Express/Vite development server. |
| `npm run dev:desktop` | Start the server and Electron desktop shell together. |
| `npm run build` | Build the renderer into `dist/`; this does not create an installer. |
| `npm run typecheck` | Run TypeScript type checking through the `typescript-legacy` compiler (the `typescript` package is the native 7.x port and its CLI does not check types). |
| `npm test` | Run the Node test suite (300 tests): workspace, preview and preview-runtime modules, the preview source bridge, desktop trust and git-hardening predicates, the terminal mode/shell/environment resolver, the updater lifecycle, the TypeScript language service and its IPC boundary, the PKCE auth core, provider key-format diagnostics, SSE decoding, context budgeting and system-context degradation, BM25 retrieval and the hybrid embedding seam, the markdown renderer, per-workspace chat-history persistence, the patch engine including the whole-file rewrite guard, atomic apply planning and rollback narration, the checkpoint timeline model, the static change verifier, the stream-snapshot lifecycle, FIM postprocessing and cache behavior, quick edit, commit context, AI access policy including the shared-key lockdown, the provider adapters including Groq's OTPM/TPM retry path, the custom endpoint (URL policy in both deployments, streaming, the no-`temperature` retry, model listing), and every desktop/preload boundary. |
| `npm run build:desktop` | Build and package the desktop app through the staging script. |
| `npm run dist:win` | Request a Windows NSIS installer (no publishing). |
| `npm run release:win` | Build the Windows installer and publish it plus `latest.yml` to GitHub Releases, which is what the in-app updater reads. Needs `GH_TOKEN` with `repo` scope. |
| `npm run dist:mac` | Request a macOS DMG. |

The packaging script stages the backend by walking the import graph from `server.ts`, so the API layer's `src/lib` runtime modules ship automatically; a 0.3.5 build shipped only one of them and the packaged app died at launch with `ERR_MODULE_NOT_FOUND`. Do not reintroduce a hand-maintained file list. Installer generation is still experimental and must be validated on the target OS before distributing it. A renderer build or passing unit tests alone does not prove that the packaged app installs, launches, updates, or works on a clean beta tester machine. The script uses `dist_staging/` and writes artifacts to `dist_desktop/`; do not assume an old artifact reflects the latest source.

`dist_desktop/` lives inside OneDrive on the development machine, and OneDrive can keep an open handle on a produced `.asar` long after the build exits; the next run then aborts with `EBUSY: resource busy or locked, unlink 'dist_desktop\win-unpacked.tmp\resources\default_app.asar'`. Set `SHADROX_OUTPUT_DIR` to an unsynced directory for that build (e.g. `SHADROX_OUTPUT_DIR=C:/Users/<you>/shadrox-build npm run dist:win`) and copy the artifacts back afterwards.

## Beta scope

The beta is ten known testers on their own machines, not a public launch. Two decisions follow from that and are deliberate, not oversights:

- **BYOK-only.** Every AI feature requires a real provider key in Settings. `api/ai/_access.ts` refuses the shared-key fallback unless `SHADROX_ALLOW_SHARED_KEY=1` is set, `src/lib/sharedKeyPolicy.ts` locks the "Use ShadRox Shared Key" control, and `useByok` ignores any stale persisted flag — so a request crafted in devtools still cannot spend an operator key. The shared-key code, spend guard, and Pro-tier rules stay complete so the launch is a config flip, not a rewrite.
- **Sign-in is compulsory.** Every tester signs in with Google before the workspace appears. The account row is the smoke-test for the auth path, gives testers a stable identity for bug reports, and leaves room for entitlement enforcement later. It is not a paywall: paid tiers are visible but locked in the beta (`PLANS_LOCKED`), there is no live billing, and the Supabase free tier is enough for ten testers.
- **No code signing certificate.** Signing costs money the beta does not justify. Unsigned NSIS builds trigger Windows SmartScreen ("More info" → "Run anyway") and Electron's own updater cannot verify a publisher, so updates ship only to testers who already trust the source. Buying a certificate is a launch task, not a beta task.

## Automatic updates and releases

The packaged app checks `iamsouravmourya-jpg/ShadRox` GitHub Releases 15 seconds after launch and every six hours, downloads a newer build silently, and then asks once to restart. A failed check — offline, blocked network, API rate limit — is logged and never shown. Settings → Models & Keys has an "Automatic updates" card with the current state and a manual "Check now".

How a new version reaches testers without them downloading anything again:

1. Bump `version` in `package.json` (0.0.1 → 0.0.2) and update `APP_VERSION` in `landing/lib/download.ts` so the site names the new build.
2. Build and publish with `GH_TOKEN=<token with repo scope> npm run release:win`. This also uploads `latest.yml` next to `ShadRox-Setup.exe`; electron-updater reads both.
3. Existing installs see the newer `latest.yml`, download `ShadRox-Setup.exe` in the background, and install it on restart or quit. The landing page keeps working without a change because `/releases/latest/download/ShadRox-Setup.exe` always resolves to the newest release.
4. Testers who never installed before simply download from the landing page and get that same newest build.

`npm run dist:win` builds the same artifacts without publishing them, which is what you use to test an installer locally. Publishing a release makes the installer and `latest.yml` downloadable by anyone who knows the repository URL, which is the trade-off of using GitHub Releases as the update feed while the repository stays public.

The version reset is safe because no 0.3.x release was ever published. electron-updater refuses to downgrade, so a machine that had installed a published 0.3.8 could not move to 0.0.1; testers are installing 0.0.1 fresh. From 0.0.1 onward, normal increments apply.

Replacing an asset in place is the exception, not the update path. The 0.0.1 installer was rebuilt on 2026-10-29 and uploaded over the same release to fix the sign-in failure, so the version did not change. electron-updater only moves to a *higher* version, so a copy installed from the earlier upload stays on the broken build until it is reinstalled from `ShadRox-Setup.exe`. Fixes that must reach existing installs need a version bump; an in-place replacement only helps new downloads.

## Configuration

### Environment variables

| Variable | Where it goes | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Local `.env` before any desktop build; CI/secret store if you build installers there | Supabase project URL used by the app's sign-in client. Compiled into the renderer at build time. |
| `VITE_SUPABASE_ANON_KEY` | Same as above | Public anon key used for Google OAuth and the profile request. Safe to ship; RLS protects the data. |
| `SHADROX_ALLOW_SHARED_KEY` | Vercel (and local `.env` for the Express server) | Master switch for the operator's shared AI key. Leave unset for the BYOK-only beta. |
| `GEMINI_API_KEY` / `GROQ_API_KEY` | Vercel (and local `.env`) | Optional operator-shared keys. Unused while the master switch is off. |
| `PORT` | Local `.env` only | Local Express/Vite port. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel | Only needed if a web account surface is added to the landing page. The current landing page is informational and does not sign anyone in. |

Vercel therefore needs **no new variables for the current beta**: the landing page downloads are plain links and the desktop app talks to Supabase directly. Add the two `NEXT_PUBLIC_*` keys only when the website itself gets sign-in. Never put the Supabase `service_role` key in Vercel's public variables, the desktop app, or the landing page.

`.env.example` documents the shared-key master switch (`SHADROX_ALLOW_SHARED_KEY`), the optional server-side shared provider keys, the Supabase values, and `PORT`. Supported provider IDs are `gemini`, `groq`, and `custom`. For BYOK, users enter their own key in Settings. The app's available-model list is based on the provider response plus the local model catalog; actual model access and cost are controlled by the provider account.

The API routes currently mounted by the local server include:

- `GET /api/health`
- `POST /api/byok/validate`
- `POST /api/ai/chat`
- `POST /api/ai/fim`
- `POST /api/ai/commit-message`
- `POST /api/prompt/refine`
- `POST /api/github/validate`
- `POST /api/github/create-repo`
- `POST /api/github/push`

Shared keys are off by default and gated behind `SHADROX_ALLOW_SHARED_KEY=1` (see **Beta scope**). Their use is not a user authentication system, and this codebase does not currently enforce account entitlements or billing for the UI's plan labels.

## Release notes

### 0.0.2 — safe apply, self-healing, conflicts, preview CSP

The first build after 0.0.1, and the first to include the code-intelligence line. This installer is built locally and unsigned; it has not been published to GitHub Releases.

- **Code intelligence.** TypeScript diagnostics, go-to-definition, the outline, and workspace symbol search run inside the desktop app through a worker-backed language service, using the editor's unsaved content. See **Code intelligence** for the architecture and the current gaps.
- **Atomic multi-file apply.** A multi-patch reply is planned in memory first; one unresolvable file blocks the whole set instead of applying a partial edit. Desktop applies stage as one transaction, and a commit that fails part-way restores the files it already wrote.
- **Pre-apply verification gate.** Resolved changes are parsed before writing (TS/JS syntax, JSON/JSONC, CSS brace balance, HTML closure) and reported by file and line. Static only — the change set is never executed.
- **Checkpoint timeline.** A slider in the chat header lists the conversation's file checkpoints with time, label and file count, and restores one behind a confirm.
- **Hybrid local retrieval seam.** BM25 retrieval is still the default; a local transformer embedder can re-rank the top candidates, and any embedding failure falls back to the lexical result. The model package is not installed and the async path is not wired into chat yet.
- **Preview click-to-source.** Clicking an element in a served static page opens the editor at its source line. Applies to `shadrox-preview://` pages only, not dev-server projects.
- **Self-healing applies.** After a change set lands, `Cannot find name` errors that resolve to exactly one workspace export are fixed by inserting the import locally, with no model call. Remaining newly introduced type errors appear as a one-click **Fix N type errors** action on that reply; it sends one bounded SEARCH/REPLACE request and never repeats itself.
- **Conflict banner.** A file with merge markers shows Ours / Theirs / Both in the editor, resolves the file, and saves it through the normal transactional writer; git's unmerged path count is read through the same hardened read-only bridge.
- **CSP meta strip for previews.** A served static page's own `Content-Security-Policy` meta tag is removed before the source bridge is injected, so pages that frame-block themselves can still render locally.

Not in this build: dual-project monorepo preview, semantic retrieval wired into chat (the BM25 path is still what runs), and per-hunk mixed conflict resolution.

**0.0.2 rebuild.** The first 0.0.2 installer failed a real smoke test on three separate folders. These are the fixes, folded into the same version number rather than bumped:

- **Phantom `Cannot find name 'Math'` errors.** electron-builder strips every `*.d.ts` out of the packaged app, and that exclusion is applied after the `files` patterns, so the language service shipped without its own default library declarations. An installed build reported 51 errors on a folder that showed 2 in development. The TypeScript libs now ride along through `build.extraResources` (`resources/ts-libs`), which is not filtered, and `resolveLibDirectory` prefers that copy whenever it exists. Verified against the rebuilt installer: `app.asar` contains `typescript-legacy/lib` with **0** `.d.ts` files anywhere in the archive, `resources/ts-libs` carries **102**, and a real language-service session pointed at the packaged `resources` directory reports **0** diagnostics for a file using `Math`, `document`, `Map` and `globalThis`.
- **`'bun.cmd' is not recognized`.** Package-manager detection trusted a `bun.lock`/`bun.lockb` file without checking that the executable is installed, so an npm project with a stray Bun lockfile could never start. Detection now requires the command to exist on `PATH` (with `PATHEXT` handled on Windows) and falls back through pnpm → Yarn → Bun → npm; when the chosen manager is genuinely missing, the preview reports what to install instead of dying in a shell.
- **"0 FILES" on every fresh open.** A folder's editor buffers are empty until a tab opens, so the titlebar and the hub card counted buffers. They now show the explorer-visible file count on disk (capped, and displayed as `5000+` when the cap is hit), while a single-file workspace keeps counting its buffers.
- **Key format errors now name the credential.** A Google sign-in token (`AQ.…`/`ya29.…`) pasted into the Gemini field got "expected prefix AIza", which is true but useless. The message now says it is an OAuth sign-in token that the Gemini API rejects, and points at AI Studio's *Create API key*. Wrong-vendor keys (`sk-`, `xai-`, `gsk_`, `AIza` in the Groq field) are each identified. The pasted value is never echoed back.
- **Two terminal tabs.** See **Terminal and command execution**. The terminal also opens for single-file workspaces now.

**Installed-app verification pass.** The rebuilt installer was run and driven on three real folders plus a single standalone file; the results are in `test-reports/0.0.2-2026-10-31/`. It confirmed the fixes above (the phantom-lib count went from 51 to 0 in the UI, the titlebar counts read `1 FILE` / `17 FILES` / `219 FILES`, and both terminal tabs behave as designed) and found six more defects, now fixed:

- **Folder workspaces showed an empty explorer.** `src/components/CodeEditor.tsx` built the tree from open editor buffers, which are empty for a lazily mounted folder, so the "No matching files" branch always won before the native directory listing was consulted. A 219-file project opened to a blank sidebar. The native page tree is now the first branch.
- **Solution-style `tsconfig.json` produced 393 invented errors.** `npm create vite` writes a root config that owns no files and only references `tsconfig.app.json`. Reading the root alone made the service fall back to a raw directory walk, discarding the referenced project's `paths`, `include` and `exclude`. Project references are now followed, which brings the same folder to **92** diagnostics — an exact per-code match with `tsc --noEmit -p tsconfig.app.json`.
- **Installed packages reported as `Cannot find module`.** The 2 MiB script cap was also applied to dependency type declarations, and `lucide-react`'s is 2,264,142 bytes, so a clean Next.js folder showed two TS2307 errors that `tsc` does not. Declaration files now get their own `MAX_DECLARATION_BYTES` (32 MiB); that folder goes 2 → **0** diagnostics.
- **The AI terminal leaked camelCase credentials.** `SECRET_ENV_PATTERN` needed an underscore or start-of-string boundary, so `Get-ChildItem env:` inside the assistant's shell printed `Geminiapikey` while `VITE_SUPABASE_ANON_KEY` was correctly stripped. Matching is now per word, with `_`, punctuation and camelCase transitions all treated as breaks. Over-scrubbing costs the agent one variable; under-scrubbing puts a key in a transcript.
- **Typed edits never reached the workspace, so they could not be saved.** `CodeEditor` shows a document with `files[activeFileIndex] ?? files[0]`, but every keystroke is written to `files[activeFileIndex]`, and mounting leaves that index at `-1`. The text landed in the CodeMirror document and nowhere else: no dirty dot, Save stayed disabled, auto-save had nothing to flush, Ctrl+S was a no-op, and the edit disappeared on the next open. This hit every single-file workspace and every reopen from "Recently opened"; folder workspaces hid it because clicking a file in the explorer sets the index. Both sides now resolve the index through one function, `src/lib/activeFile.ts`, so they cannot drift apart again.
- **A loose file was drawn inside a folder named after itself.** Opening `Desktop/form.html` put a folder row `form.html` above a file row `form.html` in the explorer, which reads like the app invented a directory. `renderFolder` always drew a root header labelled with the workspace name, and a single-file mount names the workspace after the file (`useWorkspace.ts:345`). The editor now receives the workspace `kind` and renders loose files flat; folder workspaces keep the tree.

Re-installed and re-checked: the explorer now draws the native tree for a folder workspace, the header pill reads **92 errors** on the Vite scaffold where it read 393, and the packaged `ts-service.cjs` / `terminal-modes.cjs` are byte-identical to the tested sources (`resources/ts-libs` still 102 `.d.ts`, asar still 0). The credential-scrub fix is proven by unit test, not yet re-driven in the installed terminal tab.

The single-file pass (`open-files.txt`) is where defect E surfaced. The "no preview for a lone HTML file" finding turned out to be the same bug wearing a different hat: `resolvePreviewDocument` renders the live buffer only when an active file exists, so defect E also killed Preview and the "Active file: None selected" label. It is recorded as a symptom, not a second defect. Still open from that pass: an AI edit request in Code mode returned prose instead of a patch card, with the banner "Context window is full for allam-2-7b: 1 retrieved chunk(s) dropped + 1 file excerpt(s) shortened" — a small-context model asking for a path it already had mounted is both a model-choice problem and a product defect, so the apply-to-disk path on a single file is still unverified.

Still needs a human: re-drive the single-file flow on the rebuild (edit → save → reopen), the git panel, and one look at the AI terminal tab to confirm `Geminiapikey` is gone — during this pass the AI pill did not respond to two clicks at its centre, which is unexplained.

**0.0.2, third build (explorer + custom endpoint).** Two things went in after that pass, then the installer was rebuilt in place again: the loose-file fix above (its visual re-check is still owed), and the third BYOK option — a **Custom endpoint** provider (`id: 'custom'`) that takes any OpenAI-compatible base URL plus a key, with presets for OpenRouter, DeepSeek, xAI, Together, Fireworks, Mistral, Cerebras, SiliconFlow, GitHub Models, Groq's compatible endpoint, Ollama and LM Studio, a free-text URL for credit gateways that are not on that list, and a "Model ids" field for endpoints that do not serve `/models`. Plumbing it through meant closing every server route that used to *silently reroute* an unknown provider to Gemini — `api/ai/chat.ts`, `api/ai/fim.ts`, `api/ai/commit-message.ts`, `api/byok/validate.ts`, `api/prompt/refine.ts` now share `parseProviderId`, which keeps the historic default when `provider` is absent and returns a 400 when it is present but unknown. `api/ai/_endpoint.ts` splits its URL policy by deployment: a loopback backend (`server.ts`, which is what the desktop app runs in-process) accepts any addressable endpoint, while the Vercel functions — an open proxy by construction — still refuse private and metadata addresses.

That rebuild also caught a stale artifact: `scripts/package-desktop.js` runs `npm run build` first, so a renderer string edited after that compile is not in the archive. The first attempt packaged a bundle that still held the old model-picker copy, so it was stopped, the working tree was re-verified (`npm run typecheck` clean, `npm test` → 289/289) and rebuilt. Checked inside the produced `app.asar`: the renderer chunk carries the custom-provider UI, the endpoint presets and the corrected picker copy; `parseProviderId` is in all three routes, `resolveCustomEndpoint` in the endpoint resolver and the validator, `SHADROX_LOCAL_BACKEND` in `_endpoint.ts` and `server.ts`; and the `*.d.ts` invariant from the first 0.0.2 fix still holds — **0** in the archive, **102** in `resources/ts-libs`. Not yet driven in the installed app: the Custom endpoint against a real gateway, and the flat loose-file explorer.

**0.0.2, fourth build (a folder with no open tabs is finally a context).** Driven by a real failure: `lernexai-saas` (219 files) opened with zero tabs, and the assistant reported that it had received "no repo map, no file names, no excerpts — only three `[status]` preview lines". It was right. A folder mount loads no buffers, so the prompt carried only the files the user happened to have open, and the titlebar's file count described a set the model had never seen. Three changes, in the order they now apply to every request:

- `electron/workspace.cjs` replaced its counting walk with `listWorkspaceFiles`, which returns the actual on-disk tree (dotfiles, symlinks and generated directories excluded, sorted deterministically so the stable prompt prefix stays cacheable) and reports truncation at 5000 files. `openFolder` still returns `files: []` — the lazy mount is unchanged and nothing is bulk-read at open.
- `buildFileTreeMap` (`src/lib/retrieval.ts`) turns that tree into a path inventory grouped one directory per line, shallow-first, budgeted at 9000 chars, and honest about what it dropped. The per-directory name cap is depth-aware (root 48, one-deep 16, leaves 8) because a model that was never shown a file name cannot ask for it — the first live run proved exactly that on six root files.
- `src/lib/contextCandidates.ts` picks up to 12 files to read from disk for the request (manifests and entry points first, shallowest match wins, then ranked name matches, then a shallow-readable fallback so the set is never empty by construction), and `buildSystemContext` is now async: it reads those files through the desktop bridge, retrieves over tabs *plus* disk reads, and states the split in the protocol — a path-only file must never be quoted as `ORIGINAL` text, because SEARCH/REPLACE needs bytes the model was not given. Runtime logs are labelled `IDE RUNTIME OUTPUT` so they cannot masquerade as project source, and a workspace with genuinely nothing attached now says so instead of letting the model guess.

Re-run in the app on the same folder, still with no tab open: the model listed 207 mapped paths, quoted `server.ts:1443` verbatim, distinguished verified facts from assumptions, and asked for the specific files it had not been given. That pass also surfaced two presentation defects of my own, both fixed here. The chat renderer only understood whole lines, so `**bold**`, inline code and every markdown table reached the user as raw markup — an answer that was correct looked broken, which is worse than a wrong answer. `src/lib/markdown.tsx` now parses inline runs, tables, and numbered lists (`parseInline`/`parseMarkdownBlocks` are exported and tested; no HTML is ever emitted, and a link is only a link when it starts with `http(s)`). And the system prompt had one weak line about conciseness against a model that produced a 15k-token report, so `App.tsx` now carries explicit length and writing-style rules — one language per reply, one idea per sentence, each fact stated once, caveats on their own line instead of nested in brackets.

**Chat history survives closing the folder.** It never did: `messages` lived only in React state, and the one thing written to storage was the interrupted-stream snapshot in `sessionStorage`, which exists to resume a reply cut off mid-token and is deleted whenever nothing is interrupted. So an ordinary, finished conversation was erased by closing the folder — the user loses exactly what he paid tokens for. `src/lib/chatHistory.ts` stores one transcript per workspace under the same stable `kind-path` id the workspace and recents already use, and `App.tsx` restores it when that workspace mounts and writes it when the transcript settles (never mid-stream, which would serialise the whole conversation per chunk). It is deliberately lossy at the edges, because localStorage is shared and ~5 MB: the newest 80 turns, the 12 most recent workspaces, an oversized base64 screenshot dropped rather than the text around it, and on a quota failure the oldest conversation evicted instead of the newest answer lost. "New chat" clears the stored transcript too, otherwise the discarded conversation would come back on the next workspace switch.

`npm test` → **300/300**, `npm run build` clean. Two known-side effects, disclosed rather than discovered later: every request now carries roughly 2–10k more input tokens (the map plus the disk reads), and the titlebar count can drop because build output directories (`dist_staging`, `dist_desktop`) left the walk. Verified by driving the running dev build, not by the packaged installer — the installer rebuild and publish are still owed, and the token count in the message footer is `usage.total_tokens`, i.e. input + output together, which is why a one-line answer can read `9086 tok`; splitting that per-request is the open cost-meter item.

**Published as `v0.0.2`.** That rebuild happened: `SHADROX_OUTPUT_DIR=C:/Users/sourav/shadrox-build npm run dist:win` (outside OneDrive, so the `EBUSY` trap stays shut) → 137,112,058-byte `ShadRox-Setup.exe`, verified inside the archive by string probes for `shadrox.chat.history`, `WRITING STYLE RULES`, `border-collapse` and `(root)`, and the `.d.ts` invariant still holds (0 in the asar, 102 in `resources/ts-libs`). GitHub release `v0.0.2` now carries the installer, its blockmap and `latest.yml`, and is the site's **Latest**, so `releases/latest/download/ShadRox-Setup.exe` — the only URL the landing page uses — serves this build without any code change; `www.shadrox.cyou` re-deployed off the push and prints 0.0.2. Because the version number stayed 0.0.2, `electron-updater` will not offer this build to anyone who already has it: re-running the installer is still the only path, which is what the release notes say.

One shipping detail worth remembering: **GitHub push protection blocks the push, not the secret.** Two fixtures in `src/lib/providerKeys.test.ts` — a 39-character `AIza…` string and an `AQ.…` OAuth token, both invented — were flagged as a leaked "GCP API Key Bound to a Service Account". A fake credential shaped like a real one is indistinguishable to the scanner, so the fixtures are now shorter than the real format (`AIza-TEST-KEY-FORMAT-ONLY`, `AQ.EXAMPLE-SIGN-IN-TOKEN-NOT-REAL`); the classifiers only ever read prefixes, so all four tests still pass. Since the finding lives in the commit's tree, the fix had to be amended into the unpushed commit — a follow-up commit would have kept the flagged blob reachable and the push would have been rejected again.

### 0.0.1 — accounts, Google sign-in, direct download
The beta now starts with an account and a real download link. Versioning restarts here as 0.0.1; every later release increments the last number.

- **Google sign-in on first launch.** A new first screen blocks the workspace until the user continues with Google. The app opens the system browser, completes the OAuth PKCE flow on a loopback listener, and returns with a session; no password is created.
- **Server-side profile.** Supabase stores the auth identity plus one `public.profiles` row per user (email, name, avatar URL, provider, app version, platform). RLS limits every read and write to the signed-in user. Provider API keys and project files never reach Supabase.
- **Encrypted session.** The refresh token and PKCE verifier live in the OS-encrypted store, not `localStorage`; sign-in state survives restarts, tokens refresh before expiry, and sign-out revokes the session.
- **Account UI.** The hub and Settings show the signed-in email/avatar with a sign-out action, so switching accounts does not require reinstalling.
- **Direct download.** `shadrox.cyou` now links to the latest GitHub release asset, `ShadRox-Setup.exe`, with no form or approval. The asset name is version-free, so the link is stable across releases.
- **Automatic updates from 0.0.1.** Every release publishes `latest.yml`; installed copies update in the background and apply on restart.
- **Sign-in is validated by PKCE, not `state`.** Supabase replaces a client-supplied OAuth `state` with its own value, so a callback comparison could never match. Validation is PKCE-only: the verifier stays in the app, and the loopback listener exists for a single sign-in.
- **The app takes the foreground after sign-in.** As soon as the loopback callback arrives, the main process restores, shows, and focuses the window; the browser tab says "ShadRox is opening now" and can be closed.

### 0.3.8 — chat actually edits your files

Four defects found on real testers' machines:

- **AI edits now reach disk.** Accepted/applied patches used to stop at the editor buffer; disk write-back was a separate opt-in auto-save, so a reply could be marked applied while the file never changed. Every apply and undo now flushes through `workspace.saveFiles()` and the review card reports **Saved to disk** or **Applied in editor** with the reason.
- **No more whole-file wipes.** The edit prompt used to demand the complete file, which small free models answered with a four-line fragment that replaced (and deleted) the rest. The prompt now requires SEARCH/REPLACE for existing files, and auto-apply refuses a rewrite that drops most of a file (`assessRewriteRisk`) — an explicit Accept still overrides it.
- **One permission prompt, at folder-open time.** The browser build now requests read-write access in the same gesture that opens or reopens the folder, and stores the folder handle, so saves never prompt mid-chat. In the desktop app, edits are saved immediately, which also removes the mid-session "unsaved changes" dialogs.
- **Groq free-tier limits are handled.** `Request too large … OTPM: Limit 1000, Requested 2048` and `TPM: Limit 2000, Requested 6837` came from Groq billing a model's default 2048-token output ceiling against a small per-minute quota. The adapter now reads the limit from the error, retries once with a smaller output ceiling and a trimmed prompt, and otherwise explains which model to pick instead of showing a raw upstream string.

## Current limitations and beta checklist

- Google sign-in is required, but there is still no live billing, no subscription enforcement (paid tiers are shown but locked — `PLANS_LOCKED`), no hosted AI spend for unentitled accounts, and no cloud project sync. The Starter/Pro credit meter is client-side only and not enforced against the API.
- Sign-in needs the loopback port `51789` to be free. If another program holds it, the app reports the conflict instead of hanging; close that program and retry.
- The profile table records the email and name from Google. Testers who want their row removed must ask the operator to delete the Supabase user.
- Browser mode has no OS credential store, so provider keys there sit in `localStorage`. The desktop build keeps them in the encrypted store and in memory only.
- AI features need internet access and send the request context to the chosen external provider.
- Free provider tiers (especially Groq) enforce per-minute token limits well below the model's context window; 0.3.8 shrinks and retries, but a very small limit can still refuse a long conversation.
- Preview support is limited to static sites and detected Node scripts; embedded-app restrictions can still prevent rendering.
- Code intelligence covers TypeScript/JavaScript files only, is capped at 2,000 project files, and has no rename, quick-fix, or find-references UI yet. It has been typechecked, unit-tested, and bundled, but the Electron UI has not yet been exercised live; run an app smoke test before shipping an installer.
- The change verification gate is static: it catches syntax and parse failures, not type errors, runtime bugs, or a semantically wrong edit. It also runs only for desktop folder workspaces; in the browser build the same apply path has no verification step.
- Transactional apply is best-effort at the OS level. ShadRox stages writes and restores previously written files when a later file fails, but a crash mid-commit can still leave a partially written set on disk. If a failed apply created a new file, its editor buffer is left open (marked failed) so it is not silently lost.
- Semantic retrieval ships as a seam only: `@huggingface/transformers` is not a dependency, so chat still runs the BM25 path, and the semantic path has not been exercised against a real model.
- The checkpoint timeline, the verification gate, atomic apply, and preview click-to-source have been typechecked, unit-tested, and bundled, but not yet exercised in a live Electron session; smoke-test them before shipping an installer.
- Auto-import only searches files that are currently loaded into the workspace. If the exporting file was never opened, the missing name is left for the one-click fix instead of being guessed.
- The **Fix N type errors** action spends the user's provider key and runs once per press; it does not loop until the project is clean, and it is never triggered automatically.
- The conflict banner resolves the whole file with one choice (Ours, Theirs, or Both). Per-hunk mixed resolution is not built yet, and the base stage is read but not displayed.
- Running a monorepo's frontend and backend previews at the same time is not implemented; preview still runs one project at a time and the user switches by starting another.
- Interactive terminal commands run with the operating-system user's permissions.
- The installer is unsigned, so Windows SmartScreen shows "More info → Run anyway" on first launch.
- Before inviting external testers, test install/launch/uninstall on a clean machine, confirm terminal and preview permissions, check provider-key handling, and provide a channel for bug reports.

## License

This repository is source-visible under the proprietary terms in [`LICENSE`](LICENSE). Viewing the source does not grant permission to copy, modify, distribute, or use it to create derivative products. Third-party packages retain their own licenses.
