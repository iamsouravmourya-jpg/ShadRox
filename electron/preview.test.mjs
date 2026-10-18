import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWorkspaceAccess } from './workspace.cjs';
import { findAsset, inlineHtmlAssets } from '../src/lib/assets';
import {
  bundleProject,
  bundleDocument,
  canBundle,
  readPathAliases,
  resolveAliasPath
} from '../src/lib/bundler';
import {
  inlineWorkspaceHtml,
  resolvePreviewDocument,
  PREVIEW_ERROR_BRIDGE,
  PREVIEW_BASE_STYLE
} from '../src/lib/preview';

test('1. Static HTML/CSS/JS: inlines workspace styles, scripts, assets, and error bridge', () => {
  const files = [
    {
      name: 'index.html',
      language: 'html',
      content: `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <h1>Counter</h1>
  <button id="counter">Clicks: 0</button>
  <img src="./assets/icon.png" alt="Icon">
  <script src="./app.js"></script>
</body>
</html>`
    },
    {
      name: 'style.css',
      language: 'css',
      content: 'body { background: #000; color: #fff; }'
    },
    {
      name: 'app.js',
      language: 'javascript',
      content: 'document.getElementById("counter").addEventListener("click", () => console.log("clicked"));'
    }
  ];

  const assets = {
    'assets/icon.png': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  };

  // Pure static site should not be forcefully converted into an empty React bundle
  assert.equal(canBundle(files), false, 'Static site without React or package.json should not be treated as a bundler project');

  const preview = resolvePreviewDocument(files, files[0], assets);
  assert.ok(preview, 'Preview document should be generated');
  assert.equal(preview.stackType, 'HTML5');

  // Verify inlining
  assert.ok(preview.html.includes('<style data-source="style.css">'), 'CSS should be inlined into style tag');
  assert.ok(preview.html.includes('background: #000;'), 'CSS content should be present');
  assert.ok(preview.html.includes('<script data-source="app.js">'), 'JavaScript should be inlined into script tag');
  assert.ok(preview.html.includes('document.getElementById("counter")'), 'Script content should be present');
  assert.ok(preview.html.includes(assets['assets/icon.png']), 'Image src should be rewritten to data URL');
  assert.ok(preview.html.includes('shadrox-preview'), 'Preview error bridge should be injected');
});

test('2. React TSX & JSX bundling with nested relative imports and tsconfig path aliases', async () => {
  const files = [
    {
      name: 'package.json',
      language: 'json',
      content: JSON.stringify({
        dependencies: {
          react: '^19.0.0',
          'react-dom': '^19.0.0'
        }
      })
    },
    {
      name: 'tsconfig.app.json',
      language: 'json',
      content: JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['./src/*'],
            '@components/*': ['./src/components/*']
          }
        }
      })
    },
    {
      name: 'src/main.tsx',
      language: 'typescript',
      content: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);`
    },
    {
      name: 'src/App.tsx',
      language: 'typescript',
      content: `import React from 'react';
import { Header } from '@components/Header';
import { add } from './utils/math';

export default function App() {
  return (
    <div>
      <Header title="ShadRox" />
      <p>Result: {add(2, 3)}</p>
    </div>
  );
}`
    },
    {
      name: 'src/components/Header.tsx',
      language: 'typescript',
      content: `import React from 'react';
