const fs = require('node:fs');
const path = require('node:path');

const { isPathInsideDirectory } = require('./desktop-security.cjs');

// The renderer already refuses to open files past these limits; the language
// service repeats them because it reads from disk on its own and a runaway
// program would otherwise sit in the main process's memory until app exit.
const MAX_PROJECT_FILES = 2_000;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
/**
 * Dependency type declarations are not editable buffers, so the editor limit
 * does not apply to them: `lucide-react` alone ships a 2.2 MB `.d.ts`. Cutting
 * those off made the compiler report `Cannot find module` for packages that
 * were installed, which is the same invented-error class the lib fix removed.
 */
const MAX_DECLARATION_BYTES = 32 * 1024 * 1024;
const MAX_DIAGNOSTICS = 500;
const MAX_NAVIGATION_RESULTS = 100;
const MAX_OUTLINE_DEPTH = 3;
const DISK_REFRESH_INTERVAL_MS = 1_500;
/** `extraResources` folder that carries the packaged default lib declarations. */
const TS_LIB_RESOURCE_DIRECTORY = 'ts-libs';

const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.cache', '.vercel', '.turbo', 'vendor', '__pycache__', '.venv', 'target'
]);

function defaultCompilerOptions(ts) {
  return {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    isolatedModules: true
  };
}

let cachedTypeScript = null;

function loadTypeScript() {
  if (cachedTypeScript) return cachedTypeScript;
  try {
    cachedTypeScript = require('typescript-legacy');
  } catch (error) {
    throw new Error(`The bundled TypeScript language service is unavailable: ${error.message}`);
  }
  return cachedTypeScript;
}

/**
 * TypeScript identifies files with forward slashes on every platform, while
 * `path.resolve`/`fs.realpath` hand back backslashes on Windows. Every map key
 * and every file name crossing the language-service boundary goes through this
 * so an override can never miss its file.
 */
function toKey(fileName) {
  return fileName.replace(/\\/g, '/');
}

function toAbsolutePath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('A workspace-relative file path is required.');
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new Error('Absolute paths are not allowed.');
  }
  const absolute = path.resolve(root, normalized);
  if (!isPathInsideDirectory(root, absolute)) {
    throw new Error('The file resolves outside the opened workspace.');
  }
  return toKey(absolute);
}

function isInsideRoot(root, candidate) {
  return isPathInsideDirectory(root, candidate);
}

function isSkippablePath(root, fileName) {
  const relative = path.relative(root, fileName);
  if (!relative || relative.startsWith('..')) return true;
  return relative.split(path.sep).some((segment) => SKIPPED_DIRECTORIES.has(segment));
}

const DECLARATION_FILE_RE = /\.d\.(?:ts|mts|cts)$/i;

function isDeclarationFile(fileName) {
  return DECLARATION_FILE_RE.test(path.basename(fileName));
}

function walkProjectFiles(root) {
  const files = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length > 0 && files.length < MAX_PROJECT_FILES * 4) {
    const { directory, depth } = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = toKey(path.join(directory, entry.name));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth >= 12 || SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        queue.push({ directory: absolute, depth: depth + 1 });
        continue;
      }
      if (!SCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(absolute);
    }
  }
  return files;
}

function normalizeFileNames(ts, root, fileNames) {
  const seen = new Set();
  const result = [];
  for (const fileName of fileNames) {
    if (typeof fileName !== 'string') continue;
    const absolute = toKey(path.resolve(root, fileName));
    if (!isInsideRoot(root, absolute) || isSkippablePath(root, absolute)) continue;
    const key = ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(absolute);
    if (result.length >= MAX_PROJECT_FILES) break;
  }
  return result;
}

function parseConfig(ts, configPath) {
  if (!fs.existsSync(configPath)) return null;
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error || !configFile.config) return null;
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );
  return { config: configFile.config, parsed };
}

/**
 * `references: [{ path: "./tsconfig.app.json" }]` entries are either a config
 * file or a folder containing one, and always stay inside the workspace.
 */
