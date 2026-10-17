# ShadRox

**Browser-Native AI Software Engineering Workspace & Next-Gen SaaS Runtime**

ShadRox is an in-browser AI coding workspace. Open any project folder or files directly from your local disk via the File System Access API, converse with high-performance AI models (Google Gemini & Groq) with intelligent codebase context retrieval, view live next-level multi-stack SaaS previews in a sandboxed iframe with real-time console devtools, and save edits directly back to your local files.

ShadRox brings a **Bring-Your-Own-Key (BYOK)** architecture: validate your own Gemini or Groq API keys locally with zero server persistence, or leverage the optional **ShadRox Shared Key** for instant access to Pro-tier models.

---

## Key Highlights

- **Direct Disk Mount & Write-Back:** Mount folders via Chromium's `FileSystemDirectoryHandle`. Zero cloud uploads; your source code remains on your machine. Save anytime with `Ctrl/Cmd+S` or 1-click Save.
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
┌─────────────────────────────────────────────────────────────┐
│                       ShadRox UI                            │
├──────────────────────────────┬──────────────────────────────┤
│          Chat Panel          │       Code / Preview         │
│  - Gemini / Groq Stream      │  - Vertical File Explorer    │
│  - Work Mode Dropdown        │  - CodeMirror 6 Editor       │
│  - Monthly Quota Indicator   │  - Next-Gen SaaS Sandbox     │
│  - AST File Patch Extractor  │  - Dockable Console Drawer   │
│  - Checkpoint Rollbacks      │  - Virtual Secret Ingestion  │
└──────────────┬───────────────┴──────────────┬───────────────┘
               │                              │
               ▼                              ▼
      /api/ai/chat (Proxy)           esbuild-wasm VFS
   - Normalised SSE streaming        - In-browser bundler
   - Model classification            - Tailwind CSS CDN
   - BYOK passthrough                - Module resolution
```

### 1. Workspace & Local Disk Access

Folders are mounted with `window.showDirectoryPicker({ mode: 'readwrite' })`. Files are indexed in-memory and mapped to `WorkspaceFile` structures:
- Reads preserve full relative paths (`src/components/Button.tsx`).
- Automatically filters out noisy directories (`node_modules`, `.git`, `dist`, `.next`, `__pycache__`) and binary file extensions.
- Workspace snapshots are saved in IndexedDB (`shadrox-workspace` -> `snapshots`) for immediate session resumption.

### 2. Universal SaaS Preview Engine

Located in `src/components/PreviewPane.tsx` and `src/lib/preview.ts`:
- **React / TSX Bundling:** Powered by `esbuild-wasm` running in a virtual filesystem (`shadrox-vfs`). Unresolved bare imports are fulfilled via CDN (`esm.sh`).
- **Tailwind CSS Injection:** Automatically includes Tailwind CDN in bundled and sandboxed HTML previews, ensuring full visual fidelity.
- **Interactive Sandbox & API Inspector:** When a full-stack SaaS project, Python backend, or API microservice is mounted, ShadRox renders an interactive SaaS sandbox complete with KPI cards, health checks, route exploration, and mock API execution.
- **Console Event Bridge:** Listens for iframe `postMessage` calls to stream `console.log` and runtime error stack traces into the collapsible bottom DevTools drawer.

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

- Node.js 18+
- Chromium-based browser (Chrome, Edge, Brave) for File System Access API support.

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

4. **Build for production:**
   ```bash
   npm run build
   ```

---

## Security & Privacy Model

- **Zero Cloud Code Uploads:** All source code parsing, indexing, and AST manipulation occur client-side in the browser.
- **BYOK Privacy:** User API keys are stored solely in local browser storage and passed directly through stateless backend proxies.
- **Zero Disk Secret Footprint:** API secrets entered in the vault stay in browser memory and are never serialized to `.env` files on disk.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
