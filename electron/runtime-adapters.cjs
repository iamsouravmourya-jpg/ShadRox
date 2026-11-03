/**
 * Runtime adapters for local preview.
 *
 * This module is deliberately pure: it inspects a list of workspace-relative
 * file paths (plus optional manifest text supplied by the caller) and derives
 * deterministic preview plans. It never reads the disk, never spawns a child
 * process, and never probes a port. `electron/preview-runtime.cjs` remains the
 * only component that executes a plan, after the normal approval gate.
 */

/**
 * A preview plan is intentionally data-only. `cwd` and `entry` are
 * workspace-relative, and `entry` always names the file that justified the
 * adapter even when the command runs from a nested directory. A static plan
 * has `command: null`; the caller must route it to the static file server
 * instead of spawning a process.
 *
 * @typedef {Object} PreviewPlan
 * @property {'frontend'|'backend'} kind
 * @property {string} adapter
 * @property {string|null} command
 * @property {string[]} args
 * @property {string} cwd
 * @property {number} port
 * @property {string} healthPath
 * @property {string} entry
 */

const PORT_TOKEN = '{port}';
const DEFAULT_FRONTEND_PORT = 5173;
const DEFAULT_BACKEND_PORT = 8000;
const MAX_RELATIVE_PATH_LENGTH = 4096;

const IGNORED_SEGMENTS = new Set([
  '.git', '.next', '.cache', '.turbo', '.vercel',
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor'
]);

const ADAPTER_PRIORITY = ['node', 'static', 'python', 'go', 'php', 'java', 'dotnet'];
const BACKEND_PRIORITY = ['python', 'go', 'php', 'java', 'dotnet'];
const FRONTEND_PRIORITY = ['node', 'static'];
const NODE_SCRIPT_NAMES = ['dev', 'start', 'preview', 'serve'];
const PYTHON_ENTRY_NAMES = ['main.py', 'app.py', 'manage.py', 'src/main.py'];

function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function depthOf(relativePath) {
  return relativePath === '.' ? 0 : relativePath.split('/').filter(Boolean).length;
}

function comparePaths(a, b) {
  const depth = depthOf(a) - depthOf(b);
  if (depth !== 0) return depth;
  return compareStrings(a, b);
}

/**
 * Normalize a workspace-relative path to POSIX separators.
 * Returns null for absolute paths, parent traversal, NUL bytes, and Windows
 * alternate-data-stream separators. Backslashes are treated as separators,
 * because callers on Windows routinely produce them.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeRelativePath(value) {
  if (typeof value !== 'string') return null;
  if (!value || value.length > MAX_RELATIVE_PATH_LENGTH) return null;
  if (value.includes('\0')) return null;

  const slashed = value.replace(/\\/g, '/');
  if (slashed.startsWith('/') || slashed.startsWith('~')) return null;
  if (/^[A-Za-z]:/.test(slashed)) return null;

  const segments = [];
  for (const segment of slashed.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    // Reject NTFS streams and other drive-like segments. A colon is never
    // needed in a project-relative file path and is an escape vector on Windows.
    if (segment.includes(':') || segment.includes('\0')) return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return segments.join('/');
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeRelativePath(value) {
  return normalizeRelativePath(value) !== null;
}

function describeValue(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    text = '<unprintable>';
  }
  return JSON.stringify(text.slice(0, 200));
}

function fileNameOf(relativePath) {
  const index = relativePath.lastIndexOf('/');
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}

function directoryOf(relativePath) {
  const index = relativePath.lastIndexOf('/');
  return index === -1 ? '.' : relativePath.slice(0, index);
}

function joinRelative(base, relative) {
  return base === '.' ? relative : `${base}/${relative}`;
}

function relativeFrom(base, fullPath) {
  if (base === '.') return fullPath;
  const prefix = `${base}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : null;
}

function isIgnoredPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return true;
  const segments = normalized.split('/');
  return segments.slice(0, -1).some((segment) => IGNORED_SEGMENTS.has(segment));
}

function normalizeCommandName(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    ? value
    : fallback;
}

function normalizePort(value) {
  const port = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function findManifestValue(manifests, relativePath) {
  if (manifests instanceof Map) {
    for (const [key, value] of manifests) {
      if (normalizeRelativePath(key) === relativePath) return { found: true, value };
    }
    return { found: false, value: undefined };
  }
  if (manifests && typeof manifests === 'object') {
    for (const key of Object.keys(manifests)) {
      if (normalizeRelativePath(key) === relativePath) return { found: true, value: manifests[key] };
    }
  }
  return { found: false, value: undefined };
}

/**
 * Manifest text is supplied explicitly so detection stays pure and testable.
 * `manifests` may be a plain object or a Map keyed by workspace-relative path.
 * A synchronous `readFile` callback is also accepted for callers that already
 * have safe access to the workspace.
 *
 * @param {string} relativePath
 * @param {{ manifests?: Record<string, string>|Map<string, string>, readFile?: (path: string) => string|null|undefined }} options
 * @returns {{ text: string|null, error: string|null }}
 */