export function Header({ title }: { title: string }) {
  return <h1>{title}</h1>;
}`
    },
    {
      name: 'src/utils/math.ts',
      language: 'typescript',
      content: 'export function add(a: number, b: number) { return a + b; }'
    }
  ];

  assert.equal(canBundle(files), true, 'React TSX project should be bundlable');

  const aliases = readPathAliases(files);
  assert.ok(aliases.length >= 2, 'Should parse aliases from tsconfig.app.json');
  assert.deepEqual(resolveAliasPath('@/App', aliases), ['src/App']);
  assert.deepEqual(resolveAliasPath('@components/Header', aliases), ['src/components/Header']);

  const result = await bundleProject(files);
  assert.ok(result.code.length > 0, 'Bundle should produce compiled JavaScript');
  assert.ok(result.code.includes('createRoot'), 'Bundle code should reference React DOM createRoot');
  assert.ok(result.code.includes('Result:'), 'Bundle code should include compiled JSX content');
  assert.ok(result.importMap.react, 'Import map should provide React from CDN');
  assert.ok(result.importMap['react-dom'], 'Import map should provide ReactDOM from CDN');
});

test('3. CSS imports, CSS Modules (local-css), CSS url-tokens, and actionable missing dependency errors', async () => {
  const files = [
    {
      name: 'package.json',
      language: 'json',
      content: JSON.stringify({
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }
      })
    },
    {
      name: 'src/main.tsx',
      language: 'typescript',
      content: `import React from 'react';
import './index.css';
import styles from './Button.module.css';

console.log(styles.primary);
export default function Button() {
  return <button className={styles.primary}>Click</button>;
}`
    },
    {
      name: 'src/index.css',
      language: 'css',
      content: '@import "./vars.css"; body { margin: 0; }'
    },
    {
      name: 'src/vars.css',
      language: 'css',
      content: ':root { --accent: #10b981; }'
    },
    {
      name: 'src/Button.module.css',
      language: 'css',
      content: '.primary { background: url("./bg.png"); color: var(--accent); }'
    }
  ];

  const assets = {
    'src/bg.png': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  };

  const result = await bundleProject(files, [], assets);
  assert.ok(result.css.includes('--accent: #10b981'), 'Imported vars.css should be included in output CSS');
  assert.ok(result.css.includes('margin: 0'), 'index.css should be included in output CSS');
  assert.ok(result.css.includes('primary'), 'CSS module class should be compiled in output CSS');
  assert.ok(result.css.includes(assets['src/bg.png']), 'CSS url token should resolve to data URL');
  assert.ok(result.code.includes('primary:'), 'Compiled JS should export the CSS module class mapping');

  // Verify actionable error for missing dependency
  const missingDepFiles = [
    {
      name: 'package.json',
      language: 'json',
      content: JSON.stringify({ dependencies: { react: '^19.0.0' } })
    },
    {
      name: 'src/main.tsx',
      language: 'typescript',
      content: 'import { missingLib } from "uninstalled-super-lib"; console.log(missingLib);'
    }
  ];

  await assert.rejects(
    async () => bundleProject(missingDepFiles),
    (err) => {
      const msg = String(err);
      return msg.includes('uninstalled-super-lib') && msg.includes('package.json');
    },
    'Should throw actionable error when dependency is missing from package.json'
  );

  // Verify actionable error for unsupported Node built-in
  const nodeBuiltinFiles = [
    {
      name: 'package.json',
      language: 'json',
      content: JSON.stringify({ dependencies: { react: '^19.0.0' } })
    },
    {
      name: 'src/main.tsx',
      language: 'typescript',
      content: 'import fs from "fs"; console.log(fs);'
    }
  ];

  await assert.rejects(
    async () => bundleProject(nodeBuiltinFiles),
    (err) => {
      const msg = String(err);
      return msg.includes('Node.js built-in module') && msg.includes('cannot run in the browser preview');
    },
    'Should report clear message for unsupported Node built-ins'
  );
});

test('4. Workspace assets (images, SVGs, fonts) and desktop folder scanning', async (context) => {
  // Test asset lookup helper
  const assets = {
    'public/logo.png': 'data:image/png;base64,logo',
    'src/assets/icon.svg': 'data:image/svg+xml;base64,svg',
    'fonts/custom.woff2': 'data:font/woff2;base64,font'
  };

  assert.equal(findAsset('/logo.png', '', assets), 'data:image/png;base64,logo');
  assert.equal(findAsset('./logo.png', '', assets), 'data:image/png;base64,logo');
  assert.equal(findAsset('logo.png', '', assets), 'data:image/png;base64,logo');
  assert.equal(findAsset('./assets/icon.svg', 'src/App.tsx', assets), 'data:image/svg+xml;base64,svg');
  assert.equal(findAsset('/fonts/custom.woff2', '', assets), 'data:font/woff2;base64,font');

  // Test HTML asset inlining
  const rawHtml = '<img src="./logo.png"><link rel="preload" href="/fonts/custom.woff2">';
  const inlinedHtml = inlineHtmlAssets(rawHtml, assets);
  assert.ok(inlinedHtml.includes('src="data:image/png;base64,logo"'));
  assert.ok(inlinedHtml.includes('href="data:font/woff2;base64,font"'));

  // Test Electron workspace folder scanning with real binary preview assets
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-preview-assets-'));
  context.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  await fs.mkdir(path.join(tempDir, 'public'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'index.html'), '<h1>Asset Test</h1>');
  // Write 1x1 png image
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await fs.writeFile(path.join(tempDir, 'public', 'favicon.png'), png1x1);
  await fs.writeFile(path.join(tempDir, 'public', 'logo.svg'), '<svg></svg>');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(tempDir);

  assert.ok(opened.files.some((f) => f.name === 'index.html'), 'index.html should be in files');
  assert.ok(opened.assets['public/favicon.png'], 'public/favicon.png must be scanned into assets');
  assert.ok(opened.assets['public/favicon.png'].startsWith('data:image/png;base64,'), 'favicon.png should be data URL');
  assert.ok(opened.assets['public/logo.svg'], 'public/logo.svg must be scanned into assets');
  assert.ok(opened.assets['public/logo.svg'].startsWith('data:image/svg+xml;base64,'), 'logo.svg should be data URL');
});

test('5. Preview document assembly, index.html template preservation, and error bridge', () => {
  const bundleResult = {
    code: 'console.log("running");',
    css: 'h1 { color: green; }',
    entry: 'src/main.tsx',
    importMap: { react: 'https://esm.sh/react@19' },
    routes: []
  };

  const userIndexHtml = `<!doctype html>
