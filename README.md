# ShadRox

**Native Desktop AI Software Engineering Workspace**

ShadRox combines a React + TypeScript workspace with an Electron desktop shell. Open local project folders through native dialogs, chat with AI models (Google Gemini & Groq), preview browser-side projects, and write edits back to disk through a narrow, context-isolated IPC bridge.

ShadRox brings a **Bring-Your-Own-Key (BYOK)** architecture: validate your own Gemini or Groq API keys locally with zero server persistence, or leverage the optional **ShadRox Shared Key** for instant access to Pro-tier models.

---

## Key Highlights

- **Native Disk Mount & Write-Back:** Electron's main process reads and writes the selected workspace with Node.js filesystem APIs. The renderer receives file contents through a narrow preload bridge; Node APIs are not exposed to page code.
- **Windows & macOS Packaging:** Build Windows NSIS installers (`.exe`) and macOS disk images (`.dmg`) with Electron Builder.
- **Confirmed Terminal Commands:** The desktop bridge can run a command in the opened folder only after a native confirmation dialog displays the exact command and working directory.
- **Universal Next-Gen SaaS Preview Engine:**
  - Auto-detects project stack: React SPA, Next.js SaaS, Vue, Svelte, Python/FastAPI, Go, Rust, or HTML5/Tailwind.
  - Interactive Live SaaS Product Sandbox: Automatically generates a functional SaaS dashboard with real-time KPI metrics, interactive health checks, and route navigation.
  - API Endpoint Inspector & Test Runner: Discovers API endpoints (`/api/v1/...`, `/auth`, `/billing`) with a live interactive tester for simulated HTTP requests and responses.
  - Interactive URL Bar (`https://localhost:3000/...`) for direct route testing.
  - Dockable DevTools Console: Real-time event bridge capturing `console.log`, `console.info`, and `console.error` logs.
  - Multi-Device Viewports: 1-click toggling between Desktop (100%), Tablet (768px), and Mobile (390px).
- **Two-Column Desktop IDE Layout:**
  - **Vertical File Explorer:** Left-hand sidebar with instant file filtering, new file creation, zero-dependency ZIP export, dirty status indicators, and active file highlights.
  - **Code Editor Pane:** Sits directly beside the file explorer with CodeMirror 6 syntax highlighting, in-file search, code formatter tool, 1-click clipboard copy, and full IDE status bar.
- **Streamlined Work Modes:**
  - **Code:** Fast, concise, directly writes and patches workspace files.
  - **Plan:** System architecture and review only — AI is strictly restricted from editing files.
  - **Complex:** Deep reasoning and multi-file architecture for complex logic.
- **Monthly Quota & Transparent Pricing:**
  - **Free (BYOK):** ₹0 — 100 messages / month cap.
  - **Pro Tier:** ₹499/month (GST Included) — 250 messages / month, ShadRox Shared Key.
  - **Adv Tier:** ₹1,099/month (GST Included) — 500 messages / month, extended context.
  - **Enterprise:** Custom — 5,000 messages / month cap.
  - Real-time visual quota tracking with calendar-month persistence and test reset controls.
- **Zero-Config Secure Secrets Vault:**
  - **No `.env` files are ever created on disk.**
  - Secrets are stored in encrypted browser storage and injected virtually into `process.env.*` and `import.meta.env.*` during bundling and runtime.
- **100% Pure English Copy:** All interface copy, system prompts, error handlers, and speech recognition (`en-US`) are strictly formatted in professional English.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│ React renderer                                             │
│ Chat · Editor · Preview · Workspace state                  │
└───────────────────┬────────────────────────────────────────┘
                    │ typed, allow-listed preload IPC