function readManifest(relativePath, options) {
  const match = findManifestValue(options.manifests, relativePath);
  if (match.found) {
    if (typeof match.value === 'string') return { text: match.value, error: null };
    if (Buffer.isBuffer(match.value)) return { text: match.value.toString('utf8'), error: null };
    return { text: null, error: `manifest content for "${relativePath}" must be a string.` };
  }
  if (typeof options.readFile === 'function') {
    try {
      const value = options.readFile(relativePath);
      if (typeof value === 'string') return { text: value, error: null };
      if (Buffer.isBuffer(value)) return { text: value.toString('utf8'), error: null };
      if (value === null || value === undefined) return { text: null, error: null };
      return { text: null, error: `readFile("${relativePath}") must return text synchronously.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { text: null, error: message };
    }
  }
  return { text: null, error: null };
}

function getNodeScript(manifest) {
  const scripts = manifest && typeof manifest.scripts === 'object' && manifest.scripts;
  if (!scripts) return null;
  for (const name of NODE_SCRIPT_NAMES) {
    if (typeof scripts[name] === 'string' && scripts[name].trim()) {
      return { name, command: scripts[name].trim() };
    }
  }
  return null;
}

function getNodeRunArgs(scriptName, scriptCommand) {
  const command = scriptCommand.toLowerCase();
  const args = ['run', scriptName];
  // Bind supported dev servers to loopback. A generic "node server.js" script
  // is left untouched: it may already hard-code its own port and host.
  if (/\b(vite|astro|nuxt|webpack-dev-server|webpack|parcel|svelte-kit|remix|ng|angular)\b/.test(command)) {
    args.push('--', '--host', '127.0.0.1', '--port', PORT_TOKEN);
  } else if (/\bnext\b/.test(command)) {
    args.push('--', '--hostname', '127.0.0.1', '--port', PORT_TOKEN);
  }
  return args;
}

function detectNode(files, options, addError) {
  const results = [];
  const manifests = files
    .filter((file) => fileNameOf(file).toLowerCase() === 'package.json')
    .sort(comparePaths);
  if (options.packageManager !== undefined &&
      normalizeCommandName(options.packageManager, null) === null) {
    addError(`packageManager ${describeValue(options.packageManager)} is not a valid executable name; using "npm".`);
  }
  const packageManager = normalizeCommandName(options.packageManager, 'npm');

  for (const manifestPath of manifests) {
    const { text, error } = readManifest(manifestPath, options);
    if (error) {
      addError(`Node project at "${manifestPath}" could not be inspected: ${error}`);
      continue;
    }
    if (text === null) {
      addError(`Node project at "${manifestPath}" requires package.json content to confirm a dev or start script.`);
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      addError(`Node project at "${manifestPath}" contains invalid package.json JSON.`);
      continue;
    }

    const script = getNodeScript(manifest);
    if (!script) {
      addError(`Node project at "${manifestPath}" has no dev, start, preview, or serve script.`);
      continue;
    }

    results.push({
      kind: 'frontend',
      adapter: 'node',
      command: packageManager,
      args: getNodeRunArgs(script.name, script.command),
      cwd: directoryOf(manifestPath),
      healthPath: '/',
      entry: manifestPath
    });
  }
  return results;
}

function detectStatic(files) {
  return files
    .filter((file) => fileNameOf(file).toLowerCase() === 'index.html')
    .sort(comparePaths)
    .map((entry) => ({
      kind: 'frontend',
      adapter: 'static',
      command: null,
      args: [],
      cwd: directoryOf(entry),
      healthPath: '/',
      entry
    }));
}

function findPythonEntry(projectDirectory, pythonFiles) {
  const fileSet = new Set(pythonFiles);
  for (const candidate of PYTHON_ENTRY_NAMES) {
    const fullPath = joinRelative(projectDirectory, candidate);
    if (fileSet.has(fullPath)) return fullPath;
  }

  // Fall back to a differently nested main entry, but only below the detected
  // project directory and never across an ignored dependency directory.
  const fallback = pythonFiles
    .filter((file) => {
      const relative = relativeFrom(projectDirectory, file);
      if (relative === null) return false;
      const name = fileNameOf(file);
      return name === 'main.py' || name === 'app.py' || name === 'manage.py';
    })
    .sort(comparePaths);
  return fallback.length > 0 ? fallback[0] : null;
}

function pythonUsesAsgi(markerPaths, options, addError) {
  for (const manifestPath of markerPaths) {
    const { text, error } = readManifest(manifestPath, options);
    if (error) {
      addError(`Python project manifest "${manifestPath}" could not be inspected: ${error}`);
      continue;
    }
    if (text && /\b(fastapi|uvicorn)\b/i.test(text)) return true;
  }
  return false;
}

function detectPython(files, options, addError) {
  const markers = files.filter((file) => {
    const name = fileNameOf(file).toLowerCase();
    return name === 'pyproject.toml' || name === 'requirements.txt';
  });
  if (markers.length === 0) return [];

  let command = 'python';
  if (options.pythonCommand !== undefined) {
    const candidate = normalizeCommandName(options.pythonCommand, null);
    if (candidate) command = candidate;
    else addError(`pythonCommand ${describeValue(options.pythonCommand)} is not a valid executable name; using "python".`);
  }

  const markersByDirectory = new Map();
  for (const marker of markers.sort(comparePaths)) {
    const directory = directoryOf(marker);
    if (!markersByDirectory.has(directory)) markersByDirectory.set(directory, []);
    markersByDirectory.get(directory).push(marker);
  }

  const pythonFiles = files.filter((file) => file.toLowerCase().endsWith('.py'));
  const results = [];
  for (const directory of [...markersByDirectory.keys()].sort(comparePaths)) {
    const entry = findPythonEntry(directory, pythonFiles);
    if (!entry) {
      addError(`Python project at "${directory}" has no main.py, app.py, manage.py, or src/main.py entry.`);
      continue;
    }

    const entryName = fileNameOf(entry);
    const entryModule = entryName.replace(/\.py$/i, '');
    const cwd = directoryOf(entry);
    const useUvicorn = entryName !== 'manage.py' &&
      pythonUsesAsgi(markersByDirectory.get(directory), options, addError);

    results.push({
      kind: 'backend',
      adapter: 'python',
      command,
      // A framework only gets the ASGI command when its manifest explicitly
      // names FastAPI or Uvicorn. Absent evidence, run the entry file directly.
      args: useUvicorn
        ? ['-m', 'uvicorn', `${entryModule}:app`, '--port', PORT_TOKEN]
        : [entryName],
      cwd,
      healthPath: '/',
      entry
    });
  }
  return results;
}

function detectGo(files, addError) {
  const markers = files
    .filter((file) => fileNameOf(file).toLowerCase() === 'go.mod')
    .sort(comparePaths);
  const results = [];
  for (const marker of markers) {
    const directory = directoryOf(marker);
    const rootEntry = joinRelative(directory, 'main.go');
    let entry = files.includes(rootEntry) ? rootEntry : null;

    if (!entry) {
      const commandEntries = files
        .filter((file) => {
          const relative = relativeFrom(directory, file);
          return relative !== null && /^cmd\/[^/]+\/main\.go$/.test(relative);
        })
        .sort(comparePaths);
      if (commandEntries.length > 0) entry = commandEntries[0];
    }

    if (!entry) {
      addError(`Go project at "${directory}" has no main.go or cmd/*/main.go entry.`);
      continue;
    }

    results.push({
      kind: 'backend',
      adapter: 'go',
      command: 'go',
      args: ['run', relativeFrom(directory, entry)],
      cwd: directory,
      healthPath: '/',
      entry
    });
  }
  return results;
}

function detectPhp(files, addError) {
  const indexes = files
    .filter((file) => fileNameOf(file).toLowerCase() === 'index.php')
    .sort(comparePaths);
  const projects = new Map();

  for (const entry of indexes) {
    const directory = directoryOf(entry);
    const parentName = fileNameOf(directory);
    const projectDirectory = parentName === 'public' ? directoryOf(directory) : directory;
    const docroot = parentName === 'public' ? 'public' : '.';
    // A root index.php wins over public/index.php for the same project.
    if (!projects.has(projectDirectory)) {
      projects.set(projectDirectory, { entry, docroot });
    }
  }

  if (indexes.length === 0 && files.some((file) => file.toLowerCase().endsWith('.php'))) {
    addError('PHP files were found but no index.php or public/index.php entry exists.');
  }

  return [...projects.keys()].sort(comparePaths).map((projectDirectory) => {
    const project = projects.get(projectDirectory);
    return {
      kind: 'backend',
      adapter: 'php',
      command: 'php',
      args: ['-S', `127.0.0.1:${PORT_TOKEN}`, '-t', project.docroot],
      cwd: projectDirectory,
      healthPath: '/',
      entry: project.entry
    };
  });
}

function detectJava(files, options, addError) {
  const results = [];
  const poms = files
    .filter((file) => fileNameOf(file).toLowerCase() === 'pom.xml')
    .sort(comparePaths);

  for (const pomPath of poms) {
    const directory = directoryOf(pomPath);
    const { text, error } = readManifest(pomPath, options);
    if (error) {
      addError(`Java Maven project at "${directory}" could not be inspected: ${error}`);
      continue;
    }
    if (text === null) {
      addError(`Java Maven project at "${directory}" requires pom.xml content to confirm Spring Boot.`);
      continue;
    }
    if (!/spring-boot/i.test(text)) {
      addError(`Java Maven project at "${directory}" does not declare Spring Boot; no Java preview adapter was planned.`);
      continue;
    }

    const hasWrapper = files.some((file) =>
      file === joinRelative(directory, 'mvnw') || file === joinRelative(directory, 'mvnw.cmd')
    );
    results.push({
      kind: 'backend',
      adapter: 'java',
      command: hasWrapper ? 'mvnw' : 'mvn',
      args: ['spring-boot:run'],
      cwd: directory,
      healthPath: '/',
      entry: pomPath
    });
  }

  // Gradle is intentionally not executed. A detected Spring Boot Gradle build
  // gets an explanation instead of a silent "no adapter" result.
  for (const gradlePath of files.filter((file) => /(^|\/)build\.gradle(?:\.kts)?$/i.test(file))) {
    const { text, error } = readManifest(gradlePath, options);
    if (error) {
      addError(`Java Gradle project at "${directoryOf(gradlePath)}" could not be inspected: ${error}`);
      continue;
    }
    if (text && /(spring-boot|org\.springframework\.boot)/i.test(text)) {
      addError(`Java Gradle project at "${directoryOf(gradlePath)}" is not supported by the preview adapter; use a Maven pom.xml with spring-boot.`);
    }
  }

  return results;
}

function detectDotnet(files) {
  const csproj = files
    .filter((file) => file.toLowerCase().endsWith('.csproj'))
    .sort(comparePaths);
  const solutions = files
    .filter((file) => file.toLowerCase().endsWith('.sln'))
    .sort(comparePaths);

  return [...csproj, ...solutions].map((project) => ({
    kind: 'backend',
    adapter: 'dotnet',
    command: 'dotnet',
    args: ['run', '--project', fileNameOf(project), '--urls', `http://127.0.0.1:${PORT_TOKEN}`],
    cwd: directoryOf(project),
    healthPath: '/',
    entry: project
  }));
}

function compareDetections(a, b) {
  const adapter = ADAPTER_PRIORITY.indexOf(a.adapter) - ADAPTER_PRIORITY.indexOf(b.adapter);
  if (adapter !== 0) return adapter;
  const depth = depthOf(a.cwd) - depthOf(b.cwd);
  if (depth !== 0) return depth;
  const cwd = compareStrings(a.cwd, b.cwd);
  if (cwd !== 0) return cwd;
  return compareStrings(a.entry, b.entry);
}

/**
 * Inspect workspace-relative paths and return adapter detections and explicit
 * diagnostics. Detection arguments contain the literal `{port}` token where a
 * port is required; `planPreview` and `planDualPreview` materialize it.
 *
 * @param {string[]} rootFiles Workspace-relative file paths.
 * @param {{
 *   manifests?: Record<string, string>|Map<string, string>,
 *   readFile?: (path: string) => string|null|undefined,
 *   pythonCommand?: string,
 *   packageManager?: string
 * }} [options]
 * @returns {{ adapters: Array<{kind: 'frontend'|'backend', adapter: string, command: string|null, args: string[], cwd: string, healthPath: string, entry: string}>, errors: string[] }}
 */
function detectRuntime(rootFiles, options = {}) {
  const errors = [];
  const seenErrors = new Set();
  const addError = (message) => {
    if (seenErrors.has(message)) return;
    seenErrors.add(message);
    errors.push(message);
  };

  if (!Array.isArray(rootFiles)) {
    addError('rootFiles must be an array of workspace-relative paths.');
    return { adapters: [], errors };
  }

  const settings = options && typeof options === 'object' ? options : {};
  const files = [];
  for (const entry of rootFiles) {
    const normalized = normalizeRelativePath(entry);
    if (!normalized) {
      addError(`Ignored unsafe workspace path: ${describeValue(entry)}.`);
      continue;
    }
    if (isIgnoredPath(normalized)) continue;
    files.push(normalized);
  }

  const uniqueFiles = [...new Set(files)].sort(comparePaths);
  const adapters = [
    ...detectNode(uniqueFiles, settings, addError),
    ...detectStatic(uniqueFiles),
    ...detectPython(uniqueFiles, settings, addError),
    ...detectGo(uniqueFiles, addError),
    ...detectPhp(uniqueFiles, addError),
    ...detectJava(uniqueFiles, settings, addError),
    ...detectDotnet(uniqueFiles)
  ].sort(compareDetections);

  return { adapters, errors };
}

function toPreviewPlan(detection, port) {
  return {
    kind: detection.kind,
    adapter: detection.adapter,
    command: detection.command,
    args: detection.args.map((argument) => argument.split(PORT_TOKEN).join(String(port))),
    cwd: detection.cwd,
    port,
    healthPath: detection.healthPath || '/',
    entry: detection.entry
  };
}

function pickByAdapter(adapters, priority) {
  return adapters.find((adapter) => priority.includes(adapter.adapter)) || null;
}

function frontendDetectionFromObject(frontend, errors) {
  if (!frontend || typeof frontend !== 'object') return null;
  const looksLikePlan = ['adapter', 'command', 'args', 'entry', 'cwd', 'healthPath']
    .some((key) => Object.prototype.hasOwnProperty.call(frontend, key));
  if (!looksLikePlan) {
    errors.push('The supplied frontend override is not a preview plan.');
    return null;
  }

  const isStatic = frontend.adapter === 'static' || frontend.command === null;
  let command = isStatic ? null : 'npm';
  if (!isStatic && frontend.command !== undefined) {
    const candidate = normalizeCommandName(frontend.command, null);
    if (!candidate) {
      errors.push(`Frontend command ${describeValue(frontend.command)} is not a valid executable name.`);
      return null;
    }
    command = candidate;
  }

  const args = Array.isArray(frontend.args) ? frontend.args.map((argument) => String(argument)) : [];
  if (args.some((argument) => argument.includes('\0'))) {
    errors.push('The supplied frontend arguments contain a NUL byte.');
    return null;
  }

  let cwd = '.';
  if (frontend.cwd !== undefined) {
    const candidate = normalizeRelativePath(frontend.cwd);
    if (!candidate) {
      errors.push(`Frontend cwd ${describeValue(frontend.cwd)} is not a safe workspace-relative path.`);
      return null;
    }
    cwd = candidate;
  }

  let entry = isStatic ? 'index.html' : 'package.json';
  if (frontend.entry !== undefined) {
    const candidate = normalizeRelativePath(frontend.entry);
    if (!candidate) {
      errors.push(`Frontend entry ${describeValue(frontend.entry)} is not a safe workspace-relative path.`);
      return null;
    }
    entry = candidate;
  }

  let healthPath = '/';
  if (frontend.healthPath !== undefined) {
    if (typeof frontend.healthPath !== 'string' || !frontend.healthPath.startsWith('/')) {
      errors.push('Frontend healthPath must start with "/".');
      return null;
    }
    healthPath = frontend.healthPath;
  }

  let port = null;
  if (frontend.port !== undefined) {
    port = normalizePort(frontend.port);
    if (port === null) errors.push(`Frontend port ${describeValue(frontend.port)} is not a valid port.`);
  }

  return {
    kind: 'frontend',
    adapter: isStatic ? 'static' : 'node',
    command,
    args,
    cwd,
    healthPath,
    entry,
    // Used only when the caller did not supply preferredPort(s).
    port
  };
}

function resolveFrontend(frontend, adapters, errors) {
  if (frontend === undefined || frontend === null || frontend === true || frontend === 'auto') {
    return pickByAdapter(adapters, FRONTEND_PRIORITY);
  }
  if (typeof frontend === 'string') {
    const target = frontend.toLowerCase();
    if (target === 'node' || target === 'vite') {
      const detection = pickByAdapter(adapters, ['node']);
      if (!detection) errors.push('A Node frontend was requested but no package.json with a dev or start script was detected.');
      return detection;
    }
    if (target === 'static') {
      const detection = pickByAdapter(adapters, ['static']);
      if (!detection) errors.push('A static frontend was requested but no index.html entry was detected.');
      return detection;
    }
    errors.push(`Unknown frontend adapter ${describeValue(frontend)}. Use "node", "static", or a frontend plan object.`);
    return null;
  }
  return frontendDetectionFromObject(frontend, errors);
}

function addNoAdapterError(errors, target) {
  if (target === 'frontend') {
    errors.push('No frontend project was detected. Supported frontends: a package.json with a dev or start script, or an index.html static site.');
  } else {
    errors.push('No backend runtime adapter was detected. Supported backends: Python (pyproject.toml or requirements.txt), Go (go.mod), PHP (index.php or public/index.php), Java (Spring Boot pom.xml), and .NET (*.csproj or *.sln).');
  }
}

/**
 * Plan one preview. A frontend plan is preferred when both a frontend and a
 * backend exist; pass `frontend: false` to explicitly plan the backend.
 *
 * @param {{
 *   rootFiles: string[],
 *   frontend?: false|'auto'|'node'|'vite'|'static'|Record<string, unknown>,
 *   preferredPort?: number|string,
 *   pythonCommand?: string,
 *   packageManager?: string,
 *   manifests?: Record<string, string>|Map<string, string>,
 *   readFile?: (path: string) => string|null|undefined
 * }} input
 * @returns {{ previews: Array<{kind: 'frontend'|'backend', adapter: string, command: string|null, args: string[], cwd: string, port: number, healthPath: string, entry: string}>, errors: string[] }}
 */
function planPreview({
  rootFiles,
  frontend,
  preferredPort,
  pythonCommand,
  packageManager,
  manifests,
  readFile
} = {}) {
  const detection = detectRuntime(rootFiles, { manifests, readFile, pythonCommand, packageManager });
  const errors = [...detection.errors];
  let selected = null;

  if (frontend === false) {
    selected = pickByAdapter(detection.adapters, BACKEND_PRIORITY);
  } else if (frontend === undefined || frontend === null || frontend === true || frontend === 'auto') {
    selected = pickByAdapter(detection.adapters, FRONTEND_PRIORITY) ||
      pickByAdapter(detection.adapters, BACKEND_PRIORITY);
  } else {
    selected = resolveFrontend(frontend, detection.adapters, errors);
  }

  if (!selected) {
    if (frontend === false) addNoAdapterError(errors, 'backend');
    else if (typeof frontend === 'string' && frontend !== 'auto') addNoAdapterError(errors, 'frontend');
    else {
      errors.push('No runnable preview adapter was detected for this workspace.');
    }
    return { previews: [], errors };
  }

  let port = normalizePort(preferredPort);
  if (preferredPort !== undefined && preferredPort !== null && port === null) {
    errors.push(`preferredPort ${describeValue(preferredPort)} is not a valid port.`);
  }
  if (port === null) port = selected.port || (selected.kind === 'backend' ? DEFAULT_BACKEND_PORT : DEFAULT_FRONTEND_PORT);

  return { previews: [toPreviewPlan(selected, port)], errors };
}

function readPreferredPorts(preferredPorts, errors) {
  let frontendPort;
  let backendPort;

  if (Array.isArray(preferredPorts)) {
    frontendPort = preferredPorts[0];
    backendPort = preferredPorts[1];
  } else if (preferredPorts && typeof preferredPorts === 'object') {
    frontendPort = preferredPorts.frontend;
    backendPort = preferredPorts.backend;
  } else if (preferredPorts !== undefined && preferredPorts !== null) {
    frontendPort = preferredPorts;
  }

  const result = { frontend: null, backend: null };
  if (frontendPort !== undefined && frontendPort !== null) {
    result.frontend = normalizePort(frontendPort);
    if (result.frontend === null) errors.push(`Frontend port ${describeValue(frontendPort)} is not a valid port.`);
  }
  if (backendPort !== undefined && backendPort !== null) {
    result.backend = normalizePort(backendPort);
    if (result.backend === null) errors.push(`Backend port ${describeValue(backendPort)} is not a valid port.`);
  }
  return result;
}

function nextAvailablePort(start, used) {
  for (let port = start; port <= 65535; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

/**
 * Plan up to two previews: one Node/static frontend and one backend adapter.
 * Backend detection covers Python, Go, PHP, Java (Maven Spring Boot), and .NET;
 * a Node package.json is always treated as the frontend.
 *
 * @param {{
 *   rootFiles: string[],
 *   preferredPorts?: number[]|{frontend?: number, backend?: number},
 *   frontend?: false|'auto'|'node'|'vite'|'static'|Record<string, unknown>,
 *   pythonCommand?: string,
 *   packageManager?: string,
 *   manifests?: Record<string, string>|Map<string, string>,
 *   readFile?: (path: string) => string|null|undefined
 * }} input
 * @returns {{ previews: Array<{kind: 'frontend'|'backend', adapter: string, command: string|null, args: string[], cwd: string, port: number, healthPath: string, entry: string}>, errors: string[] }}
 */
function planDualPreview({
  rootFiles,
  preferredPorts,
  frontend,
  pythonCommand,
  packageManager,
  manifests,
  readFile
} = {}) {
  const detection = detectRuntime(rootFiles, { manifests, readFile, pythonCommand, packageManager });
  const errors = [...detection.errors];

  let frontendDetection = null;
  if (frontend !== false) {
    frontendDetection = resolveFrontend(frontend, detection.adapters, errors);
    if (!frontendDetection) addNoAdapterError(errors, 'frontend');
  }

  const backendDetection = pickByAdapter(detection.adapters, BACKEND_PRIORITY);
  if (!backendDetection) addNoAdapterError(errors, 'backend');

  const requestedPorts = readPreferredPorts(preferredPorts, errors);
  const usedPorts = new Set();
  const previews = [];

  if (frontendDetection) {
    const port = requestedPorts.frontend ||
      normalizePort(frontendDetection.port) ||
      DEFAULT_FRONTEND_PORT;
    usedPorts.add(port);
    previews.push(toPreviewPlan(frontendDetection, port));
  }

  if (backendDetection) {
    let port = requestedPorts.backend || DEFAULT_BACKEND_PORT;
    if (usedPorts.has(port)) {
      const replacement = nextAvailablePort(DEFAULT_BACKEND_PORT, usedPorts);
      if (replacement === null) {
        errors.push('No distinct local port is available for the backend preview.');
        return { previews, errors };
      }
      port = replacement;
    }
    usedPorts.add(port);
    previews.push(toPreviewPlan(backendDetection, port));
  }

  return { previews, errors };
}

module.exports = {
  DEFAULT_BACKEND_PORT,
  DEFAULT_FRONTEND_PORT,
  detectRuntime,
  isSafeRelativePath,
  normalizeRelativePath,
  planDualPreview,
  planPreview,
  PORT_TOKEN
};
