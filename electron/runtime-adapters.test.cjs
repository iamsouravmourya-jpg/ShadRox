const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_BACKEND_PORT,
  DEFAULT_FRONTEND_PORT,
  detectRuntime,
  isSafeRelativePath,
  normalizeRelativePath,
  planDualPreview,
  planPreview
} = require('./runtime-adapters.cjs');

const NODE_DEV_MANIFEST = JSON.stringify({ scripts: { dev: 'vite' } });

function manifestWith(scripts) {
  return JSON.stringify({ scripts });
}

function frontendPlan(result) {
  return result.previews.find((preview) => preview.kind === 'frontend');
}

function backendPlan(result) {
  return result.previews.find((preview) => preview.kind === 'backend');
}

test('path guard accepts both separator styles and rejects traversal and absolute escapes', () => {
  assert.equal(isSafeRelativePath('src/main.py'), true);
  assert.equal(isSafeRelativePath('src\\main.py'), true);
  assert.equal(isSafeRelativePath('./src\\main.py'), true);
  assert.equal(normalizeRelativePath('./src\\nested\\main.py'), 'src/nested/main.py');

  assert.equal(isSafeRelativePath('../secret.py'), false);
  assert.equal(isSafeRelativePath('src/../../secret.py'), false);
  assert.equal(isSafeRelativePath('src\\..\\secret.py'), false);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('C:\\project\\main.py'), false);
  assert.equal(isSafeRelativePath('\\\\server\\share\\main.py'), false);
  assert.equal(isSafeRelativePath('src/main.py\0.png'), false);
  assert.equal(isSafeRelativePath('src/file:stream'), false);
  assert.equal(isSafeRelativePath(42), false);
  assert.equal(isSafeRelativePath(''), false);
  assert.equal(normalizeRelativePath('src/../main.py'), null);
});

test('detects a Node frontend only when package.json declares a preview script', () => {
  const detected = detectRuntime(['package.json', 'vite.config.ts'], {
    manifests: { 'package.json': NODE_DEV_MANIFEST }
  });
  assert.deepEqual(detected.errors, []);
  assert.deepEqual(detected.adapters, [{
    kind: 'frontend',
    adapter: 'node',
    command: 'npm',
    args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '{port}'],
    cwd: '.',
    healthPath: '/',
    entry: 'package.json'
  }]);

  const project = planPreview({
    rootFiles: ['frontend/package.json'],
    preferredPort: 3000,
    manifests: { 'frontend/package.json': manifestWith({ start: 'next dev' }) }
  });
  assert.deepEqual(project.errors, []);
  assert.deepEqual(project.previews, [{
    kind: 'frontend',
    adapter: 'node',
    command: 'npm',
    args: ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', '3000'],
    cwd: 'frontend',
    port: 3000,
    healthPath: '/',
    entry: 'frontend/package.json'
  }]);
});

test('reports Node manifests with no preview script or unavailable content', () => {
  const noScript = detectRuntime(['package.json'], {
    manifests: { 'package.json': manifestWith({ test: 'node test.js' }) }
  });
  assert.equal(noScript.adapters.length, 0);
  assert.match(noScript.errors[0], /has no dev, start, preview, or serve script/);

  const noContent = detectRuntime(['package.json']);
  assert.equal(noContent.adapters.length, 0);
  assert.match(noContent.errors[0], /requires package\.json content/);

  const planned = planPreview({ rootFiles: ['package.json'] });
  assert.deepEqual(planned.previews, []);
  assert.ok(planned.errors.some((message) => /No runnable preview adapter/.test(message)));
});

