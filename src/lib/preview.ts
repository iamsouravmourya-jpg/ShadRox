import { inlineHtmlAssets, type AssetMap } from './assets';
import { detectRoutes, hasServerCode } from './backend';
import { canBundle } from './bundler';
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
    function stringify(value) {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.message;
      try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    window.addEventListener('error', function (event) {
      post({ type: 'error', message: event.message, stack: event.error && event.error.stack });
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      post({ type: 'error', message: (reason && reason.message) || String(reason), stack: reason && reason.stack });
    });
    [['log', 'console-log'], ['error', 'console-error'], ['warn', 'console-warn'], ['info', 'console-info']].forEach(function (pair) {
      var level = pair[0];
      var original = console[level] || console.log;
      console[level] = function () {
        post({ type: pair[1], message: Array.prototype.map.call(arguments, stringify).join(' ') });
        return original.apply(console, arguments);
      };
    });
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

const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-emerald-950 text-emerald-400 border-emerald-800/60',
  POST: 'bg-sky-950 text-sky-400 border-sky-800/60',
  PUT: 'bg-amber-950 text-amber-400 border-amber-800/60',
  PATCH: 'bg-amber-950 text-amber-400 border-amber-800/60',
  DELETE: 'bg-red-950 text-red-400 border-red-800/60',
  ALL: 'bg-neutral-900 text-neutral-300 border-neutral-700'
};

/**
 * Structure preview for workspaces that cannot be bundled — a pure backend, a
 * Python/Go service, a loose folder of files.
 *
 * Everything shown here is read from the workspace: the mounted files, the real
 * languages, and the routes actually declared in the server code. Nothing is
 * invented, and simulated responses are labelled as simulated.
 */