function resolveReferencePath(ts, root, reference) {
  const target = typeof reference?.path === 'string' ? reference.path.trim() : '';
  if (!target || target.startsWith('/') || /^[a-z]:/i.test(target)) return null;
  const absolute = path.resolve(root, target.replace(/\\/g, '/'));
  if (!isInsideRoot(root, absolute)) return null;
  const asFile = fs.existsSync(absolute) && fs.statSync(absolute).isFile()
    ? absolute
    : path.join(absolute, 'tsconfig.json');
  return toKey(path.normalize(asFile));
}

/**
 * Solution-style configs (`{ "files": [], "references": [...] }`, what
 * `npm create vite@latest` writes) own no files themselves. Reading only the
 * root file made the service fall back to a raw directory walk, which threw
 * away the `paths` aliases, `include` and `exclude` of the referenced project
 * and turned a clean repository into hundreds of invented problems.
 */
function loadReferencedProjects(ts, root, references) {
  const fileNames = [];
  const seen = new Set();
  let compilerOptions = null;
  let primaryConfigPath = null;

  for (const reference of references) {
    const configPath = resolveReferencePath(ts, root, reference);
    if (!configPath) continue;
    const parsedConfig = parseConfig(ts, configPath);
    if (!parsedConfig) continue;
    const ownOptions = parsedConfig.parsed.options;
    const ownFiles = normalizeFileNames(ts, root, parsedConfig.parsed.fileNames);
    if (ownFiles.length === 0) continue;
    if (!compilerOptions) {
      compilerOptions = ownOptions;
      primaryConfigPath = configPath;
    }
    for (const fileName of ownFiles) {
      if (fileNames.length >= MAX_PROJECT_FILES) break;
      if (seen.has(fileName)) continue;
      seen.add(fileName);
      fileNames.push(fileName);
    }
  }

  return compilerOptions ? { fileNames, compilerOptions, configPath: primaryConfigPath } : null;
}

function loadProject(ts, root) {
  for (const candidate of ['tsconfig.json', 'jsconfig.json']) {
    const configPath = toKey(path.join(root, candidate));
    const parsedConfig = parseConfig(ts, configPath);
    if (!parsedConfig) continue;
    const fileNames = normalizeFileNames(ts, root, parsedConfig.parsed.fileNames);
    if (fileNames.length > 0) {
      return { fileNames, compilerOptions: parsedConfig.parsed.options, configPath };
    }
    const references = parsedConfig.config.references;
    if (Array.isArray(references) && references.length > 0) {
      const referenced = loadReferencedProjects(ts, root, references);
      if (referenced) return referenced;
    }
  }

  return {
    fileNames: normalizeFileNames(ts, root, walkProjectFiles(root)),
    compilerOptions: defaultCompilerOptions(ts),
    configPath: null
  };
}

function positionFromLineAndCharacter(sourceFile, line, character) {
  const lineStarts = sourceFile.getLineStarts();
  if (line < 0 || line >= lineStarts.length) return null;
  const nextStart = line + 1 < lineStarts.length ? lineStarts[line + 1] : sourceFile.text.length;
  return Math.min(lineStarts[line] + Math.max(0, character), nextStart);
}

function locationFromPosition(sourceFile, position) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return { line, character };
}

function describeDiagnostic(ts, sourceFile, diagnostic) {
  const start = diagnostic.start ?? 0;
  const length = diagnostic.length ?? 0;
  const startPosition = locationFromPosition(sourceFile, start);
  const endPosition = locationFromPosition(sourceFile, Math.min(start + length, sourceFile.text.length));
  let severity = 'info';
  if (diagnostic.category === 1) severity = 'error';
  else if (diagnostic.category === 0) severity = 'warning';
  return {
    line: startPosition.line,
    character: startPosition.character,
    endLine: endPosition.line,
    endCharacter: endPosition.character,
    severity,
    code: typeof diagnostic.code === 'number' ? `TS${diagnostic.code}` : String(diagnostic.code),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  };
}

