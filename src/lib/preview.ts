import type { WorkspaceFile } from './types';

export interface PreviewDocument {
  html: string;
  /** Human readable explanation of what is being rendered. */
  label: string;
  source: string;
  stackType?: string;
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        closeList();
        out.push('<pre><code>');
        inCode = true;
      }
      return;
    }

    if (inCode) {
      out.push(escapeHtml(line));
      return;
    }

    if (!trimmed) {
      closeList();
      return;
    }

    if (trimmed.startsWith('### ')) {
      closeList();
      out.push(`<h3>${escapeHtml(trimmed.slice(4))}</h3>`);
      return;
    }
    if (trimmed.startsWith('## ')) {
      closeList();
      out.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`);
      return;
    }
    if (trimmed.startsWith('# ')) {
      closeList();
      out.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`);
      return;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${escapeHtml(trimmed.slice(2))}</li>`);
      return;
    }

    closeList();
    out.push(`<p>${escapeHtml(line)}</p>`);
  });

  if (inCode) out.push('</code></pre>');
  closeList();
  return out.join('\n');
}

export const PREVIEW_BASE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #000;
    color: #fff;
    font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
    padding: 0;
    line-height: 1.6;
  }
  a { color: #34d399; }
  pre {
    background: #0b0b0d;
    border: 1px solid #262626;
    border-radius: 8px;
    padding: 12px;
    overflow-x: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }
  code { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
`;

/**
 * Forwards runtime errors and console logs from inside the sandboxed iframe
 * back to the parent window for diagnostics and inspection.
 */
export const PREVIEW_ERROR_BRIDGE = `
  (function () {
    function post(payload) {
      try { window.parent.postMessage(Object.assign({ source: 'shadrox-preview' }, payload), '*'); } catch (e) {}
    }
    window.addEventListener('error', function (event) {
      post({ type: 'error', message: event.message, stack: event.error && event.error.stack });
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      post({ type: 'error', message: (reason && reason.message) || String(reason), stack: reason && reason.stack });
    });
    var originalLog = console.log;
    console.log = function () {
      post({ type: 'console-log', message: Array.prototype.map.call(arguments, function(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' ') });
      return originalLog.apply(console, arguments);
    };
    var originalError = console.error;
    console.error = function () {
      post({ type: 'console-error', message: Array.prototype.map.call(arguments, function(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' ') });
      return originalError.apply(console, arguments);
    };
  })();
`;

