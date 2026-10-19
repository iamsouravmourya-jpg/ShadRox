import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const stagingDirectory = path.join(projectDirectory, 'dist_staging');
const outputDirectory = path.join(projectDirectory, 'dist_desktop');
const heapLimit = '--max-old-space-size=12288';
const env = { ...process.env, NODE_OPTIONS: heapLimit };
const isWindows = process.platform === 'win32';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectDirectory,
    env,
    stdio: 'inherit',
    shell: options.shell ?? isWindows,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function copyIntoStage(source, destination) {
  fs.cpSync(path.join(projectDirectory, source), path.join(stagingDirectory, destination), {
    recursive: true,
    force: true,
  });
}

run(isWindows ? 'npm.cmd' : 'npm', ['run', 'build']);

// The packaged main process starts server.ts and imports the local providers;
// include these runtime files along with Electron's main-process modules.
if (path.resolve(stagingDirectory) !== path.join(projectDirectory, 'dist_staging')) {
  throw new Error('Refusing to clean an unexpected staging path.');
}
fs.rmSync(stagingDirectory, { recursive: true, force: true });
fs.mkdirSync(stagingDirectory, { recursive: true });
copyIntoStage('dist', 'dist');
copyIntoStage('electron', 'electron');
copyIntoStage('api', 'api');
copyIntoStage('src/lib/providers.ts', 'src/lib/providers.ts');
copyIntoStage('server.ts', 'server.ts');
copyIntoStage('package-lock.json', 'package-lock.json');
copyIntoStage('.npmrc', '.npmrc');

const packageJson = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'));
const electronPackage = JSON.parse(fs.readFileSync(
  path.join(projectDirectory, 'node_modules', 'electron', 'package.json'),
  'utf8',
));
packageJson.build.electronVersion = electronPackage.version;
packageJson.build.directories.output = outputDirectory;
fs.writeFileSync(path.join(stagingDirectory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

run(isWindows ? 'npm.cmd' : 'npm', [
  'install',
  '--production',
  '--no-audit',
  '--no-fund',
], { cwd: stagingDirectory });

// npm needs the full lockfile for a reproducible production install. Once that
// install is complete, keep the packaged manifest focused on runtime modules.
const stagedPackagePath = path.join(stagingDirectory, 'package.json');
const stagedPackage = JSON.parse(fs.readFileSync(stagedPackagePath, 'utf8'));
delete stagedPackage.devDependencies;
fs.writeFileSync(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
fs.rmSync(path.join(stagingDirectory, 'package-lock.json'), { force: true });

run(process.execPath, [
  path.join(projectDirectory, 'node_modules', 'electron-builder', 'cli.js'),
  '--projectDir',
  stagingDirectory,
  ...process.argv.slice(2),
], { shell: false });