function symbolKindLabel(ts, kind) {
  if (kind === ts.ScriptElementKind.functionElement || kind === ts.ScriptElementKind.memberFunctionElement) return 'function';
  if (kind === ts.ScriptElementKind.classElement) return 'class';
  if (kind === ts.ScriptElementKind.interfaceElement) return 'interface';
  if (kind === ts.ScriptElementKind.typeElement) return 'type';
  if (kind === ts.ScriptElementKind.enumElement) return 'enum';
  if (kind === ts.ScriptElementKind.enumMemberElement) return 'enumMember';
  if (kind === ts.ScriptElementKind.moduleElement || kind === ts.ScriptElementKind.namespaceElement) return 'namespace';
  if (kind === ts.ScriptElementKind.memberVariableElement) return 'property';
  if (kind === ts.ScriptElementKind.memberGetAccessorElement) return 'getter';
  if (kind === ts.ScriptElementKind.memberSetAccessorElement) return 'setter';
  if (kind === ts.ScriptElementKind.constructorImplementationElement) return 'constructor';
  if (kind === ts.ScriptElementKind.variableElement || kind === ts.ScriptElementKind.localVariableElement) return 'variable';
  if (kind === ts.ScriptElementKind.constElement) return 'constant';
  if (kind === ts.ScriptElementKind.letElement) return 'variable';
  if (kind === ts.ScriptElementKind.parameterElement) return 'parameter';
  if (kind === ts.ScriptElementKind.propertyElement) return 'property';
  return 'symbol';
}

function createOutlineWalker(ts) {
  function isContainer(node) {
    return ts.isClassDeclaration(node)
      || ts.isClassExpression(node)
      || ts.isInterfaceDeclaration(node)
      || ts.isModuleDeclaration(node)
      || ts.isEnumDeclaration(node)
      || ts.isObjectLiteralExpression(node);
  }

  return function outlineFor(sourceFile) {
    const items = [];

    function add(nameNode, kind, depth) {
      if (!nameNode || typeof nameNode.text !== 'string') return;
      const start = locationFromPosition(sourceFile, nameNode.getStart(sourceFile));
      items.push({ name: nameNode.text, kind, depth, ...start });
    }

    function visit(node, depth) {
      if (depth > MAX_OUTLINE_DEPTH) return;

      if (ts.isFunctionDeclaration(node)) {
        add(node.name, 'function', depth);
        return;
      }
      if (ts.isClassDeclaration(node)) {
        add(node.name, 'class', depth);
        ts.forEachChild(node, (child) => visit(child, depth + 1));
        return;
      }
      if (ts.isInterfaceDeclaration(node)) {
        add(node.name, 'interface', depth);
        ts.forEachChild(node, (child) => visit(child, depth + 1));
        return;
      }
      if (ts.isEnumDeclaration(node)) {
        add(node.name, 'enum', depth);
        ts.forEachChild(node, (child) => visit(child, depth + 1));
        return;
      }
      if (ts.isModuleDeclaration(node)) {
        add(node.name, 'namespace', depth);
        ts.forEachChild(node, (child) => visit(child, depth + 1));
        return;
      }
      if (ts.isTypeAliasDeclaration(node)) {
        add(node.name, 'type', depth);
        return;
      }
      if (ts.isMethodDeclaration(node)) {
        add(node.name, 'method', depth);
        return;
      }
      if (ts.isConstructorDeclaration(node)) {
        items.push({
          name: 'constructor',
          kind: 'constructor',
          depth,
          ...locationFromPosition(sourceFile, node.getStart(sourceFile))
        });
        return;
      }
      if (ts.isGetAccessor(node)) {
        add(node.name, 'getter', depth);
        return;
      }
      if (ts.isSetAccessor(node)) {
        add(node.name, 'setter', depth);
        return;
      }
      if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
        add(node.name, 'property', depth);
        return;
      }
      if (ts.isEnumMember(node)) {
        add(node.name, 'enumMember', depth);
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          let kind = 'variable';
          if (node.declarationList.flags & ts.NodeFlags.Const) kind = 'constant';
          if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
            kind = 'function';
          }
          add(declaration.name, kind, depth);
        }
        return;
      }
      if (isContainer(node)) {
        ts.forEachChild(node, (child) => visit(child, depth));
      }
    }

    ts.forEachChild(sourceFile, (child) => visit(child, 0));
    return items;
  };
}

