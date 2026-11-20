import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatWorkspaceManifestBlock,
  parseJsonWithComments,
  parseWorkspaceManifest
} from './workspaceManifest';

test('parseJsonWithComments strips JSONC line/block comments and trailing commas while preserving URLs in strings', () => {
  const raw = `{
    // TypeScript compiler config
    "compilerOptions": {
      "baseUrl": ".",
      /* keep string literals intact */
      "schemaUrl": "https://json.schemastore.org/tsconfig/*keep*/",
      "paths": {
        "@/*": ["src/*"],
      },
    },
  }`;
  const parsed = parseJsonWithComments(raw) as { compilerOptions: { baseUrl: string; schemaUrl: string; paths: Record<string, string[]> } };
  assert.equal(parsed.compilerOptions.baseUrl, '.');
  assert.equal(parsed.compilerOptions.schemaUrl, 'https://json.schemastore.org/tsconfig/*keep*/');
  assert.deepEqual(parsed.compilerOptions.paths, { '@/*': ['src/*'] });
});

test('parseWorkspaceManifest extracts dependencies, devDependencies, scripts, and tsconfig path aliases', () => {
  const pkg = JSON.stringify({
    scripts: { dev: 'vite', build: 'tsc && vite build' },
    dependencies: { react: '^19.0.0', express: '^4.21.0' },
    devDependencies: { typescript: '^5.7.0', vitest: '^3.0.0' }
  });
  const tsconfig = `{
    // standard app tsconfig
    "compilerOptions": {
      "baseUrl": ".",
      "paths": {
        "@/*": ["./src/*"],
        "@shared/*": ["./shared/*"]
      }
    }
  }`;
  const manifest = parseWorkspaceManifest(pkg, tsconfig);
  assert.equal(manifest.hasPackageJson, true);
  assert.equal(manifest.hasTsconfig, true);
  assert.deepEqual(manifest.dependencies, { react: '^19.0.0', express: '^4.21.0' });
  assert.deepEqual(manifest.devDependencies, { typescript: '^5.7.0', vitest: '^3.0.0' });
  assert.equal(manifest.baseUrl, '.');
  assert.deepEqual(manifest.pathAliases, {
    '@/*': ['./src/*'],
    '@shared/*': ['./shared/*']
  });

  const block = formatWorkspaceManifestBlock(manifest);
  assert.match(block, /express@\^4\.21\.0/);
  assert.match(block, /typescript@\^5\.7\.0/);
  assert.match(block, /@\/\* -> \.\/src\/\*/);
  assert.match(block, /NEVER import external packages not explicitly listed in `package\.json`/);
  assert.match(block, /zero-dependency native TypeScript implementations/i);
});

test('parseWorkspaceManifest degrades gracefully on missing or malformed config files', () => {
  const manifest = parseWorkspaceManifest('{bad json', undefined);
  assert.equal(manifest.hasPackageJson, false);
  assert.equal(manifest.hasTsconfig, false);
  const block = formatWorkspaceManifestBlock(manifest);
  assert.match(block, /\(no package\.json found\)/);
  assert.match(block, /\(no tsconfig\.json found\)/);
});