<html lang="en">
<head>
  <title>Custom User Title</title>
  <link rel="stylesheet" href="/src/custom.css">
</head>
<body>
  <div id="root" class="custom-root"></div>
</body>
</html>`;

  const bundledDoc = bundleDocument(
    bundleResult,
    PREVIEW_ERROR_BRIDGE,
    PREVIEW_BASE_STYLE,
    [{ key: 'API_URL', value: 'https://api.example.com' }],
    userIndexHtml
  );

  assert.ok(bundledDoc.includes('<title>Custom User Title</title>'), 'Custom title in index.html must be preserved');
  assert.ok(bundledDoc.includes('h1 { color: green; }'), 'Bundle CSS must be injected');
  assert.ok(bundledDoc.includes('shadrox-preview'), 'Preview error bridge must be injected');
  assert.ok(bundledDoc.includes('console.log("running");'), 'Bundle JavaScript must be injected');
  assert.ok(bundledDoc.includes('API_URL'), 'Virtual secret must be injected into window.process.env');
});

test('6. Sandbox isolation and security verification', () => {
  // Verify error bridge contains essential security wrappers
  assert.ok(PREVIEW_ERROR_BRIDGE.includes("source: 'shadrox-preview'"), 'Error bridge must use explicit source identifier');
  assert.ok(PREVIEW_ERROR_BRIDGE.includes('window.addEventListener(\'error\''), 'Error bridge must listen to global errors');
  assert.ok(PREVIEW_ERROR_BRIDGE.includes('window.addEventListener(\'unhandledrejection\''), 'Error bridge must listen to unhandled rejections');
  assert.ok(PREVIEW_ERROR_BRIDGE.includes('console'), 'Error bridge must intercept console methods');
});
