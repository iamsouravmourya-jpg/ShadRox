# ShadRox

**Native desktop AI engineering workspace for local codebases.**

ShadRox pairs a React + TypeScript IDE with an Electron shell. Open a local folder through a native dialog, edit files with direct disk write-back, chat with Gemini or Groq models using your own API keys (BYOK) or the optional ShadRox shared key, run approved terminal commands, and preview static sites or local JavaScript/TypeScript web projects inside the app.

> **Preview scope:** ShadRox previews static websites and Node-based web projects that expose a `dev` or `start` package script. It is not a universal runtime for every framework, backend, or project layout. See the [preview support matrix](#preview-support-matrix).

---

## Highlights

- **Desktop-native workspace:** Native folder and file dialogs, scoped filesystem access, direct write-back, workspace snapshots, and ZIP export.
- **Focused code editor:** CodeMirror 6 with syntax highlighting for common languages, in-file search, formatting, clipboard copy, dirty-state indicators, and a vertical file explorer.
- **AI chat with engineering modes:** **Code** for direct patches, **Plan** for read-only architecture, and **Complex** for multi-file reasoning, with streaming responses and one-click checkpoint restore. Speech input is fixed to `en-US`.
- **Local preview built into the IDE:** Static sites stream through an internal protocol; runnable npm projects start their own dev server after approval. Both render inside a resizable preview pane with a console drawer, desktop/tablet/mobile widths, reload, and stop controls.
- **Bring Your Own Key:** Validate and use Gemini or Groq keys without ShadRox persisting them server-side. The optional shared key powers Pro-tier models.
- **Security-first desktop bridge:** `contextIsolation`, renderer sandboxing, no Node integration, allow-listed IPC, path containment checks, and confirmed shell commands.
- **Windows and macOS packaging:** Electron Builder produces an NSIS installer on Windows and a DMG on macOS.

---

## Local Preview

Preview has three paths, selected automatically by the workspace contents:

| Path | How it works | When it is used |
| :--- | :--- | :--- |
| **Static protocol** | Files are streamed through `shadrox-preview://<workspace-uuid>/...` by the Electron main process. No HTTP server is started. | A folder has no runnable `dev`/`start` package script, or the project is a static site. |
| **Local project server** | ShadRox starts the project's own `dev` or `start` command, waits for it to print a localhost URL, and loads that URL in the preview iframe. | A `package.json` provides a runnable `dev` or `start` script and the user approves the run. |
| **In-browser bundle** | `esbuild-wasm` compiles open files into a virtual document rendered with `srcDoc`. Used mainly outside the desktop folder flow. | Browser mode or open-file previews without a folder workspace. |

### Static protocol

Static preview is implemented in `electron/main.cjs` and is intentionally independent of any local web server:

- The protocol URL uses the workspace's random UUID as its host, for example `shadrox-preview://8d43d1db-d17a-4034-ad4b-dfc528f513a9/index.html`. The workspace ID is generated when a folder is opened.
- Files are resolved against the opened folder and streamed with `fs.createReadStream`; large assets are not buffered into memory.
- Resolution order: exact file, directory `index.html`, then the same path inside `dist`, `build`, `out`, and `public`, then a SPA `index.html` fallback for requests that accept HTML. A missing `favicon.ico` returns `204`.
- Directory requests without a trailing slash receive a `308` redirect to the slash-terminated URL.
- Responses include `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- `GET`, `HEAD`, and `OPTIONS` are supported. `HEAD` returns headers without a body; single byte ranges return `206`, unsatisfiable ranges return `416`, and other methods return `405`.
- Path safety: percent-decoding is validated, NUL/backslash/Windows-colon characters and dot segments are rejected, resolved paths must stay inside the workspace root after `realpath`, and only regular files are served.

**Windows GPU note:** On Windows, ShadRox disables hardware acceleration and uses software rendering for the preview surface to avoid AMD driver crashes (`0x80070057`). This is deliberate; enabling GPU compositing may reintroduce driver instability on affected systems.

### Runnable projects

For JavaScript/TypeScript web projects, ShadRox manages the project's own development server:

1. The workspace root and up to three nested folders are scanned for a `package.json` with a `dev` or `start` script. Generated folders such as `node_modules`, `dist`, `build`, `.next`, and `coverage` are skipped.
2. The package manager is selected from the `packageManager` field or the `pnpm`/Yarn/Bun lockfiles, defaulting to npm.
3. If declared dependencies are missing, ShadRox asks for approval before installing them.
4. The approval card shows the project path, package manager, script name, exact command, and missing packages. The `package.json` hash is revalidated before execution.
5. The project is spawned with a sanitized environment; common dev servers are bound to `127.0.0.1` where supported.
6. ShadRox watches stdout/stderr for a `localhost`, `127.0.0.1`, `0.0.0.0`, or IPv6 loopback URL and loads the last URL that appears within 60 seconds.
7. Closing the preview, opening another workspace, or quitting the app stops the managed process (including its child process tree on Windows).

Server output, install logs, readiness messages, and preview console messages appear in the in-app Console.

### Preview support matrix

| Project type | Status | Notes |
| :--- | :--- | :--- |
| Static HTML/CSS/JS with an `index.html` | Supported | Entry can be at the workspace root, `public/`, `dist/`, `build/`, `out/`, or `src/`; assets resolve through the protocol. |
| Built single-page app with deployed assets | Supported | Client-side routes fall back to `index.html` only for HTML-accepting navigations. |
| npm project with a working `dev` or `start` script | Supported | Requires Node.js and the project's package manager. Vite, Next.js, Angular, and similar servers that print a loopback URL are the primary targets. |
| Projects that only expose `serve`, `preview`, or custom scripts | Limited | Automatic detection requires `dev` or `start`; open the specific project folder or add a supported script. |
| Python, Go, PHP, Java, .NET, or other non-Node backends | Not supported | These need dedicated runtime adapters. Built front-end output can still use static preview. |
| Servers that never print a localhost URL | Not supported | ShadRox times out after 60 seconds. |
| Workspaces containing multiple runnable apps | Limited | ShadRox asks you to open the intended project folder directly instead of guessing. |
| Servers with `X-Frame-Options`/`frame-ancestors` restrictions or self-signed HTTPS | Not guaranteed | The iframe may stay blank; there is no automatic framing diagnostic yet. |
| Downloads, fullscreen, clipboard, camera, or other privileged browser APIs | Restricted | The preview iframe is sandboxed and host permission requests are denied unless explicitly allowed by the app. |

Only one preview is shown at a time in the desktop UI. The main process can address multiple opened workspaces by UUID, but the current pane displays the active workspace's preview.

### Preview security boundaries

- The preview host is an unguessable per-open UUID. The older fixed `workspace` host alias is not accepted.
- A `session.webRequest` guard rejects preview-protocol requests that do not originate from the preview document itself or the trusted ShadRox renderer.
- Protocol responses are marked `no-referrer` so the workspace URL cannot leak through outbound `Referer` headers.
- The preview iframe runs with a sandbox that allows scripts, forms, modals, popups, and same-origin behavior while blocking top-level navigation.
- The local runtime server is not exposed by ShadRox; it is whatever loopback server the project starts. Approved project scripts are arbitrary code and run with the user's permissions.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ React renderer                                               │
│ Chat · Editor · Preview pane · Workspace and quota state     │
└───────────────────────────┬──────────────────────────────────┘
                            │ contextBridge allow-list
┌───────────────────────────▼──────────────────────────────────┐
│ Electron main process                                        │
│ Native dialogs · workspace/file I/O · preview protocol       │
│ project runtime · confirmed terminal commands · window       │
└───────────────────────────┬──────────────────────────────────┘
                            │ loopback HTTP
┌───────────────────────────▼──────────────────────────────────┐
│ Vite/Express backend (development)                           │
│ Bundled Express server on an ephemeral loopback port (prod)  │
│ AI chat · BYOK validation · prompt tools · GitHub endpoints  │
└──────────────────────────────────────────────────────────────┘
```

### Process responsibilities

- **Renderer (`src/`)**: React UI, chat streaming, file editing, workspace state, preview controls, and the in-browser bundler fallback. It has no Node.js access.
- **Preload (`electron/preload.cjs`)**: Exposes a frozen, allow-listed `window.shadroxDesktop` API for opening folders/files, saving files, running confirmed commands, and starting/stopping previews.
- **Main (`electron/main.cjs`)**: Owns native dialogs, filesystem access, the `shadrox-preview` protocol, the project runtime, IPC validation, and the packaged backend lifecycle.
- **Workspace (`electron/workspace.cjs`)**: Scans folders, builds file maps, enforces write boundaries, and rejects symlink escapes.
- **Preview runtime (`electron/preview-runtime.cjs`)**: Detects projects, installs missing dependencies after approval, spawns/stops servers, parses localhost URLs, and maps preview URLs back to workspace IDs.
- **Backend (`server.ts`, `api/`)**: Express API used both in development and by the packaged app on loopback. The same handlers are deployable as Vercel serverless functions.

### Key files

```text
electron/
  main.cjs                 Electron main process, preview protocol, IPC
  preload.cjs              Renderer bridge (allow-listed operations)
  workspace.cjs            Folder scanning and scoped file I/O
  preview-runtime.cjs      npm project detection and process lifecycle
  workspace.test.cjs       Filesystem boundary tests
  preview.test.mjs         Static preview and bundling tests
  preview-runtime.test.cjs Project runtime tests
src/
  App.tsx                  IDE shell, chat, preview state, checkpoints
  components/PreviewPane.tsx  Preview iframe, ResizeObserver, console, viewports
  components/ChatPanel.tsx    Chat UI, modes, approval cards
  components/CodeEditor.tsx   File explorer and CodeMirror editor
  components/SettingsDrawer.tsx BYOK, shared key, secrets, plans
  lib/desktop.ts           Typed desktop bridge contracts
  lib/bundler.ts           esbuild-wasm in-browser bundler
  lib/preview.ts           Document assembly and preview helpers
  lib/plans.ts             Plan metadata and monthly caps
  lib/quota.ts             Local monthly usage tracking
api/                       Serverless-compatible API handlers
server.ts                  Development and packaged Express server
```

---

## Getting Started

### Prerequisites

- **Node.js 22.12+** and npm for development and packaging.
- **Windows or macOS** for native installers. Build each platform's artifact on that platform.
- For project previews, the project's package manager (npm, pnpm, Yarn, or Bun) and its Node.js runtime must be installed on the machine.

### Install and run

```bash
npm install

# Optional: configure shared keys for the ShadRox backend
cp .env.example .env

# Browser development server
npm run dev

# Desktop shell plus the development server
npm run dev:desktop
```

The development server listens on `http://localhost:3000` by default (`PORT` overrides it). The packaged desktop app binds its backend to an ephemeral loopback port instead.

### Environment variables

All variables are optional. BYOK users do not need any server-side keys.

| Variable | Purpose |
| :--- | :--- |
| `SHADROX_GROQ_API_KEY` | Shared Groq key used when a request does not carry a BYOK key. |
| `GROQ_API_KEY` | Fallback for the shared Groq key. |
| `SHADROX_GEMINI_API_KEY` | Shared Gemini key used when a request does not carry a BYOK key. |
| `GEMINI_API_KEY` | Fallback for the shared Gemini key. |
| `PORT` | Development server port (default `3000`). |

### Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start the Vite/Express development server. |
| `npm run dev:desktop` | Run the development server and launch Electron against it. |
| `npm run build` | Build the renderer into `dist/`. |
| `npm run build:desktop` | Build the renderer and package the app for the current platform. |
| `npm run dist:win` | Build a Windows NSIS installer under `dist_desktop/`. |
| `npm run dist:mac` | Build a macOS DMG under `dist_desktop/` (run on macOS). |
| `npm start` | Start the production Express server serving `dist/`. |
| `npm run preview` | Preview the built renderer with Vite. |
| `npm test` | Run workspace, preview, and preview-runtime tests. |
| `npm run typecheck` | Type-check the project with `tsc --noEmit`. |

### Packaging

Electron Builder packages the renderer, Electron modules, API handlers, and server entry point; esbuild binaries are unpacked from the ASAR archive. In the packaged app, the backend starts on a random loopback port and serves the built renderer from the same origin. For browser-only deployment, `vercel.json` builds the Vite app and exposes the `api/` handlers as serverless functions.

---

## File Edit Protocol

The assistant proposes changes in fenced code blocks whose info string contains the workspace-relative path:

````tsx
```tsx path=src/components/Navbar.tsx
export function Navbar() {
  return <nav className="p-4 bg-neutral-900 text-white">ShadRox</nav>;
}
```
````

`extractFilePatches()` in `src/lib/markdown.tsx` extracts the block, validates the path against the real workspace, and patches the in-memory workspace. Before applying a reply, ShadRox creates a snapshot checkpoint so the workspace can be restored with one click.

- **Code mode** writes and patches files.
- **Plan mode** is read-only and cannot apply file changes.
- **Complex mode** is intended for deeper multi-file reasoning.

---

## Plans and Quotas

| Plan | Price | Monthly cap | Included |
| :--- | :--- | :--- | :--- |
| **Free (BYOK)** | ₹0 | 100 messages | Gemini and Groq with your own key, local workspaces, disk write-back, preview |
| **Pro** | ₹499/month | 250 messages | ShadRox shared key, fast-tier models, priority streaming, checkpoints |
| **Adv** | ₹1,099/month | 500 messages | Premium models, extended context, semantic retrieval, 50 restore checkpoints |
| **Enterprise** | Custom | 5,000 messages | Custom quotas, SSO, audit logs, SLA (per plan metadata) |

Prices include GST as displayed in the app. Plan metadata lives in `src/lib/plans.ts`. Monthly usage is tracked locally in `localStorage` (`shadrox.usage.*`); payment processing and server-side entitlement enforcement are not part of this repository yet.

---

## Security and Privacy

- **Renderer isolation:** `contextIsolation` and `sandbox` are enabled, `nodeIntegration` is disabled, and `webSecurity` remains on. The preload bridge exposes named operations only.
- **Scoped filesystem access:** Main-process reads and writes are limited to an opened workspace root. Traversal, hidden preview paths, and paths that resolve outside the root through symlinks or junctions are rejected.
- **Confirmed commands:** Every terminal command is shown in a native confirmation dialog with its working directory. Commands run with a timeout and bounded output.
- **Loopback backend:** The packaged app's HTTP server binds to `127.0.0.1` on an ephemeral port.
- **Preview isolation:** The static protocol uses an unguessable workspace host, a trusted-frame request guard, and `no-referrer` responses. Preview content is sandboxed.
- **BYOK privacy:** API keys are stored in local browser storage and sent directly to the stateless backend validation/chat endpoints. They are not written to server-side storage by ShadRox.
- **Secrets vault:** Named secrets are kept in local browser storage and injected into the bundler/runtime as `process.env.*` and `import.meta.env.*`. ShadRox does not write `.env` files to disk. Browser storage is not a hardware-backed secret store; treat it accordingly on shared machines.
- **No automatic code upload:** Workspace files are not uploaded as a repository. Only the context included in a chat request is sent to the configured AI provider.

---

## Testing

```bash
npm test
npm run typecheck
node --check electron/main.cjs
```

The automated suites cover:

- Workspace scanning, path normalization, traversal rejection, symlink escape prevention, and scoped writes.
- Static preview entry discovery, asset resolution, document assembly, sandboxing, and project runtime lifecycle.
- Project detection, package manager selection, dependency installation, localhost URL parsing, and process cleanup.

---

## License

Proprietary software. Copyright (c) 2026 Sourav Maurya. All rights reserved.

This repository is provided for viewing and reference only. Copying, modification, distribution, sublicensing, or commercial use requires prior written permission from the owner. See [LICENSE](LICENSE) for the full terms. `package.json` marks the package as `UNLICENSED`.