┌───────────────────▼────────────────────────────────────────┐
│ Electron main process                                       │
│ Native file dialogs · scoped filesystem writes · confirmed  │
│ terminal execution · loopback API proxy                     │
└─────────────────────────────────────────────────────────────┘
```

### 1. Workspace & Local Disk Access

In Electron, `electron/main.cjs` owns native dialogs and `fs`/`path` access. `electron/preload.cjs` exposes only open-folder, open-files, save-files, and confirmed-command operations; the renderer does not receive Node integration.
- Reads preserve workspace-relative names such as `src/components/Button.tsx`.
- Folder scans skip common generated directories, symlinks, and binary files; preview assets and text reads have size limits.
- Saves are restricted to the folder selected in the native dialog. New paths are normalized and checked against the workspace root; selected-file-only workspaces cannot create arbitrary files.
- Browser mode remains available and uses the File System Access API where supported.
- Workspace snapshots remain in IndexedDB for session restoration. After a full desktop restart, reopen the folder to re-establish the main-process write grant.

The packaged app starts the existing API handlers on a random loopback port and serves the built renderer from the same origin. Development continues to use the Vite/Express server.

### 2. Universal SaaS Preview Engine

Located in `src/components/PreviewPane.tsx` and `src/lib/preview.ts`:
- **React / TSX Bundling:** Powered by `esbuild-wasm` running in a virtual filesystem (`shadrox-vfs`). A virtual bootstrap resolves the selected entry through the same workspace resolver as local imports.
- **Dependency Resolution:** Workspace files, TypeScript path aliases, mounted assets, and CSS Modules are resolved at build time. Dependencies declared in `package.json` (plus the built-in React, React DOM, and Lucide fallbacks) are loaded through `esm.sh`; unmapped packages fail with a build error instead of a broken blank preview.
- **Tailwind CSS Injection:** Automatically includes Tailwind CDN in bundled and sandboxed HTML previews, ensuring full visual fidelity.
- **Interactive Sandbox & API Inspector:** When a full-stack SaaS project, Python backend, or API microservice is mounted, ShadRox renders an interactive SaaS sandbox complete with KPI cards, health checks, route exploration, and mock API execution.
- **Isolated Preview Frame:** Project scripts run in an opaque-origin sandboxed iframe without same-origin access to the editor page. Console output and runtime errors are accepted only from that preview frame.
- **Console Event Bridge:** Streams `console.log`, `console.info`, `console.warn`, and `console.error` into the collapsible DevTools drawer.

The preview executes browser-side frontend code only. Backend services are represented by the interactive mock sandbox and simulated API responses; they are not started by the browser runtime. CDN-loaded packages and Tailwind styling require a network connection.

### 3. File Edit Protocol

When the assistant proposes code changes, it outputs fenced code blocks containing the workspace-relative path:

````tsx
```tsx path=src/components/Navbar.tsx
export function Navbar() {
  return <nav className="p-4 bg-neutral-900 text-white">ShadRox</nav>;
}
```
````

`extractFilePatches()` in `src/lib/markdown.ts` extracts the code block, validates the file path against the real workspace files, and atomically patches the workspace buffer. Before applying any assistant reply, ShadRox marks a snapshot checkpoint allowing 1-click rollbacks via the **Restore workspace before this reply** button.

### 4. Direct Secret Linking (No Disk `.env`)

Users can define environment variables in **Settings → Secrets Vault**. Rather than writing unencrypted `.env` files to the user's hard drive:
1. Secrets are persisted in browser `localStorage` under `shadrox.secrets`.
2. Passed into `bundleProject(files, secrets)` as `process.env.KEY` and `import.meta.env.KEY` defines.
3. Injected into the iframe preview header inside `window.process = { env: ... }`.

---

## Subscription Plans & Limits

| Plan Tier | Price (INR) | Tax Note | Monthly Message Cap | Features |
| :--- | :--- | :--- | :--- | :--- |
| **Free (BYOK)** | ₹0 | Always Free | 100 messages | BYOK Gemini + Groq, disk write-back, live preview |
| **Pro** | ₹499/mo | GST Included | 250 messages | ShadRox Shared Key, fast-tier models, priority streaming |
| **Adv** | ₹1,099/mo | GST Included | 500 messages | Premium models, extended context, deep retrieval, 50 restore checkpoints |
| **Enterprise**| Custom | Invoiced | 5,000 messages | Custom message quotas, SSO, audit logs, SLA |

---

## Getting Started

### Prerequisites

- Node.js 22.12+ for development and packaging (required by the current Vite toolchain)
- Windows or macOS for native installers. Build macOS `.dmg` artifacts on macOS; Windows NSIS `.exe` artifacts on Windows.

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment (optional for shared key):**
   ```bash
   cp .env.example .env
   # Add GEMINI_API_KEY or GROQ_API_KEY if testing server-side shared keys
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```

4. **Run the desktop shell with the development server:**
   ```bash
   npm run dev:desktop
   ```

5. **Build the renderer:**
   ```bash
   npm run build
   ```

6. **Run the filesystem boundary tests:**
   ```bash
   npm test
   ```

7. **Package the native app:**
   ```bash
   npm run dist:win
   npm run dist:mac
   ```
   Artifacts are written to `dist_desktop/`. `npm run build:desktop` packages for the current host.

---

## Security & Privacy Model

- **Renderer Isolation:** Electron runs with `contextIsolation`, `sandbox`, and `webSecurity` enabled; `nodeIntegration` is disabled. The preload bridge exposes named operations only.
- **Scoped Filesystem Access:** Main-process writes are limited to an opened workspace root, reject traversal and symlinks, and use temporary-file replacement.
- **Confirmed Commands:** Every terminal command requires explicit native approval and runs in the opened folder with a timeout and bounded output.
- **Local Backend Proxy:** The production app binds its API/static server to loopback on an ephemeral port; it does not listen on the LAN.
- **Zero Cloud Code Uploads:** Workspace files are not sent to the AI proxy as files; relevant code context is included only in the user's chat request.
- **BYOK Privacy:** User API keys are stored solely in local browser storage and passed directly through stateless backend proxies.
- **Zero Disk Secret Footprint:** API secrets entered in the vault stay in browser memory and are never serialized to `.env` files on disk.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