/**
 * Where the TypeScript default libs (`lib.es*.d.ts`, `lib.dom.d.ts`) live.
 *
 * electron-builder strips every `*.d.ts` out of the packaged app, so inside the
 * installer the language service cannot read its own lib folder and reports
 * `Cannot find name 'Math'` for every workspace. The libs are therefore shipped
 * a second time through `extraResources` (which is not filtered), and that
 * directory wins whenever it exists.
 */
function resolveLibDirectory(ts, compilerOptions) {
  const nativeDirectory = toKey(path.dirname(ts.getDefaultLibFilePath(compilerOptions)));
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (resourcesPath) {
    const copied = toKey(path.join(resourcesPath, TS_LIB_RESOURCE_DIRECTORY));
    if (fs.existsSync(path.join(copied, path.basename(ts.getDefaultLibFilePath(compilerOptions))))) return copied;
  }
  return nativeDirectory;
}

function createSession(ts, root) {
  const { fileNames, compilerOptions, configPath } = loadProject(ts, root);
  const outlineFor = createOutlineWalker(ts);

  const libDirectory = resolveLibDirectory(ts, compilerOptions);
  const overrides = new Map();
  const stats = new Map();
  const snapshots = new Map();
  const extraFiles = new Set();
  // Module resolution probes the same paths tens of thousands of times per
  // program build. Both caches are cleared on every request that can change
  // the file system view, so they never serve stale content across edits.
  const existsCache = new Map();
  const textCache = new Map();
  const directoryCache = new Map();
  const moduleResolutionCache = ts.createModuleResolutionCache(
    root,
    (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
    compilerOptions
  );
  // Scratch file names handed to TypeScript. This exact array is returned on
  // every call: the language service compares it to decide whether the root
  // file set changed, and constructing it per call defeats that check.
  const scriptFileNames = fileNames.slice();
  let versionCounter = 0;
  let lastDiskRefresh = 0;

  function isAllowedFile(fileName) {
    // The default lib files ship inside the bundled TypeScript package, outside
    // the workspace. Nothing else outside the root is ever read.
    return isInsideRoot(libDirectory, fileName) || isInsideRoot(root, fileName);
  }

  function readAllowedFile(fileName) {
    const key = toKey(fileName);
    if (textCache.has(key)) return textCache.get(key);
    let text = null;
    // Reads are only ever served from the workspace or the bundled lib files;
    // node_modules and generated folders stay readable because the compiler
    // resolves type packages and dependency declarations through them.
    if (isInsideRoot(root, key) || isInsideRoot(libDirectory, key)) {
      try {
        const stat = fs.statSync(key);
        const limit = isDeclarationFile(key) ? MAX_DECLARATION_BYTES : MAX_SCRIPT_BYTES;
        if (stat.isFile() && stat.size <= limit) text = fs.readFileSync(key, 'utf8');
      } catch {
        text = null;
      }
    }
    textCache.set(key, text);
    return text;
  }

  function fileExistsCached(fileName) {
    const key = toKey(fileName);
    if (existsCache.has(key)) return existsCache.get(key);
    let exists = false;
    if (isAllowedFile(key)) {
      try {
        exists = fs.statSync(key).isFile();
      } catch {
        exists = false;
      }
    }
    existsCache.set(key, exists);
    return exists;
  }

  function directoryExistsCached(directory) {
    const key = toKey(directory);
    if (directoryCache.has(key)) return directoryCache.get(key);
    const exists = isInsideRoot(root, key) && ts.sys.directoryExists(key);
    directoryCache.set(key, exists);
    return exists;
  }

  function refreshFile(fileName) {
    const key = toKey(fileName);
    if (overrides.has(key)) return;
    let stat;
    try {
      stat = fs.statSync(key);
    } catch {
      if (stats.delete(key)) snapshots.delete(key);
      return;
    }
    const previous = stats.get(key);
    if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) return;
    versionCounter += 1;
    stats.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, version: versionCounter });
    snapshots.delete(key);
    textCache.delete(key);
    existsCache.delete(key);
  }

  function refreshDisk() {
    const now = Date.now();
    if (now - lastDiskRefresh < DISK_REFRESH_INTERVAL_MS) return;
    lastDiskRefresh = now;
    existsCache.clear();
    textCache.clear();
    directoryCache.clear();
    const files = new Set([...fileNames, ...extraFiles]);
    for (const fileName of files) refreshFile(fileName);
  }

  function syncScriptFileNames() {
    if (scriptFileNames.length === fileNames.length + extraFiles.size) {
      let index = 0;
      for (const fileName of fileNames) {
        if (scriptFileNames[index] !== fileName) break;
        index += 1;
      }
      if (index === fileNames.length) return;
    }
    scriptFileNames.length = 0;
    scriptFileNames.push(...fileNames, ...extraFiles);
  }

  function applyOverrides(list) {
    const next = new Map();
    if (Array.isArray(list)) {
      for (const entry of list.slice(0, 20)) {
        if (!entry || typeof entry.path !== 'string' || typeof entry.content !== 'string') continue;
        if (entry.content.length > MAX_SCRIPT_BYTES) continue;
        const absolute = toAbsolutePath(root, entry.path);
        next.set(absolute, entry.content);
      }
    }

    let scriptFilesChanged = false;
    for (const [fileName, text] of next) {
      const previous = overrides.get(fileName);
      if (previous === text) continue;
      overrides.set(fileName, text);
      versionCounter += 1;
      stats.set(fileName, { mtimeMs: 0, size: text.length, version: versionCounter });
      snapshots.delete(fileName);
      if (!fileNames.includes(fileName) && !extraFiles.has(fileName)) {
        extraFiles.add(fileName);
        scriptFilesChanged = true;
      }
    }

    for (const fileName of [...overrides.keys()]) {
      if (next.has(fileName)) continue;
      overrides.delete(fileName);
      stats.delete(fileName);
      snapshots.delete(fileName);
      if (extraFiles.delete(fileName)) scriptFilesChanged = true;
      refreshFile(fileName);
    }

    if (scriptFilesChanged) {
      versionCounter += 1;
      syncScriptFileNames();
    }
  }

  function getScriptSnapshot(fileName) {
    const key = toKey(fileName);
    const cached = snapshots.get(key);
    if (cached) return cached.snapshot;
    const text = overrides.has(key) ? overrides.get(key) : readAllowedFile(key);
    if (text === null || text === undefined) return undefined;
    const snapshot = ts.ScriptSnapshot.fromString(text);
    snapshots.set(key, { snapshot });
    return snapshot;
  }

  const host = {
    // Returning a new array here makes the language service treat every call as
    // a changed root set; keep one array and mutate it when the set changes.
    getScriptFileNames: () => scriptFileNames,
    getScriptVersion: (fileName) => String(stats.get(toKey(fileName))?.version ?? 0),
    // With a project version the service skips resynchronising entirely when no
    // buffer or file on disk has changed since the previous request.
    getProjectVersion: () => String(versionCounter),
    getScriptSnapshot,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) =>
      toKey(path.join(libDirectory, path.basename(ts.getDefaultLibFilePath(options)))),
    getNewLine: () => '\n',
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getModuleResolutionCache: () => moduleResolutionCache,
    fileExists: fileExistsCached,
    readFile: (fileName) => readAllowedFile(fileName) ?? undefined,
    readDirectory: (directory, extensions, excludes, includes, depth) => {
      if (!isInsideRoot(root, toKey(directory))) return [];
      return ts.sys.readDirectory(directory, extensions, excludes, includes, depth).map(toKey);
    },
    directoryExists: directoryExistsCached,
    getDirectories: (directory) => (isInsideRoot(root, toKey(directory)) ? ts.sys.getDirectories(directory).map(toKey) : [])
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  function prepare(overrideList) {
    applyOverrides(overrideList);
    refreshDisk();
  }

  function projectSourceFile(fileName) {
    const program = service.getProgram();
    return program?.getSourceFile(fileName) ?? null;
  }

  function requestSourceFile(relativePath) {
    const absolute = toAbsolutePath(root, relativePath);
    if (!fileNames.includes(absolute) && !extraFiles.has(absolute)) {
      // The project's tsconfig include list can be narrower than what the
      // explorer shows; an opened file still deserves navigation.
      extraFiles.add(absolute);
      versionCounter += 1;
      syncScriptFileNames();
    }
    refreshFile(absolute);
    const sourceFile = projectSourceFile(absolute);
    if (!sourceFile) throw new Error('That file could not be loaded by the language service.');
    return sourceFile;
  }

  return {
    diagnostics(overrideList) {
      prepare(overrideList);
      const program = service.getProgram();
      if (!program) return { diagnostics: [], truncated: false, projectFiles: 0, configPath };

      const diagnostics = [];
      let truncated = false;
      let projectFiles = 0;

      for (const sourceFile of program.getSourceFiles()) {
        if (!isInsideRoot(root, sourceFile.fileName) || isSkippablePath(root, sourceFile.fileName)) continue;
        if (sourceFile.isDeclarationFile) continue;
        projectFiles += 1;
        const fileDiagnostics = [
          ...service.getSyntacticDiagnostics(sourceFile.fileName),
          ...service.getSemanticDiagnostics(sourceFile.fileName)
        ];
        for (const diagnostic of fileDiagnostics) {
          if (diagnostics.length >= MAX_DIAGNOSTICS) {
            truncated = true;
            break;
          }
          diagnostics.push({ file: sourceFile.fileName, ...describeDiagnostic(ts, sourceFile, diagnostic) });
        }
        if (truncated) break;
      }

      return { diagnostics, truncated, projectFiles, configPath };
    },

    definition(relativePath, line, character, overrideList) {
      prepare(overrideList);
      const sourceFile = requestSourceFile(relativePath);
      const position = positionFromLineAndCharacter(sourceFile, line, character);
      if (position === null) return [];
      const definitions = service.getDefinitionAtPosition(sourceFile.fileName, position) ?? [];
      return definitions.slice(0, 20).map((definition) => {
        const target = projectSourceFile(definition.fileName);
        if (!target) return null;
        const start = locationFromPosition(target, definition.textSpan.start);
        const end = locationFromPosition(target, definition.textSpan.start + definition.textSpan.length);
        return {
          file: definition.fileName,
          name: definition.name,
          kind: symbolKindLabel(ts, definition.kind),
          ...start,
          endLine: end.line,
          endCharacter: end.character
        };
      }).filter(Boolean);
    },

    references(relativePath, line, character, overrideList) {
      prepare(overrideList);
      const sourceFile = requestSourceFile(relativePath);
      const position = positionFromLineAndCharacter(sourceFile, line, character);
      if (position === null) return [];
      const references = service.getReferencesAtPosition(sourceFile.fileName, position) ?? [];
      return references.slice(0, MAX_NAVIGATION_RESULTS).map((reference) => {
        const target = projectSourceFile(reference.fileName);
        if (!target) return null;
        const start = locationFromPosition(target, reference.textSpan.start);
        return {
          file: reference.fileName,
          isDefinition: Boolean(reference.isDefinition),
          ...start,
          endLine: start.line,
          endCharacter: start.character + reference.textSpan.length
        };
      }).filter(Boolean);
    },

    outline(relativePath, overrideList) {
      prepare(overrideList);
      const sourceFile = requestSourceFile(relativePath);
      return outlineFor(sourceFile);
    },

    symbols(query, overrideList) {
      prepare(overrideList);
      const trimmed = typeof query === 'string' ? query.trim() : '';
      if (!trimmed) return [];
      const items = service.getNavigateToItems(trimmed, MAX_NAVIGATION_RESULTS, undefined, true) ?? [];
      return items.map((item) => {
        if (!isInsideRoot(root, item.fileName) || isSkippablePath(root, item.fileName)) return null;
        const target = projectSourceFile(item.fileName);
        if (!target) return null;
        const start = locationFromPosition(target, item.textSpan.start);
        return {
          file: item.fileName,
          name: item.name,
          kind: symbolKindLabel(ts, item.kind),
          container: item.containerName || '',
          ...start
        };
      }).filter(Boolean);
    },

    dispose() {
      service.dispose();
      snapshots.clear();
      stats.clear();
      overrides.clear();
      extraFiles.clear();
    }
  };
}

