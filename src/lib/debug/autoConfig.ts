import type { DebugLaunchConfig } from '../desktop';

/**
 * Automatically infers ready-to-run debug configurations for a workspace
 * by inspecting package.json and entry files when shadrox.debug.json is absent.
 */
export function inferAutoDebugConfigs(workspaceRoot: string, files: Array<{ name: string; content?: string }>): DebugLaunchConfig[] {
  const configs: DebugLaunchConfig[] = [];
  const fileNames = new Set(files.map((f) => f.name.replace(/\\/g, '/')));

  let mainProgram = 'src/index.js';
  if (fileNames.has('server.ts')) mainProgram = 'server.ts';
  else if (fileNames.has('server.js')) mainProgram = 'server.js';
  else if (fileNames.has('src/main.ts')) mainProgram = 'src/main.ts';
  else if (fileNames.has('src/index.ts')) mainProgram = 'src/index.ts';
  else if (fileNames.has('src/App.tsx')) mainProgram = 'src/App.tsx';

  configs.push({
    name: 'Node.js / TypeScript App',
    type: 'node',
    request: 'launch',
    program: mainProgram,
    adapterCommand: 'js-debug-adapter'
  });

  if (fileNames.has('package.json')) {
    configs.push({
      name: 'Vite / Web Dev Server',
      type: 'node',
      request: 'launch',
      program: 'node_modules/vite/bin/vite.js',
      args: ['--host', '0.0.0.0', '--port', '3000'],
      adapterCommand: 'js-debug-adapter'
    });
  }

  if (fileNames.has('main.py') || fileNames.has('app.py')) {
    configs.push({
      name: 'Python Main Script',
      type: 'node', // or python adapter if supported, fallback to node type for schema compatibility
      request: 'launch',
      program: fileNames.has('main.py') ? 'main.py' : 'app.py',
      adapterCommand: 'js-debug-adapter'
    });
  }

  return configs;
}
