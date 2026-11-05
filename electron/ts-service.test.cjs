const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTypeScriptService, resolveLibDirectory } = require('./ts-service.cjs');

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-ts-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      allowJs: true,
      noEmit: true,
      strict: false
    },
    include: ['src']
  }, null, 2));
  fs.writeFileSync(
    path.join(root, 'src', 'math.ts'),
    'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport interface Point {\n  x: number;\n  y: number;\n}\n'
  );
  fs.writeFileSync(
    path.join(root, 'src', 'main.ts'),
    "import { add } from './math';\n\nconst total = add(1, 2);\nconst bad: string = add(1, 2);\n"
  );
  return root;
}

function createService(root) {
  return createTypeScriptService({
    getWorkspace: (workspaceId) => (workspaceId === 'ws' ? { root, mode: 'folder' } : undefined)
  });
}

test('diagnostics report semantic errors for project files only', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    const result = await service.diagnostics('ws');
    assert.ok(result.projectFiles >= 2);
    const mainErrors = result.diagnostics.filter((item) => item.file.endsWith('main.ts'));
    assert.equal(mainErrors.length, 1);
    assert.equal(mainErrors[0].severity, 'error');
    assert.equal(mainErrors[0].code, 'TS2322');
    assert.equal(mainErrors[0].line, 3);
    assert.match(mainErrors[0].message, /not assignable/i);
    assert.equal(result.diagnostics.filter((item) => item.file.endsWith('math.ts')).length, 0);
  } finally {
    service.closeWorkspace('ws');
  }
});

test('a solution-style root config follows its project references', async () => {
  const root = createFixture();
  // `npm create vite` writes exactly this shape: the root owns no files and
  // every real setting lives in the referenced config.
  fs.writeFileSync(path.join(root, 'tsconfig.app.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      allowJs: true,
      noEmit: true,
      strict: false,
      baseUrl: '.',
      paths: { '@/*': ['src/*'] }
    },
    include: ['src']
  }, null, 2));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    files: [],
    references: [{ path: './tsconfig.app.json' }]
  }, null, 2));
  fs.writeFileSync(
    path.join(root, 'src', 'alias.ts'),
    "import { add } from '@/math';\n\nexport const nine = add(4, 5);\n"
  );
  fs.mkdirSync(path.join(root, 'tools'));
  fs.writeFileSync(
    path.join(root, 'tools', 'scratch.ts'),
    'export const oops: number = "not a number";\n'
  );

  const service = createService(root);
  try {
    const result = await service.diagnostics('ws');
    assert.ok(
      result.diagnostics.every((item) => !/Cannot find module '@\/math'/.test(item.message)),
      `the referenced baseUrl/paths must apply: ${JSON.stringify(result.diagnostics.map((d) => d.message))}`
    );
    assert.ok(
      !result.diagnostics.some((item) => item.file.includes('tools/scratch.ts')),
      'files outside the referenced include list must not be analysed'
    );
    assert.equal(result.configPath, path.join(root, 'tsconfig.app.json').replace(/\\/g, '/'));
  } finally {
    service.closeWorkspace('ws');
  }
});

test('dependency declarations past the buffer limit still resolve', async () => {
  const root = createFixture();
  const pkg = path.join(root, 'node_modules', 'big-icons');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'big-icons', version: '1.0.0', typings: 'index.d.ts' })
  );
  // lucide-react ships a 2.2 MB declaration file. Cutting reads at the 2 MB
  // editor-buffer cap made every import from it report "Cannot find module".
  fs.writeFileSync(
    path.join(pkg, 'index.d.ts'),
    `/* ${'x'.repeat(2_500_000)} */\nexport declare function star(): number;\n`
  );
  fs.writeFileSync(
    path.join(root, 'src', 'icons.ts'),
    "import { star } from 'big-icons';\n\nexport const value: number = star();\n"
  );

  const service = createService(root);
  try {
    const result = await service.diagnostics('ws');
    const iconErrors = result.diagnostics.filter((item) => item.file.endsWith('icons.ts'));
    assert.deepEqual(
      iconErrors.map((item) => item.message),
      [],
      'an installed package must never resolve as missing because its .d.ts is large'
    );
  } finally {
    service.closeWorkspace('ws');
  }
});

