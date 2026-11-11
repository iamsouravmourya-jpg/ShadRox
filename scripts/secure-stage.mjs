import { build } from 'esbuild';
import bytenode from 'bytenode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingDirectory = path.join(projectDirectory, 'dist_staging');
const electronDirectory = path.join(stagingDirectory, 'electron');
const sourceElectronDirectory = path.join(projectDirectory, 'electron');

function outputPath(name) {
  return path.join(stagingDirectory, name);
}

async function bundle(entryPoint, outfile, external) {
  await build({
    bundle: true,
    entryPoints: [entryPoint],
    external,
    format: 'cjs',
    outfile,
    platform: 'node',
    sourcemap: false,
    target: 'node22'
  });
}

async function compile(source, output, options = {}) {
  await bytenode.compileFile({
    filename: source,
    output,
    ...options
  });
  fs.rmSync(source, { force: true });
}

// Deliberately lighter than the renderer's vite obfuscation profile: the
// worker bundle inlines the TypeScript compiler (~10MB), where control-flow
// flattening and dead-code injection would multiply build time and memory for
// no extra protection of our own logic. stringArray still strips every
// readable literal and identifier from the shipped file.
async function obfuscateFile(file) {
  const { default: JavaScriptObfuscator } = await import('javascript-obfuscator');
  const source = fs.readFileSync(file, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(source, {
    compact: true,
    identifierNamesGenerator: 'hexadecimal',
    selfDefending: false,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 1,
    target: 'node'
  });
  fs.writeFileSync(file, result.getObfuscatedCode(), 'utf8');
}

async function main() {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('Secure staging requires NODE_ENV=production.');
  }

  fs.mkdirSync(electronDirectory, { recursive: true });

  const mainBundle = path.join(electronDirectory, 'main.bundle.cjs');
  await bundle(path.join(sourceElectronDirectory, 'main.cjs'), mainBundle, [
    'electron',
    'node-pty',
    'chokidar',
    'electron-updater',
    'tree-kill'
  ]);
  await compile(mainBundle, path.join(electronDirectory, 'main.jsc'), {
    electron: true,
    electronMain: true
  });

  const serverBundle = outputPath('server.bundle.cjs');
  await bundle(path.join(projectDirectory, 'server.ts'), serverBundle, ['express', 'dotenv', 'vite']);
  await compile(serverBundle, outputPath('server.jsc'), {
    electron: true,
    electronMain: true
  });

  // The diagnostics worker is spawned by file path at runtime
  // (new Worker(__dirname + '/ts-worker.cjs')), so it must survive as a real
  // file. Bundle it standalone — its require of ts-service.cjs (and that
  // module's desktop-security) would otherwise point at sources the cleanup
  // loop deletes. typescript-legacy stays external: inlining the compiler
  // would make this the one readable source file in the shipped app, and the
  // worker thread shares the main process's module resolution, so the bare
  // require still resolves inside app.asar.
  const workerPath = path.join(electronDirectory, 'ts-worker.cjs');
  await bundle(
    path.join(sourceElectronDirectory, 'ts-worker.cjs'),
    workerPath,
    ['typescript-legacy']
  );
  if (process.env.SHADROX_OBFUSCATE !== '0') await obfuscateFile(workerPath);

  fs.copyFileSync(path.join(sourceElectronDirectory, 'loader.cjs'), path.join(electronDirectory, 'loader.cjs'));
  for (const entry of fs.readdirSync(electronDirectory)) {
    if (!['loader.cjs', 'main.jsc', 'preload.cjs', 'ts-worker.cjs', 'shell-integration'].includes(entry)) {
      fs.rmSync(path.join(electronDirectory, entry), { recursive: true, force: true });
    }
  }
  fs.rmSync(serverBundle, { force: true });
  fs.rmSync(path.join(stagingDirectory, 'api'), { recursive: true, force: true });
  fs.rmSync(path.join(stagingDirectory, 'src', 'lib'), { recursive: true, force: true });
  fs.rmSync(path.join(stagingDirectory, 'server.ts'), { force: true });
}

await main();