test('Python detection prefers main.py and falls back to running the entry directly', () => {
  const result = planPreview({
    rootFiles: ['requirements.txt', 'app.py', 'main.py'],
    frontend: false,
    preferredPort: 8000,
    manifests: { 'requirements.txt': 'flask==3.0.0\n' }
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.previews, [{
    kind: 'backend',
    adapter: 'python',
    command: 'python',
    args: ['main.py'],
    cwd: '.',
    port: 8000,
    healthPath: '/',
    entry: 'main.py'
  }]);
});

test('Python uses Uvicorn only when FastAPI or Uvicorn is declared, and supports src/main.py', () => {
  const asgi = planPreview({
    rootFiles: ['pyproject.toml', 'main.py'],
    frontend: false,
    preferredPort: 8000,
    manifests: { 'pyproject.toml': '[project]\ndependencies = ["fastapi", "uvicorn"]\n' }
  });
  assert.deepEqual(asgi.errors, []);
  assert.deepEqual(asgi.previews[0].args, ['-m', 'uvicorn', 'main:app', '--port', '8000']);
  assert.equal(asgi.previews[0].cwd, '.');
  assert.equal(asgi.previews[0].entry, 'main.py');

  const nested = planPreview({
    rootFiles: ['requirements.txt', 'src/main.py'],
    frontend: false,
    manifests: { 'requirements.txt': 'uvicorn[standard]\n' }
  });
  assert.deepEqual(nested.previews[0].args, ['-m', 'uvicorn', 'main:app', '--port', '8000']);
  assert.equal(nested.previews[0].cwd, 'src');
  assert.equal(nested.previews[0].entry, 'src/main.py');
});

test('Python honours the python3 flag parameter', () => {
  const result = planPreview({
    rootFiles: ['requirements.txt', 'app.py'],
    frontend: false,
    pythonCommand: 'python3',
    manifests: { 'requirements.txt': 'django\n' }
  });
  assert.equal(result.previews[0].command, 'python3');
  assert.deepEqual(result.previews[0].args, ['app.py']);
});

test('Python project markers without an entry produce an explicit error', () => {
  const detected = detectRuntime(['requirements.txt'], {
    manifests: { 'requirements.txt': 'flask\n' }
  });
  assert.equal(detected.adapters.length, 0);
  assert.match(detected.errors[0], /has no main\.py, app\.py, manage\.py, or src\/main\.py entry/);

  const planned = planPreview({
    rootFiles: ['requirements.txt'],
    frontend: false,
    manifests: { 'requirements.txt': 'flask\n' }
  });
  assert.deepEqual(planned.previews, []);
  assert.ok(planned.errors.some((message) => /No backend runtime adapter was detected/.test(message)));
});

test('Go runs a root main.go entry', () => {
  const result = planPreview({
    rootFiles: ['go.mod', 'main.go'],
    frontend: false,
    preferredPort: 8000
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.previews, [{
    kind: 'backend',
    adapter: 'go',
    command: 'go',
    args: ['run', 'main.go'],
    cwd: '.',
    port: 8000,
    healthPath: '/',
    entry: 'main.go'
  }]);
});

test('Go chooses cmd/*/main.go deterministically inside a nested module', () => {
  const result = planPreview({
    rootFiles: ['backend/go.mod', 'backend/cmd/web/main.go', 'backend/cmd/api/main.go'],
    frontend: false
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.previews[0], {
    kind: 'backend',
    adapter: 'go',
    command: 'go',
    args: ['run', 'cmd/api/main.go'],
    cwd: 'backend',
    port: DEFAULT_BACKEND_PORT,
    healthPath: '/',
    entry: 'backend/cmd/api/main.go'
  });
});

test('Go module without a main entry explains why it cannot be previewed', () => {
  const detected = detectRuntime(['go.mod', 'util.go']);
  assert.equal(detected.adapters.length, 0);
  assert.match(detected.errors[0], /has no main\.go or cmd\/\*\/main\.go entry/);
});

test('PHP serves a root index.php from the project directory', () => {
  const result = planPreview({ rootFiles: ['index.php'], frontend: false, preferredPort: 8080 });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.previews[0], {
    kind: 'backend',
    adapter: 'php',
    command: 'php',
    args: ['-S', '127.0.0.1:8080', '-t', '.'],
    cwd: '.',
    port: 8080,
    healthPath: '/',
    entry: 'index.php'
  });
});

test('PHP chooses the public docroot and prefers a root index.php when both exist', () => {
  const publicOnly = planPreview({ rootFiles: ['public/index.php'], frontend: false });
  assert.deepEqual(publicOnly.previews[0], {
    kind: 'backend',
    adapter: 'php',
    command: 'php',
    args: ['-S', '127.0.0.1:8000', '-t', 'public'],
    cwd: '.',
    port: 8000,
    healthPath: '/',
    entry: 'public/index.php'
  });

  const nested = planPreview({ rootFiles: ['backend/public/index.php'], frontend: false });
  assert.equal(nested.previews[0].cwd, 'backend');
  assert.equal(nested.previews[0].entry, 'backend/public/index.php');
  assert.deepEqual(nested.previews[0].args, ['-S', '127.0.0.1:8000', '-t', 'public']);

  const both = planPreview({
    rootFiles: ['index.php', 'public/index.php'],
    frontend: false
  });
  assert.equal(both.previews[0].entry, 'index.php');
  assert.deepEqual(both.previews[0].args, ['-S', '127.0.0.1:8000', '-t', '.']);
});

test('PHP files without an index entry produce an explicit error', () => {
  const detected = detectRuntime(['src/Router.php']);
  assert.equal(detected.adapters.length, 0);
  assert.match(detected.errors[0], /no index\.php or public\/index\.php entry/);
});

test('Java detects only Maven Spring Boot projects and prefers the wrapper', () => {
  const withWrapper = planPreview({
    rootFiles: ['pom.xml', 'mvnw', 'mvnw.cmd'],
    frontend: false,
    manifests: { 'pom.xml': '<project><artifactId>spring-boot-starter-web</artifactId></project>' }
  });
  assert.deepEqual(withWrapper.errors, []);
  assert.deepEqual(withWrapper.previews[0], {
    kind: 'backend',
    adapter: 'java',
    command: 'mvnw',
    args: ['spring-boot:run'],
    cwd: '.',
    port: 8000,
    healthPath: '/',
    entry: 'pom.xml'
  });

  const withoutWrapper = planPreview({
    rootFiles: ['pom.xml'],
    frontend: false,
    manifests: { 'pom.xml': '<project><artifactId>spring-boot-starter</artifactId></project>' }
  });
  assert.equal(withoutWrapper.previews[0].command, 'mvn');
});

test('Java gating rejects non-Spring Maven builds, unknown pom content, and Gradle', () => {
  const plainMaven = detectRuntime(['pom.xml'], {
    manifests: { 'pom.xml': '<project><artifactId>plain-app</artifactId></project>' }
  });
  assert.equal(plainMaven.adapters.length, 0);
  assert.match(plainMaven.errors[0], /does not declare Spring Boot/);

  const unknownContent = detectRuntime(['pom.xml']);
  assert.equal(unknownContent.adapters.length, 0);
  assert.match(unknownContent.errors[0], /requires pom\.xml content/);

  const gradle = detectRuntime(['build.gradle'], {
    manifests: { 'build.gradle': 'plugins { id "org.springframework.boot" }' }
  });
  assert.equal(gradle.adapters.length, 0);
  assert.match(gradle.errors[0], /Gradle project.*not supported/);
});

test('.NET runs a csproj with the planned loopback URL', () => {
  const result = planPreview({
    rootFiles: ['backend/Web.csproj'],
    frontend: false,
    preferredPort: 9000
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.previews[0], {
    kind: 'backend',
    adapter: 'dotnet',
    command: 'dotnet',
    args: ['run', '--project', 'Web.csproj', '--urls', 'http://127.0.0.1:9000'],
    cwd: 'backend',
    port: 9000,
    healthPath: '/',
    entry: 'backend/Web.csproj'
  });
});

test('.NET accepts a solution and orders projects deterministically', () => {
  const result = planPreview({
    rootFiles: ['Zeta.sln', 'Alpha.csproj'],
    frontend: false
  });
  assert.equal(result.previews[0].entry, 'Alpha.csproj');

  const solutionOnly = planPreview({ rootFiles: ['Zeta.sln'], frontend: false });
  assert.deepEqual(solutionOnly.previews[0].args, [
    'run',
    '--project',
    'Zeta.sln',
    '--urls',
    'http://127.0.0.1:8000'
  ]);
});

test('a static index.html is a frontend plan with no spawned command', () => {
  const result = planPreview({ rootFiles: ['site/index.html'] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.previews[0], {
    kind: 'frontend',
    adapter: 'static',
    command: null,
    args: [],
    cwd: 'site',
    port: DEFAULT_FRONTEND_PORT,
    healthPath: '/',
    entry: 'site/index.html'
  });
});

test('dual preview plans a Node frontend and a Python backend on distinct ports', () => {
  const result = planDualPreview({
    rootFiles: ['package.json', 'requirements.txt', 'main.py'],
    preferredPorts: [5173, 8000],
    manifests: {
      'package.json': NODE_DEV_MANIFEST,
      'requirements.txt': 'fastapi\nuvicorn\n'
    }
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.previews.length, 2);
  assert.deepEqual(result.previews.map((preview) => preview.kind), ['frontend', 'backend']);
  assert.deepEqual(result.previews.map((preview) => preview.adapter), ['node', 'python']);
  assert.deepEqual(result.previews.map((preview) => preview.port), [5173, 8000]);
  assert.deepEqual(backendPlan(result).args, ['-m', 'uvicorn', 'main:app', '--port', '8000']);
});

test('dual preview pairs the Node frontend with Go, PHP, .NET, and Spring Boot backends', () => {
  const cases = [
    {
      name: 'go',
      extraFiles: ['go.mod', 'main.go'],
      manifests: {},
      adapter: 'go',
      assertPlan: (plan) => assert.deepEqual(plan.args, ['run', 'main.go'])
    },
    {
      name: 'php',
      extraFiles: ['public/index.php'],
      manifests: {},
      adapter: 'php',
      assertPlan: (plan) => {
        assert.equal(plan.cwd, '.');
        assert.deepEqual(plan.args, ['-S', '127.0.0.1:8000', '-t', 'public']);
      }
    },
    {
      name: 'dotnet',
      extraFiles: ['Api.csproj'],
      manifests: {},
      adapter: 'dotnet',
      assertPlan: (plan) => assert.deepEqual(plan.args, [
        'run', '--project', 'Api.csproj', '--urls', 'http://127.0.0.1:8000'
      ])
    },
    {
      name: 'java',
      extraFiles: ['pom.xml', 'mvnw'],
      manifests: { 'pom.xml': '<artifactId>spring-boot-starter-web</artifactId>' },
      adapter: 'java',
      assertPlan: (plan) => {
        assert.equal(plan.command, 'mvnw');
        assert.deepEqual(plan.args, ['spring-boot:run']);
      }
    }
  ];

  for (const fixture of cases) {
    const result = planDualPreview({
      rootFiles: ['package.json', ...fixture.extraFiles],
      preferredPorts: [5173, 8000],
      manifests: { 'package.json': NODE_DEV_MANIFEST, ...fixture.manifests }
    });
    assert.deepEqual(result.errors, [], fixture.name);
    assert.equal(result.previews.length, 2, fixture.name);
    assert.equal(frontendPlan(result).adapter, 'node', fixture.name);
    assert.equal(backendPlan(result).adapter, fixture.adapter, fixture.name);
    assert.equal(backendPlan(result).port, 8000, fixture.name);
    fixture.assertPlan(backendPlan(result), fixture.name);
  }
});

test('dual preview reports when no backend adapter exists', () => {
  const result = planDualPreview({
    rootFiles: ['package.json'],
    manifests: { 'package.json': NODE_DEV_MANIFEST }
  });
  assert.equal(result.previews.length, 1);
  assert.equal(result.previews[0].kind, 'frontend');
  assert.ok(result.errors.some((message) => /No backend runtime adapter was detected/.test(message)));
});

test('dual preview reports when neither surface can be detected', () => {
  const result = planDualPreview({ rootFiles: ['README.md', 'LICENSE'] });
  assert.deepEqual(result.previews, []);
  assert.ok(result.errors.some((message) => /No frontend project was detected/.test(message)));
  assert.ok(result.errors.some((message) => /No backend runtime adapter was detected/.test(message)));
});

test('dual preview resolves port conflicts deterministically and honours supplied ports', () => {
  const files = ['package.json', 'go.mod', 'main.go'];
  const manifests = { 'package.json': NODE_DEV_MANIFEST };

  const samePort = planDualPreview({ rootFiles: files, preferredPorts: [5173, 5173], manifests });
  assert.deepEqual(samePort.previews.map((preview) => preview.port), [5173, 8000]);

  const frontendOnBackendPort = planDualPreview({
    rootFiles: files,
    preferredPorts: [8000, 8000],
    manifests
  });
  assert.deepEqual(frontendOnBackendPort.previews.map((preview) => preview.port), [8000, 8001]);

  const supplied = planDualPreview({ rootFiles: files, preferredPorts: [4000, 5000], manifests });
  assert.deepEqual(supplied.previews.map((preview) => preview.port), [4000, 5000]);

  const objectPorts = planDualPreview({
    rootFiles: files,
    preferredPorts: { frontend: 4100, backend: 5100 },
    manifests
  });
  assert.deepEqual(objectPorts.previews.map((preview) => preview.port), [4100, 5100]);
});

test('unsafe paths are ignored with errors while safe files still plan', () => {
  const result = planPreview({
    rootFiles: ['../outside.py', 'C:\\outside\\main.py', '/etc/passwd', 'requirements.txt', 'main.py'],
    frontend: false,
    manifests: { 'requirements.txt': 'flask\n' }
  });
  assert.equal(result.previews.length, 1);
  assert.equal(result.previews[0].adapter, 'python');
  assert.equal(result.errors.filter((message) => /Ignored unsafe workspace path/.test(message)).length, 3);
});

test('detection and planning are deterministic across repeated calls', () => {
  const rootFiles = ['zeta/package.json', 'alpha/package.json', 'package.json'];
  const manifests = {
    'zeta/package.json': manifestWith({ dev: 'vite' }),
    'alpha/package.json': manifestWith({ dev: 'vite' }),
    'package.json': manifestWith({ dev: 'vite' })
  };

  const first = detectRuntime(rootFiles, { manifests });
  const second = detectRuntime([...rootFiles].reverse(), { manifests });
  assert.deepEqual(first, second);
  assert.deepEqual(first.adapters.map((adapter) => adapter.entry), [
    'package.json',
    'alpha/package.json',
    'zeta/package.json'
  ]);

  const previewA = planPreview({ rootFiles, manifests });
  const previewB = planPreview({ rootFiles: [...rootFiles].reverse(), manifests });
  assert.deepEqual(previewA, previewB);
  assert.equal(previewA.previews[0].cwd, '.');
});

test('an explicit frontend plan is accepted and validated', () => {
  const explicit = planPreview({
    rootFiles: [],
    preferredPort: 4321,
    frontend: {
      adapter: 'node',
      command: 'npm',
      args: ['run', 'dev'],
      cwd: 'apps/web',
      entry: 'apps/web/package.json'
    }
  });
  assert.deepEqual(explicit.errors, []);
  assert.deepEqual(explicit.previews[0], {
    kind: 'frontend',
    adapter: 'node',
    command: 'npm',
    args: ['run', 'dev'],
    cwd: 'apps/web',
    port: 4321,
    healthPath: '/',
    entry: 'apps/web/package.json'
  });

  const unsafe = planPreview({
    rootFiles: [],
    frontend: {
      adapter: 'node',
      command: 'npm',
      args: ['run', 'dev'],
      cwd: '../escape'
    }
  });
  assert.deepEqual(unsafe.previews, []);
  assert.ok(unsafe.errors.some((message) => /not a safe workspace-relative path/.test(message)));

  const explicitPort = planPreview({
    rootFiles: [],
    frontend: { adapter: 'static', entry: 'public/index.html', port: 6000 }
  });
  assert.deepEqual(explicitPort.errors, []);
  assert.equal(explicitPort.previews[0].port, 6000);
  assert.equal(explicitPort.previews[0].command, null);

  const invalidPort = planPreview({
    rootFiles: [],
    frontend: { adapter: 'static', port: 99999 }
  });
  assert.equal(invalidPort.previews[0].port, DEFAULT_FRONTEND_PORT);
  assert.ok(invalidPort.errors.some((message) => /Frontend port .* is not a valid port/.test(message)));
});

test('an invalid preferred port is reported and replaced with the adapter default', () => {
  const result = planPreview({ rootFiles: ['index.html'], preferredPort: 70000 });
  assert.equal(result.previews[0].port, DEFAULT_FRONTEND_PORT);
  assert.ok(result.errors.some((message) => /is not a valid port/.test(message)));
});
