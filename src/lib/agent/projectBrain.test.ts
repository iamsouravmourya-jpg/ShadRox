import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeProjectStack, formatArchitectureSummary } from './projectBrain';

test('detects Next.js App Router + TypeScript + Tailwind CSS + pnpm', () => {
  const arch = analyzeProjectStack(
    [
      'package.json',
      'pnpm-lock.yaml',
      'next.config.ts',
      'tsconfig.json',
      'components.json',
      'src/app/layout.tsx',
      'src/app/page.tsx',
      'src/components/Navbar.tsx',
      'src/lib/utils.ts'
    ],
    JSON.stringify({
      dependencies: { next: '15.0.0', react: '19.0.0', 'react-dom': '19.0.0' },
      devDependencies: { typescript: '^5.6.0', tailwindcss: '^4.0.0', '@tailwindcss/vite': '^4.0.0' },
      scripts: { dev: 'next dev', build: 'next build', lint: 'next lint' }
    })
  );

  assert.equal(arch.kind, 'framework-web');
  assert.equal(arch.framework, 'Next.js (React)');
  assert.equal(arch.routerStyle, 'App Router');
  assert.equal(arch.language, 'TypeScript');
  assert.equal(arch.packageManager, 'pnpm');
  assert.match(arch.styling ?? '', /Tailwind CSS v4/);
  assert.match(arch.styling ?? '', /shadcn\/ui/);
  assert.ok(arch.conventions.includes('src/app/'));
  assert.ok(arch.conventions.includes('src/components/'));

  const summary = formatArchitectureSummary(arch);
  assert.match(summary, /PROJECT ARCHITECTURE: Next\.js \(React\) · App Router · TypeScript/);
  assert.match(summary, /\(pnpm\)/);
  assert.match(summary, /dev="next dev"/);
});

test('detects Vite + React project and entry point', () => {
  const arch = analyzeProjectStack(
    ['package.json', 'src/main.tsx', 'src/App.tsx', 'src/index.css'],
    JSON.stringify({
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^6.0.0', typescript: '^5.6.0', tailwindcss: '^3.4.0' },
      scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' }
    })
  );

  assert.equal(arch.kind, 'framework-web');
  assert.equal(arch.framework, 'Vite + React');
  assert.equal(arch.packageManager, 'npm');
  assert.ok(arch.conventions.includes('entry: src/main.tsx'));
  assert.match(formatArchitectureSummary(arch), /Vite \+ React/);
});

test('detects Express backend and empty workspace cleanly', () => {
  const empty = analyzeProjectStack([], null);
  assert.equal(empty.kind, 'empty');
  assert.match(formatArchitectureSummary(empty), /Empty workspace/);
  assert.match(formatArchitectureSummary(empty), /never dump everything into one giant raw HTML file/i);

  const backend = analyzeProjectStack(
    ['package.json', 'api/routes.ts'],
    JSON.stringify({ dependencies: { express: '^5.0.0' }, devDependencies: { typescript: '^5.0.0' } })
  );
  assert.equal(backend.kind, 'node-backend');
  assert.equal(backend.framework, 'Node.js + Express');
  assert.ok(backend.conventions.includes('api/'));
});