test('unsaved buffer overrides drive diagnostics in both directions', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    const fixed = await service.diagnostics('ws', [{
      path: 'src/main.ts',
      content: "import { add } from './math';\n\nconst total = add(1, 2);\n"
    }]);
    assert.equal(fixed.diagnostics.length, 0);

    const broken = await service.diagnostics('ws', [{
      path: 'src/math.ts',
      content: 'export function add( {\n'
    }]);
    const syntaxErrors = broken.diagnostics.filter((item) => item.file.endsWith('math.ts'));
    assert.ok(syntaxErrors.length > 0);
    assert.ok(syntaxErrors.some((item) => item.severity === 'error'));
  } finally {
    service.closeWorkspace('ws');
  }
});

test('outline lists declarations with nesting and document order', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    const outline = await service.outline('ws', 'src/math.ts');
    const names = outline.map((symbol) => symbol.name);
    assert.deepEqual(names, ['add', 'Point', 'x', 'y']);
    assert.equal(outline[0].kind, 'function');
    assert.equal(outline[1].kind, 'interface');
    assert.equal(outline[2].depth, 1);
    assert.equal(outline[2].line, 5);
  } finally {
    service.closeWorkspace('ws');
  }
});

test('exported contracts are derived from TypeScript symbols and widen literal values', async () => {
  const root = createFixture();
  fs.writeFileSync(path.join(root, 'src', 'constants.ts'), 'export const label = "ok";\n');
  const service = createService(root);
  try {
    const [contract, constants] = await service.exportedContracts('ws', ['src/math.ts', 'src/constants.ts']);
    assert.equal(contract.file, 'src/math.ts');
    assert.deepEqual(contract.exports.map((entry) => entry.name), ['add', 'Point']);
    assert.match(contract.exports.find((entry) => entry.name === 'add').signature, /add: \(a: number, b: number\) => number/);
    assert.match(contract.exports.find((entry) => entry.name === 'Point').signature, /interface Point[\s\S]*x: number/);
    assert.equal(constants.exports[0].signature, 'label: string');
  } finally {
    service.closeWorkspace('ws');
  }
});

test('exported contracts honor unsaved buffers and reject paths outside the workspace', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    const [contract] = await service.exportedContracts('ws', ['src/main.ts'], [{
      path: 'src/main.ts',
      content: 'export const draft = "unsaved";\n'
    }]);
    assert.deepEqual(contract.exports, [{ name: 'draft', signature: 'draft: string' }]);
    await assert.rejects(
      () => service.exportedContracts('ws', ['../outside.ts']),
      /outside the opened workspace/i
    );
  } finally {
    service.closeWorkspace('ws');
  }
});

test('go-to-definition resolves across files', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    const definitions = await service.definition('ws', 'src/main.ts', 0, 10);
    assert.equal(definitions.length, 1);
    assert.ok(definitions[0].file.endsWith('math.ts'));
    assert.equal(definitions[0].line, 0);
    assert.equal(definitions[0].name, 'add');
  } finally {
    service.closeWorkspace('ws');
  }
});

test('workspace symbol search finds declarations and ignores empty queries', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    assert.deepEqual(await service.symbols('ws', '   '), []);
    const symbols = await service.symbols('ws', 'Point');
    assert.equal(symbols.length, 1);
    assert.ok(symbols[0].file.endsWith('math.ts'));
    assert.equal(symbols[0].name, 'Point');
    assert.equal(symbols[0].kind, 'interface');
  } finally {
    service.closeWorkspace('ws');
  }
});

test('rename rewrites the declaration and every reference it can see', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    // `add` in `export function add(...)`: line 0, character 16.
    const result = await service.rename('ws', 'src/math.ts', 0, 16, 'sum');
    assert.equal(result.canRename, true);
    assert.equal(result.reason, null);
    assert.equal(result.displayName, 'add');

    const declaration = result.edits.find((edit) => edit.file.endsWith('math.ts'));
    assert.ok(declaration);
    assert.equal(declaration.line, 0);
    assert.equal(declaration.character, 16);
    assert.equal(declaration.newText, 'sum');

    // `main.ts` mentions `add` three times: the import specifier and both calls.
    const inMain = result.edits.filter((edit) => edit.file.endsWith('main.ts'));
    assert.equal(inMain.length, 3);
    assert.ok(inMain.every((edit) => edit.newText === 'sum'));
  } finally {
    service.closeWorkspace('ws');
  }
});

