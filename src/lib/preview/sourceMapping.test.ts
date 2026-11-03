import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectPreviewSources,
  inlinedSourceFiles,
  matchWorkspaceFile,
  parseStackFrames,
  servedPathToWorkspaceFile,
  sourceFromStack,
  workspacePathFromFrameFile
} from './sourceMapping';

const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'map')",
  '    at ProductList (http://127.0.0.1:5173/src/components/ProductList.tsx:23:14)',
  '    at renderWithHooks (http://127.0.0.1:5173/node_modules/react-dom/cjs/react-dom.development.js:14985:18)',
  '    at http://127.0.0.1:5173/src/main.tsx:7:3',
  '    at ModuleJob.run (node:internal/modules/esm/module_job:218:25)'
].join('\n');

test('workspacePathFromFrameFile keeps project code and drops everything else', () => {
  assert.equal(
    workspacePathFromFrameFile('http://127.0.0.1:5173/src/components/ProductList.tsx'),
    'src/components/ProductList.tsx'
  );
  assert.equal(workspacePathFromFrameFile('http://localhost:3000/pages/api/checkout.ts'), 'pages/api/checkout.ts');
  assert.equal(workspacePathFromFrameFile('C:/Users/me/proj/src/App.tsx?t=17'), 'src/App.tsx');
  assert.equal(workspacePathFromFrameFile('webpack://project/./src/App.vue'), 'src/App.vue');
  assert.equal(workspacePathFromFrameFile('index.html'), 'index.html');

  assert.equal(workspacePathFromFrameFile('http://127.0.0.1:5173/node_modules/react-dom/x.js'), null);
  assert.equal(workspacePathFromFrameFile('node:internal/modules/esm/module_job'), null);
  assert.equal(workspacePathFromFrameFile('https://cdn.example.com/src/fake.ts'), null);
  assert.equal(workspacePathFromFrameFile('http://127.0.0.1:5173/logo.png'), null);
  assert.equal(workspacePathFromFrameFile('../escape/src/App.tsx'), null);
  assert.equal(workspacePathFromFrameFile(''), null);
});

test('parseStackFrames reports the line and column the runtime gave, deduplicated', () => {
  assert.deepEqual(parseStackFrames(STACK), [
    { path: 'src/components/ProductList.tsx', line: 23, character: 14 },
    { path: 'src/main.tsx', line: 7, character: 3 }
  ]);
  assert.deepEqual(parseStackFrames(STACK + '\n' + STACK), parseStackFrames(STACK));
  assert.deepEqual(parseStackFrames(''), []);
  assert.deepEqual(parseStackFrames('boom at nothing here'), []);
});

test('sourceFromStack is the nearest frame or nothing at all', () => {
  assert.deepEqual(sourceFromStack(STACK), { path: 'src/components/ProductList.tsx', line: 23, character: 14 });
  assert.equal(sourceFromStack(undefined), null);
  assert.equal(sourceFromStack('Error: plain'), null);
});

test('matchWorkspaceFile only accepts exact or unambiguous candidates', () => {
  const files = [{ name: 'src/App.tsx' }, { name: 'README.md' }];
  assert.equal(matchWorkspaceFile('src/App.tsx', files), 'src/App.tsx');
  assert.equal(matchWorkspaceFile('SRC/app.TSX', files), 'src/App.tsx');
  assert.equal(matchWorkspaceFile('App.tsx', files), 'src/App.tsx');
  assert.equal(matchWorkspaceFile('missing.tsx', files), null);
  assert.equal(matchWorkspaceFile('App.tsx', []), null);

  const ambiguous = [{ name: 'src/App.tsx' }, { name: 'lib/App.tsx' }];
  assert.equal(matchWorkspaceFile('App.tsx', ambiguous), null, 'two equally good hits is a guess, not a match');
  assert.equal(matchWorkspaceFile('lib/App.tsx', ambiguous), 'lib/App.tsx');
});

test('servedPathToWorkspaceFile resolves the URLs a preview server actually serves', () => {
  const files = [
    { name: 'index.html' },
    { name: 'about/index.html' },
    { name: 'pricing.html' },
    { name: 'assets/app.js' },
    { name: 'src/main.tsx' }
  ];
  assert.equal(servedPathToWorkspaceFile('http://127.0.0.1:4173/', files), 'index.html');
  assert.equal(servedPathToWorkspaceFile('http://127.0.0.1:4173/assets/app.js', files), 'assets/app.js');
  assert.equal(servedPathToWorkspaceFile('http://127.0.0.1:4173/about/', files), 'about/index.html');
  assert.equal(servedPathToWorkspaceFile('http://127.0.0.1:4173/about', files), 'about/index.html');
  assert.equal(servedPathToWorkspaceFile('http://127.0.0.1:4173/pricing', files), 'pricing.html');
  assert.equal(servedPathToWorkspaceFile('http://127.0.0.1:4173/src/main.tsx?t=1', files), 'src/main.tsx');
  assert.equal(servedPathToWorkspaceFile('http://127.0.0.1:4173/nope', files), null);
  assert.equal(servedPathToWorkspaceFile(null, files), null);
  assert.equal(servedPathToWorkspaceFile('http://127.0.0.1:4173/', []), null);
});

test('inlinedSourceFiles reads back the data-source markers of inlined workspace assets', () => {
  const html = [
    '<style data-source="src/index.css">body{}</style>',
    "<script data-source='assets/app.js'></script>",
    '<style data-source="src/index.css">dup</style>',
    '<div>nothing</div>'
  ].join('\n');
  assert.deepEqual(inlinedSourceFiles(html), ['src/index.css', 'assets/app.js']);
  assert.deepEqual(inlinedSourceFiles(''), []);
});

test('collectPreviewSources orders evidence most specific first and de-duplicates', () => {
  const files = [
    { name: 'src/components/ProductList.tsx' },
    { name: 'index.html' },
    { name: 'src/index.css' }
  ];
  const sources = collectPreviewSources({
    stack: STACK,
    pageUrl: 'http://127.0.0.1:5173/src/components/ProductList.tsx',
    revealPath: 'index.html',
    html: '<style data-source="src/index.css"></style>',
    files
  });
  assert.deepEqual(sources, ['src/components/ProductList.tsx', 'index.html', 'src/index.css']);

  assert.deepEqual(collectPreviewSources({ files }), []);
  assert.deepEqual(
    collectPreviewSources({ pageUrl: 'http://127.0.0.1:5173/index.html', files: [{ name: 'index.html' }] }),
    ['index.html']
  );
});