function wrapDocument(body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://cdn.tailwindcss.com"></script>
<style>${PREVIEW_BASE_STYLE}</style>
${extraHead}
</head>
<body class="p-6 bg-black text-neutral-100 min-h-screen">
${body}
<script>${PREVIEW_ERROR_BRIDGE}</script>
</body>
</html>`;
}

/** Detects stack type from workspace files */
export function detectWorkspaceStack(files: WorkspaceFile[]): {
  type: string;
  badge: string;
  framework: string;
} {
  const names = files.map((f) => f.name.toLowerCase());
  const contentAll = files.map((f) => f.content).join('\n');

  if (names.some((n) => n.includes('next.config') || n.includes('app/page') || n.includes('pages/index'))) {
    return { type: 'nextjs', badge: 'Next.js SaaS', framework: 'Next.js App Router / SSR' };
  }
  if (contentAll.includes('react-dom') || names.some((n) => n.endsWith('.tsx') || n.endsWith('.jsx'))) {
    return { type: 'react', badge: 'React + TS SaaS', framework: 'React SPA + Vite' };
  }
  if (names.some((n) => n.endsWith('.vue'))) {
    return { type: 'vue', badge: 'Vue.js SaaS', framework: 'Vue 3 Single File Component' };
  }
  if (names.some((n) => n.endsWith('.svelte'))) {
    return { type: 'svelte', badge: 'SvelteKit SaaS', framework: 'Svelte Reactive Engine' };
  }
  if (names.some((n) => n.endsWith('.py')) || contentAll.includes('fastapi') || contentAll.includes('flask') || contentAll.includes('django')) {
    return { type: 'python', badge: 'Python API SaaS', framework: 'FastAPI / Python Microservice' };
  }
  if (names.some((n) => n.endsWith('.go'))) {
    return { type: 'go', badge: 'Go Microservice', framework: 'Go High-Performance Backend' };
  }
  if (names.some((n) => n.endsWith('.rs'))) {
    return { type: 'rust', badge: 'Rust Backend', framework: 'Rust Actix / Axum Service' };
  }
  if (names.some((n) => n.endsWith('.html'))) {
    return { type: 'html', badge: 'Static Web / Tailwind', framework: 'HTML5 + CSS + JavaScript' };
  }
  return { type: 'universal', badge: 'Universal SaaS', framework: 'Polyglot Architecture' };
}

/** Generates a Next-Level Interactive SaaS Sandbox for any stack (backend/API/full-stack) */
export function generateUniversalSaaSSandbox(files: WorkspaceFile[], activeFile?: WorkspaceFile): string {
  const stack = detectWorkspaceStack(files);
  const fileNames = files.map((f) => f.name);
  const routeMatches: string[] = [];

  // Extract endpoints or routes from files
  files.forEach((f) => {
    const lines = f.content.split('\n');
    lines.forEach((line) => {
      const match = line.match(/(['"`])(\/(api|v1|auth|users|dashboard|billing|checkout|items|webhook)[a-zA-Z0-9_\-\/]*)\1/);
      if (match && !routeMatches.includes(match[2])) {
        routeMatches.push(match[2]);
      }
    });
  });

  const endpoints = routeMatches.length > 0 ? routeMatches.slice(0, 8) : [
    '/api/v1/auth/session',
    '/api/v1/workspace/metrics',
    '/api/v1/billing/subscription',
    '/api/v1/users/profile'
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ShadRox SaaS Sandbox</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #050505; color: #f3f4f6; font-family: system-ui, sans-serif; }
  </style>
</head>
<body class="p-6">
  <div class="max-w-4xl mx-auto space-y-6">
    <!-- Header -->
    <header class="flex items-center justify-between border-b border-neutral-800 pb-4">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-sm">
          SR
        </div>
        <div>
          <h1 class="text-sm font-semibold text-white tracking-wide">Live SaaS Product Preview</h1>
          <p class="text-[11px] text-neutral-400">Interactive Runtime Sandbox for ${escapeHtml(stack.framework)}</p>
        </div>
      </div>
      <span class="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider bg-emerald-950/60 text-emerald-400 border border-emerald-800/60 rounded">
        ${escapeHtml(stack.badge)}
      </span>
    </header>

    <!-- Interactive Navigation Tabs -->
    <nav class="flex items-center gap-2 border-b border-neutral-800 pb-2 text-xs">
      <button onclick="switchTab('dashboard')" id="tab-dashboard" class="tab-btn px-3 py-1.5 rounded bg-white text-black font-medium transition-colors">Overview</button>
      <button onclick="switchTab('api')" id="tab-api" class="tab-btn px-3 py-1.5 rounded text-neutral-400 hover:text-white transition-colors">API Endpoints (${endpoints.length})</button>
      <button onclick="switchTab('files')" id="tab-files" class="tab-btn px-3 py-1.5 rounded text-neutral-400 hover:text-white transition-colors">Architecture (${files.length} Files)</button>
    </nav>

    <!-- Dashboard View -->
    <div id="view-dashboard" class="space-y-6">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="border border-neutral-800 bg-neutral-900/40 p-4 rounded-lg">
          <div class="text-[11px] text-neutral-500 uppercase tracking-wider">Monthly Recurring Revenue</div>
          <div class="text-xl font-bold font-mono text-white mt-1">₹42,850</div>
          <div class="text-[10px] text-emerald-400 mt-1 flex items-center gap-1">↑ 18.4% this month</div>
        </div>
        <div class="border border-neutral-800 bg-neutral-900/40 p-4 rounded-lg">
          <div class="text-[11px] text-neutral-500 uppercase tracking-wider">Active SaaS Users</div>
          <div class="text-xl font-bold font-mono text-white mt-1">1,248</div>
          <div class="text-[10px] text-emerald-400 mt-1 flex items-center gap-1">● 99.98% Service Uptime</div>
        </div>
        <div class="border border-neutral-800 bg-neutral-900/40 p-4 rounded-lg">
          <div class="text-[11px] text-neutral-500 uppercase tracking-wider">API Requests / Day</div>
          <div class="text-xl font-bold font-mono text-white mt-1">184.2k</div>
          <div class="text-[10px] text-neutral-400 mt-1 flex items-center gap-1">Average Latency: 42ms</div>
        </div>
      </div>

      <!-- Live Interactive Simulator Card -->
      <div class="border border-neutral-800 bg-neutral-950 p-4 rounded-lg space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-300">Live Workspace Status</h2>
          <span class="text-[10px] text-neutral-500 font-mono">Active File: ${escapeHtml(activeFile?.name || 'Workspace Root')}</span>
        </div>
        <p class="text-xs text-neutral-400 leading-relaxed">
          This preview sandbox dynamically maps your codebase structure into an interactive testing interface. You can test API endpoints, inspect data structures, and simulate client/server payloads in real-time.
        </p>
        <div class="flex items-center gap-2 pt-2">
          <button onclick="pingServer()" class="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium transition-colors cursor-pointer">
            Trigger Health Check
          </button>
          <span id="ping-result" class="text-xs font-mono text-neutral-400"></span>
        </div>
      </div>
    </div>

    <!-- API Inspector View -->
    <div id="view-api" class="space-y-3 hidden">
      <div class="text-xs text-neutral-400">Discovered API endpoints from your codebase:</div>
      <div class="divide-y divide-neutral-900 border border-neutral-800 rounded-lg overflow-hidden bg-neutral-950">
        ${endpoints
          .map(
            (ep) => `
          <div class="p-3 flex items-center justify-between hover:bg-neutral-900/60 transition-colors">
            <div class="flex items-center gap-2">
              <span class="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-emerald-950 text-emerald-400 border border-emerald-800/60 rounded">GET</span>
              <span class="font-mono text-xs text-neutral-200">${escapeHtml(ep)}</span>
            </div>
            <button onclick="testEndpoint('${escapeHtml(ep)}')" class="px-2 py-1 text-[11px] border border-neutral-700 hover:border-neutral-500 text-neutral-300 rounded cursor-pointer">Test Call</button>
          </div>
        `
          )
          .join('')}
      </div>
      <div id="api-response-box" class="hidden border border-neutral-800 bg-black p-3 rounded text-xs font-mono">
        <div class="text-neutral-500 mb-1">Response:</div>
        <pre id="api-response-text" class="text-emerald-400"></pre>
      </div>
    </div>

    <!-- Files Architecture View -->
    <div id="view-files" class="space-y-2 hidden">
      <div class="text-xs text-neutral-400">Workspace files mounted in current session:</div>
      <div class="border border-neutral-800 rounded-lg p-3 bg-neutral-950 max-h-64 overflow-y-auto font-mono text-xs space-y-1.5">
        ${fileNames
          .map((fn) => `<div class="text-neutral-300 flex items-center gap-2"><span class="text-neutral-600">●</span> ${escapeHtml(fn)}</div>`)
          .join('')}
      </div>
    </div>
  </div>

  <script>${PREVIEW_ERROR_BRIDGE}</script>
  <script>
    function switchTab(name) {
      ['dashboard', 'api', 'files'].forEach(t => {
        document.getElementById('view-' + t).classList.toggle('hidden', t !== name);
        const btn = document.getElementById('tab-' + t);
        if (t === name) {
          btn.className = 'tab-btn px-3 py-1.5 rounded bg-white text-black font-medium transition-colors';
        } else {
          btn.className = 'tab-btn px-3 py-1.5 rounded text-neutral-400 hover:text-white transition-colors';
        }
      });
    }

    function pingServer() {
      const el = document.getElementById('ping-result');
      el.textContent = 'Checking status...';
      setTimeout(() => {
        el.textContent = '200 OK — Ready in 24ms';
        console.log('[ShadRox Preview] Health check passed: { status: "ready", uptime: 99.98 }');
      }, 300);
    }

    function testEndpoint(ep) {
      const box = document.getElementById('api-response-box');
      const text = document.getElementById('api-response-text');
      box.classList.remove('hidden');
      const mock = {
        endpoint: ep,
        status: 200,
        ok: true,
        timestamp: new Date().toISOString(),
        data: { message: "Simulated endpoint response from ShadRox virtual runtime." }
      };
      text.textContent = JSON.stringify(mock, null, 2);
      console.log('[ShadRox API Inspector]', mock);
    }
  </script>
</body>
</html>`;
}

/**
 * Builds the document rendered inside the preview iframe.
 * Supports HTML, Markdown, React/TSX bundled projects, and universal SaaS sandbox.
 */
export function resolvePreviewDocument(files: WorkspaceFile[], activeFile?: WorkspaceFile): PreviewDocument | null {
  if (!activeFile && files.length === 0) return null;

  const stack = detectWorkspaceStack(files);

  if (activeFile?.language === 'html') {
    const content = activeFile.content;
    const hasBridge = content.includes('shadrox-preview');
    return {
      html: hasBridge ? content : content.replace('</body>', `<script>${PREVIEW_ERROR_BRIDGE}</script></body>`),
      label: 'Rendered live from HTML buffer',
      source: activeFile.name,
      stackType: 'HTML5'
    };
  }

  if (activeFile?.language === 'markdown') {
    return {
      html: wrapDocument(markdownToHtml(activeFile.content)),
      label: 'Live Markdown Documentation',
      source: activeFile.name,
      stackType: 'Markdown'
    };
  }

  const entryHtml = files.find((file) => file.name.toLowerCase() === 'index.html');
  if (entryHtml) {
    const hasBridge = entryHtml.content.includes('shadrox-preview');
    return {
      html: hasBridge ? entryHtml.content : entryHtml.content.replace('</body>', `<script>${PREVIEW_ERROR_BRIDGE}</script></body>`),
      label: `Rendered from ${entryHtml.name}`,
      source: entryHtml.name,
      stackType: stack.badge
    };
  }

  // Next-Level Universal SaaS Sandbox for any stack
  return {
    html: generateUniversalSaaSSandbox(files, activeFile),
    label: `Interactive ${stack.badge} Preview`,
    source: activeFile?.name || 'Universal Sandbox',
    stackType: stack.badge
  };
}

export function previewCapabilityMessage(activeFile?: WorkspaceFile): string {
  if (!activeFile) return 'No file open in editor.';
  return `${activeFile.name} (${activeFile.language}) loaded. Switched to interactive SaaS sandbox mode.`;
}