export function generateUniversalSaaSSandbox(
  files: WorkspaceFile[],
  activeFile?: WorkspaceFile,
  assets: AssetMap = {}
): string {
  const stack = detectWorkspaceStack(files);
  const routes = detectRoutes(files);
  const server = hasServerCode(files);
  const languages = [...new Set(files.map((f) => f.language).filter(Boolean))];
  const assetCount = Object.keys(assets).length;
  const fileNames = files.map((f) => f.name);

  const stats = [
    { label: 'Files Mounted', value: String(files.length), note: `${languages.length} language${languages.length === 1 ? '' : 's'} detected` },
    { label: 'Server Routes', value: String(routes.length), note: server ? 'Read from your server code' : 'No server code detected' },
    {
      label: 'Static Assets',
      value: String(assetCount),
      note: assetCount > 0 ? 'Served as inline data URLs' : 'No binary assets mounted'
    }
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ShadRox Structure Preview</title>
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
          <h1 class="text-sm font-semibold text-white tracking-wide">Workspace Structure Preview</h1>
          <p class="text-[11px] text-neutral-400">${escapeHtml(stack.framework)}</p>
        </div>
      </div>
      <span class="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider bg-emerald-950/60 text-emerald-400 border border-emerald-800/60 rounded">
        ${escapeHtml(stack.badge)}
      </span>
    </header>

    ${
      server
        ? `<div class="border border-amber-900/60 bg-amber-950/20 p-3 rounded-lg text-[11px] text-amber-300 leading-relaxed">
      <span class="font-semibold">Backend server detected.</span>
      Express / FastAPI / Go jaise server process browser sandbox me chal nahi sakte — isliye yahan sirf tumhare code se padha gaya structure aur routes dikhaye ja rahe hain. Koi bhi "Test Call" simulated response deta hai.
    </div>`
        : ''
    }

    ${
      !server && routes.length === 0 && !canBundle(files)
        ? `<div class="border border-neutral-800 bg-neutral-950 p-3 rounded-lg text-[11px] text-neutral-400 leading-relaxed">
      Is workspace me koi runnable entry point (jaise <span class="font-mono text-neutral-300">src/main.tsx</span>) nahi mila, isliye live app render nahi ho sakta. Neeche files ka structure dikhaya gaya hai.
    </div>`
        : ''
    }

    <!-- Interactive Navigation Tabs -->
    <nav class="flex items-center gap-2 border-b border-neutral-800 pb-2 text-xs">
      <button onclick="switchTab('dashboard')" id="tab-dashboard" class="tab-btn px-3 py-1.5 rounded bg-white text-black font-medium transition-colors">Overview</button>
      <button onclick="switchTab('api')" id="tab-api" class="tab-btn px-3 py-1.5 rounded text-neutral-400 hover:text-white transition-colors">Routes (${routes.length})</button>
      <button onclick="switchTab('files')" id="tab-files" class="tab-btn px-3 py-1.5 rounded text-neutral-400 hover:text-white transition-colors">Files (${files.length})</button>
    </nav>

    <!-- Overview -->
    <div id="view-dashboard" class="space-y-6">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        ${stats
          .map(
            (stat) => `
        <div class="border border-neutral-800 bg-neutral-900/40 p-4 rounded-lg">
          <div class="text-[11px] text-neutral-500 uppercase tracking-wider">${escapeHtml(stat.label)}</div>
          <div class="text-xl font-bold font-mono text-white mt-1">${escapeHtml(stat.value)}</div>
          <div class="text-[10px] text-neutral-400 mt-1">${escapeHtml(stat.note)}</div>
        </div>`
          )
          .join('')}
      </div>

      <div class="border border-neutral-800 bg-neutral-950 p-4 rounded-lg space-y-3">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-300">Detected Stack</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono">
          <div class="text-neutral-400">Active file: <span class="text-neutral-200">${escapeHtml(activeFile?.name || 'None selected')}</span></div>
          <div class="text-neutral-400">Languages: <span class="text-neutral-200">${escapeHtml(languages.join(', ') || 'unknown')}</span></div>
        </div>
      </div>
    </div>

    <!-- Routes -->
    <div id="view-api" class="space-y-3 hidden">
      ${
        routes.length === 0
          ? `<div class="border border-neutral-800 bg-neutral-950 p-4 rounded-lg text-[11px] text-neutral-400">
        Is workspace me koi HTTP route nahi mila. Routes tab dikhta hai jab code me <span class="font-mono text-neutral-300">app.get('/x')</span>, <span class="font-mono text-neutral-300">@app.post("/x")</span> ya <span class="font-mono text-neutral-300">app/api/x/route.ts</span> jaisa server code ho.
      </div>`
          : `<div class="text-xs text-neutral-400">Read from your server code:</div>
      <div class="divide-y divide-neutral-900 border border-neutral-800 rounded-lg overflow-hidden bg-neutral-950">
        ${routes
          .map(
            (route) => `
          <div class="p-3 flex items-center justify-between gap-3 hover:bg-neutral-900/60 transition-colors">
            <div class="flex items-center gap-2 min-w-0">
              <span class="px-1.5 py-0.5 text-[10px] font-mono font-bold border rounded shrink-0 ${
                METHOD_STYLES[route.method] ?? METHOD_STYLES.ALL
              }">${escapeHtml(route.method)}</span>
              <span class="font-mono text-xs text-neutral-200 truncate">${escapeHtml(route.path)}</span>
            </div>
            <button onclick="testEndpoint('${escapeHtml(route.method)}','${escapeHtml(route.path)}')" class="px-2 py-1 text-[11px] border border-neutral-700 hover:border-neutral-500 text-neutral-300 rounded cursor-pointer shrink-0">Simulate</button>
          </div>
          <div class="px-3 pb-2 -mt-1 text-[10px] text-neutral-600 font-mono truncate">${escapeHtml(route.source)}</div>`
          )
          .join('')}
      </div>`
      }
      <div id="api-response-box" class="hidden border border-neutral-800 bg-black p-3 rounded text-xs font-mono">
        <div class="text-neutral-500 mb-1">Simulated response (server is not running):</div>
        <pre id="api-response-text" class="text-emerald-400"></pre>
      </div>
    </div>

    <!-- Files -->
    <div id="view-files" class="space-y-2 hidden">
      <div class="text-xs text-neutral-400">Workspace files mounted in this session:</div>
      <div class="border border-neutral-800 rounded-lg p-3 bg-neutral-950 max-h-64 overflow-y-auto font-mono text-xs space-y-1.5">
        ${fileNames
          .map((fn) => `<div class="text-neutral-300 flex items-center gap-2"><span class="text-neutral-600">●</span> ${escapeHtml(fn)}</div>`)
          .join('')}
      </div>
      ${
        assetCount > 0
          ? `<div class="text-[11px] text-neutral-500">${assetCount} binary asset${
              assetCount === 1 ? '' : 's'
            } mounted as data URLs: <span class="font-mono">${escapeHtml(Object.keys(assets).slice(0, 6).join(', '))}${
              assetCount > 6 ? ' …' : ''
            }</span></div>`
          : ''
      }
    </div>
  </div>

  <script>${PREVIEW_ERROR_BRIDGE}</script>
  <script>
    function switchTab(name) {
      ['dashboard', 'api', 'files'].forEach(function (t) {
        document.getElementById('view-' + t).classList.toggle('hidden', t !== name);
        var btn = document.getElementById('tab-' + t);
        btn.className = t === name
          ? 'tab-btn px-3 py-1.5 rounded bg-white text-black font-medium transition-colors'
          : 'tab-btn px-3 py-1.5 rounded text-neutral-400 hover:text-white transition-colors';
      });
    }

    function testEndpoint(method, path) {
      var box = document.getElementById('api-response-box');
      var text = document.getElementById('api-response-text');
      box.classList.remove('hidden');
      var payload = {
        simulated: true,
        method: method,
        path: path,
        status: 200,
        note: 'Backend server browser sandbox me nahi chalta — ye response sirf shape dikhane ke liye hai.',
        data: {}
      };
      text.textContent = JSON.stringify(payload, null, 2);
      console.info('[ShadRox] simulated ' + method + ' ' + path);
    }
  </script>
</body>
</html>`;
}

/**
 * Builds the document rendered inside the preview iframe.
 * Supports HTML, Markdown, React/TSX bundled projects, and the structure preview
 * used for workspaces that cannot be bundled (pure backend services etc).
 */
export function resolvePreviewDocument(
  files: WorkspaceFile[],
  activeFile?: WorkspaceFile,
  assets: AssetMap = {}
): PreviewDocument | null {
  if (!activeFile && files.length === 0) return null;

  const stack = detectWorkspaceStack(files);

  const withBridge = (content: string): string =>
    inlineHtmlAssets(content.includes('shadrox-preview') ? content : content.replace('</body>', `<script>${PREVIEW_ERROR_BRIDGE}</script></body>`), assets);

  if (activeFile?.language === 'html') {
    return {
      html: withBridge(activeFile.content),
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
    return {
      html: withBridge(entryHtml.content),
      label: `Rendered from ${entryHtml.name}`,
      source: entryHtml.name,
      stackType: stack.badge
    };
  }

  // Structure preview for stacks the sandbox cannot execute (backend services,
  // loose file sets). Everything shown is read from the real workspace.
  return {
    html: generateUniversalSaaSSandbox(files, activeFile, assets),
    label: `Structure preview — ${stack.badge}`,
    source: activeFile?.name || 'Workspace structure',
    stackType: stack.badge
  };
}

export function previewCapabilityMessage(activeFile?: WorkspaceFile): string {
  if (!activeFile) return 'No file open in editor.';
  return `${activeFile.name} (${activeFile.language}) loaded. Switched to interactive SaaS sandbox mode.`;
}