test('rename refuses an empty name and a position that is not a symbol', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    const empty = await service.rename('ws', 'src/math.ts', 0, 16, '   ');
    assert.equal(empty.canRename, false);
    assert.match(empty.reason, /name is required/i);
    assert.deepEqual(empty.edits, []);

    // Line 3 of `math.ts` is blank, so the cursor touches no symbol at all.
    // (TypeScript snaps a cursor inside a keyword to the nearest identifier, so
    // `export` would legitimately rename `add`.)
    const blank = await service.rename('ws', 'src/math.ts', 3, 0, 'expose');
    assert.equal(blank.canRename, false);
    assert.deepEqual(blank.edits, []);
  } finally {
    service.closeWorkspace('ws');
  }
});

test('code actions offer a fix for the diagnostic under the cursor', async () => {
  const root = createFixture();
  // A reassigned `const` is one of the few diagnostics TypeScript ships a
  // built-in fix for (`Convert 'const' to 'let'`); a plain type mismatch such as
  // TS2322 offers nothing, so it cannot exercise this path.
  fs.writeFileSync(path.join(root, 'src', 'fixable.ts'), 'const frozen = 1;\nfrozen = 2;\n');
  const service = createService(root);
  try {
    // Nothing to fix on line 0 of `main.ts`.
    assert.deepEqual(await service.codeActions('ws', 'src/main.ts', 0, 0, 0, 0), []);

    // `frozen = 2` raises TS2588 on the assignment target.
    const actions = await service.codeActions('ws', 'src/fixable.ts', 1, 0, 1, 6);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].name, 'fixConvertConstToLet');
    assert.match(actions[0].description, /const/i);

    const edit = actions[0].changes.find((change) => change.file.endsWith('fixable.ts'));
    assert.ok(edit);
    assert.equal(edit.line, 0);
    assert.equal(edit.character, 0);
    assert.equal(edit.endCharacter, 5);
    assert.equal(edit.newText, 'let');
  } finally {
    service.closeWorkspace('ws');
  }
});

test('semantic tokens name declarations with the classifier vocabulary', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    const tokens = await service.semanticTokens('ws', 'src/math.ts');
    assert.ok(tokens.length > 0);
    // `export function add(...)` — `add` is at line 0, character 16.
    const addToken = tokens.find((token) => token.line === 0 && token.character === 16);
    assert.equal(addToken?.type, 'function');
    // `export interface Point {` sits on line 4 — line 3 is the blank separator.
    const pointToken = tokens.find((token) => token.line === 4 && token.character === 17);
    assert.equal(pointToken?.type, 'interface');
  } finally {
    service.closeWorkspace('ws');
  }
});

test('the extraResources lib folder is preferred over the stripped bundled one', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-resources-'));
  const libName = 'lib.es2022.d.ts';
  const native = path.join(resources, 'app.asar', 'node_modules', 'typescript-legacy', 'lib');
  const copied = path.join(resources, 'ts-libs');
  fs.mkdirSync(native, { recursive: true });
  fs.mkdirSync(copied, { recursive: true });
  fs.writeFileSync(path.join(native, libName), '');
  fs.writeFileSync(path.join(copied, libName), '');
  const fakeTs = { getDefaultLibFilePath: () => path.join(native, libName) };
  const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  const previousResources = process.resourcesPath;
  try {
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
    // electron-builder removes every *.d.ts from the app.asar, so the native
    // folder is empty in an installed build; the copy must take over.
    assert.ok(same(resolveLibDirectory(fakeTs, {}), copied), 'the packaged lib copy should win');
    fs.rmSync(path.join(copied, libName));
    assert.ok(same(resolveLibDirectory(fakeTs, {}), native), 'a dev install keeps the bundled folder');
    Object.defineProperty(process, 'resourcesPath', { value: undefined, configurable: true, writable: true });
    assert.ok(same(resolveLibDirectory(fakeTs, {}), native), 'the browser-like case keeps the bundled folder');
  } finally {
    Object.defineProperty(process, 'resourcesPath', { value: previousResources, configurable: true, writable: true });
    fs.rmSync(resources, { recursive: true, force: true });
  }
});

test('paths outside the workspace and unknown workspaces are rejected', async () => {
  const root = createFixture();
  const service = createService(root);
  try {
    await assert.rejects(
      () => service.outline('ws', '../outside.ts'),
      /outside the opened workspace/i
    );
    await assert.rejects(
      () => service.definition('ws', 'C:/Windows/win.ini', 0, 0),
      /Absolute paths are not allowed/i
    );
    await assert.rejects(
      () => service.diagnostics('missing'),
      /no longer open/i
    );
  } finally {
    service.closeWorkspace('ws');
  }
});
