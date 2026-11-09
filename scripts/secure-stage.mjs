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

  const preloadBundle = path.join(electronDirectory, 'preload.bundle.cjs');
  await bundle(path.join(sourceElectronDirectory, 'preload.cjs'), preloadBundle, ['electron']);
  await compile(preloadBundle, path.join(electronDirectory, 'preload.jsc'), {
    electron: true,
    electronRenderer: true
  });

  const serverBundle = outputPath('server.bundle.cjs');
  await bundle(path.join(projectDirectory, 'server.ts'), serverBundle, ['express', 'dotenv', 'vite']);
  await compile(serverBundle, outputPath('server.jsc'));

  fs.copyFileSync(path.join(sourceElectronDirectory, 'loader.cjs'), path.join(electronDirectory, 'loader.cjs'));
  fs.copyFileSync(
    path.join(sourceElectronDirectory, 'preload-loader.cjs'),
    path.join(electronDirectory, 'preload-loader.cjs')
  );
  for (const entry of fs.readdirSync(electronDirectory)) {
    if (!['loader.cjs', 'main.jsc', 'preload-loader.cjs', 'preload.jsc'].includes(entry)) {
      fs.rmSync(path.join(electronDirectory, entry), { recursive: true, force: true });
    }
  }
  fs.rmSync(serverBundle, { force: true });
  fs.rmSync(path.join(stagingDirectory, 'api'), { recursive: true, force: true });
  fs.rmSync(path.join(stagingDirectory, 'src', 'lib'), { recursive: true, force: true });
  fs.rmSync(path.join(stagingDirectory, 'server.ts'), { force: true });
}

await main();
