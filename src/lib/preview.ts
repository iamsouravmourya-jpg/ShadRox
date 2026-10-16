import type { WorkspaceFile } from './types';

export interface PreviewDocument {
  html: string;
  /** Human readable explanation of what is being rendered. */
  label: string;
  source: string;
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
    font-family: 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
    padding: 24px;
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
  h1, h2, h3 { line-height: 1.25; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #262626; padding: 6px 10px; }
`;

/**
 * Forwards runtime errors and console errors from inside the sandboxed iframe
 * back to the parent window so the self-heal pipeline gets a real stack trace.
 */
export const PREVIEW_ERROR_BRIDGE = `
  (function () {
    function post(payload) {
      try { window.parent.postMessage(Object.assign({ source: 'devora-preview' }, payload), '*'); } catch (e) {}
    }
    window.addEventListener('error', function (event) {
      post({ type: 'error', message: event.message, stack: event.error && event.error.stack });
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      post({ type: 'error', message: (reason && reason.message) || String(reason), stack: reason && reason.stack });
    });
    var originalError = console.error;
    console.error = function () {
      post({ type: 'console-error', message: Array.prototype.map.call(arguments, String).join(' ') });
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
<style>${PREVIEW_BASE_STYLE}</style>
${extraHead}
</head>
<body>
${body}
<script>${PREVIEW_ERROR_BRIDGE}</script>
</body>
</html>`;
}

/**
 * Builds the document rendered inside the preview iframe.
 *
 * HTML files are rendered as-is. Markdown files are converted. React/TSX files
 * cannot run in a plain iframe yet, so we look for the workspace entry HTML and
 * otherwise explain clearly instead of showing fake output.
 */
export function resolvePreviewDocument(files: WorkspaceFile[], activeFile?: WorkspaceFile): PreviewDocument | null {
  if (!activeFile) return null;

  if (activeFile.language === 'html') {
    const hasErrorBridge = activeFile.content.includes('devora-preview');
    return {
      html: hasErrorBridge ? activeFile.content : activeFile.content.replace('</body>', `<script>${PREVIEW_ERROR_BRIDGE}</script></body>`),
      label: 'Rendered from the live editor buffer',
      source: activeFile.name
    };
  }

  if (activeFile.language === 'markdown') {
    return {
      html: wrapDocument(markdownToHtml(activeFile.content)),
      label: 'Markdown rendered live',
      source: activeFile.name
    };
  }

  const entry = files.find((file) => file.name.toLowerCase() === 'index.html');
  if (entry) {
    return {
      html: entry.content.replace('</body>', `<script>${PREVIEW_ERROR_BRIDGE}</script></body>`),
      label: `${activeFile.name} ko static preview nahi kiya ja sakta — workspace ka index.html render kiya gaya hai`,
      source: entry.name
    };
  }

  return null;
}

/** Static preview is limited to plain HTML/Markdown until the bundler lands. */
export function previewCapabilityMessage(activeFile?: WorkspaceFile): string {
  if (!activeFile) return 'Koi file open nahi hai.';
  return `${activeFile.name} (${activeFile.language}) ko browser me directly run nahi kiya ja sakta. Is workspace me koi index.html bhi nahi mila.`;
}