const WORKER_METHODS = new Set(['diagnostics', 'definition', 'references', 'outline', 'symbols']);

function createWorkerSession(root) {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(path.join(__dirname, 'ts-worker.cjs'), { workerData: { root } });
  const pending = new Map();
  let nextId = 0;
  let failure = null;

  worker.on('message', (message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (pending.size === 0) worker.unref();
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  worker.on('error', (error) => {
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });
  worker.on('exit', (code) => {
    if (code === 0 || failure) return;
    failure = new Error(`The code-intelligence worker stopped (exit code ${code}).`);
    for (const entry of pending.values()) entry.reject(failure);
    pending.clear();
  });
  // Idle workers must not keep the app from quitting; an in-flight request keeps
  // the process alive so a test runner or a quitting app cannot lose the reply.
  worker.unref();

  return {
    get failure() {
      return failure;
    },
    request(method, args) {
      if (failure) return Promise.reject(failure);
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.ref();
        worker.postMessage({ id, method, args });
      });
    },
    dispose() {
      pending.clear();
      worker.terminate().catch(() => {});
    }
  };
}

function createTypeScriptService({ getWorkspace }) {
  const sessions = new Map();

  function resolveWorkspace(workspaceId) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error('This desktop workspace is no longer open. Reopen its folder before using code intelligence.');
    }
    if (workspace.mode !== 'folder') {
      throw new Error('Code intelligence is available only for an opened folder workspace.');
    }
    return workspace;
  }

  function localSession(root) {
    // TypeScript work blocks whichever thread runs it, so it runs in a worker.
    // If the worker cannot start (some packaged environments), fall back to the
    // main thread rather than losing the feature.
    return createSession(loadTypeScript(), root);
  }

  function sessionFor(workspaceId) {
    const workspace = resolveWorkspace(workspaceId);
    const existing = sessions.get(workspaceId);
    if (existing && existing.root === workspace.root) return existing;

    existing?.worker?.dispose();
    existing?.session?.dispose();
    const entry = { root: workspace.root, worker: null, session: null, broken: false };
    try {
      entry.worker = createWorkerSession(workspace.root);
    } catch {
      entry.broken = true;
      entry.session = localSession(workspace.root);
    }
    sessions.set(workspaceId, entry);
    return entry;
  }

  async function call(workspaceId, method, args) {
    const entry = sessionFor(workspaceId);
    if (!entry.broken && entry.worker && !entry.worker.failure) {
      try {
        return await entry.worker.request(method, args);
      } catch (error) {
        if (!entry.worker.failure) throw error;
        entry.worker.dispose();
        entry.worker = null;
        entry.broken = true;
      }
    }
    if (!entry.session) entry.session = localSession(entry.root);
    return entry.session[method](...args);
  }

  return {
    diagnostics: (workspaceId, overrides) => call(workspaceId, 'diagnostics', [overrides]),
    definition: (workspaceId, relativePath, line, character, overrides) =>
      call(workspaceId, 'definition', [relativePath, line, character, overrides]),
    references: (workspaceId, relativePath, line, character, overrides) =>
      call(workspaceId, 'references', [relativePath, line, character, overrides]),
    outline: (workspaceId, relativePath, overrides) => call(workspaceId, 'outline', [relativePath, overrides]),
    symbols: (workspaceId, query, overrides) => call(workspaceId, 'symbols', [query, overrides]),
    closeWorkspace: (workspaceId) => {
      const existing = sessions.get(workspaceId);
      if (!existing) return;
      existing.worker?.dispose();
      existing.session?.dispose();
      sessions.delete(workspaceId);
    }
  };
}

module.exports = {
  createTypeScriptService,
  createWorkspaceSession: (root) => createSession(loadTypeScript(), root),
  resolveLibDirectory,
  WORKER_METHODS
};
