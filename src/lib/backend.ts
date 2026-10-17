import type { WorkspaceFile } from './types';

/**
 * Backend awareness for the preview.
 *
 * A server process can never run inside the sandbox iframe, so this module does
 * the honest thing: it reads the real routes out of the workspace's server code
 * and answers the app's own HTTP calls with clearly-labelled simulated JSON, so
 * a full-stack UI still renders instead of hanging on a failed request.
 */
export interface DetectedRoute {
  method: string;
  path: string;
  /** Workspace file the route was read from. */
  source: string;
}

/** `.get('/x')` style routing: express, koa-router, fastify, node http wrappers. */
const JS_ROUTE = /\b(?:app|router|route|server)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])(\/[^'"`\n]*)\2/gi;

/** Python decorators: @app.get("/x"), @router.post("/x"). */
const PY_ROUTE = /@\s*\w+\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"])(\/[^'"\n]*)\2/gi;

/** Go routing: r.GET("/x"), router.HandleFunc("/x"). */
const GO_ROUTE = /\b\w+\s*\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any)\s*\(\s*(['"])(\/[^'"\n]*)\2/g;

const SERVER_ENTRY_HINTS = [
  'server.ts',
  'server.js',
  'server.mjs',
  'server/index.ts',
  'server/index.js',
  'src/server.ts',
  'src/server/index.ts',
  'src/index.server.ts',
  'api/index.ts',
  'api/index.js',
  'app.py',
  'main.py',
  'manage.py',
  'main.go',
  'cmd/server/main.go'
];

const SERVER_SIGNATURES = [
  /\bexpress\s*\(/,
  /from\s+['"]express['"]/,
  /\bfastify\b/,
  /\bnew\s+Koa\s*\(/,
  /\bhttp\.createServer\b/,
  /FastAPI\s*\(/,
  /\bFlask\s*\(/,
  /\buvicorn\b/,
  /\bfunc\s+main\s*\(\s*\)/
];

const IGNORED_ROUTE_ROOT = /^\/(?:\*|:)/;

/** File-system routing: Next.js App Router and Pages Router API handlers. */
function routeFromFileName(name: string): DetectedRoute | null {
  const path = name.replace(/\\/g, '/');

  const appRouter = path.match(/(?:^|\/)app\/(api\/.+\/)route\.(?:ts|tsx|js|jsx)$/);
  if (appRouter) {
    // `app/api/billing/route.ts` serves `/api/billing`, without a trailing slash.
    return { method: 'ALL', path: `/${appRouter[1]}`.replace(/\/$/, ''), source: name };
  }

  const pagesRouter = path.match(/(?:^|\/)pages\/(api\/.+)\.(?:ts|tsx|js|jsx)$/);
  if (pagesRouter) {
    const route = `/${pagesRouter[1]}`.replace(/\/index$/, '').replace(/\[([^\]]+)\]/g, ':$1');
    return { method: 'ALL', path: route, source: name };
  }

  return null;
}

/**
 * Real HTTP routes declared in the workspace. Nothing is invented: a workspace
 * with no server code simply reports zero routes.
 */
export function detectRoutes(files: WorkspaceFile[]): DetectedRoute[] {
  const seen = new Set<string>();
  const routes: DetectedRoute[] = [];

  const push = (method: string, path: string, source: string) => {
    if (!path.startsWith('/') || IGNORED_ROUTE_ROOT.test(path)) return;
    const normalized = method === 'Any' ? 'ALL' : method.toUpperCase();
    const key = `${normalized} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ method: normalized, path, source });
  };

  files.forEach((file) => {
    const byName = routeFromFileName(file.name);
    if (byName) push(byName.method, byName.path, byName.source);

    for (const match of file.content.matchAll(JS_ROUTE)) push(match[1], match[3], file.name);
    for (const match of file.content.matchAll(PY_ROUTE)) push(match[1], match[3], file.name);
    for (const match of file.content.matchAll(GO_ROUTE)) push(match[1], match[3], file.name);
  });

  return routes.slice(0, 60);
}

/** True when the workspace contains a server the browser cannot run. */
export function hasServerCode(files: WorkspaceFile[]): boolean {
  return files.some((file) => {
    const lower = file.name.toLowerCase();
    if (SERVER_ENTRY_HINTS.some((hint) => lower === hint || lower.endsWith(`/${hint}`))) return true;
    return SERVER_SIGNATURES.some((pattern) => pattern.test(file.content));
  });
}

/** Path with `:param` and `*` segments, matching what a client would request. */
function toPathPattern(routePath: string): string {
  const escaped = routePath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[^/]+/g, '[^/]+')
    .replace(/\\\*/g, '.*');
  return escaped;
}

/**
 * Injected into the preview document. It only intercepts requests that match a
 * route the workspace actually declares; everything else is passed straight
 * through to the real `fetch`/`XMLHttpRequest`.
 */
export function apiMockBridge(routes: DetectedRoute[]): string {
  const table = JSON.stringify(
    routes.map((route) => ({ method: route.method, path: route.path, pattern: toPathPattern(route.path) }))
  ).replace(/</g, '\\u003c');

  return `
  (function () {
    var routes = ${table};
    var announced = {};

    function lookup(pathname, method) {
      for (var i = 0; i < routes.length; i++) {
        var route = routes[i];
        if (route.method !== 'ALL' && route.method !== method) continue;
        if (route.path === pathname) return route;
        try { if (new RegExp('^' + route.pattern + '$').test(pathname)) return route; } catch (e) {}
      }
      return null;
    }

    /** Absolute same-origin URL for a request target, or null when it is not ours. */
    function localPath(url) {
      if (!url || /^(data|blob|file):/i.test(url)) return null;
      var parsed;
      try { parsed = new URL(String(url), location.href); } catch (e) { return null; }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      // Third-party traffic (esm.sh, fonts...) must never be simulated.
      if (parsed.origin !== location.origin && location.origin !== 'null') return null;
      return parsed.pathname;
    }

    function simulate(method, pathname) {
      if (!announced[method + ' ' + pathname]) {
        announced[method + ' ' + pathname] = true;
        console.info('[ShadRox] ' + method + ' ' + pathname + ' intercepted — backend server is simulated in browser preview.');
      }
      return JSON.stringify({
        ok: true,
        simulated: true,
        method: method,
        path: pathname,
        data: {},
        message: 'ShadRox simulated response: backend server is not running in this browser preview.'
      });
    }

    var originalFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var pathname = localPath(url);
      if (pathname === null) return originalFetch ? originalFetch(input, init) : Promise.reject(new Error('fetch unavailable'));

      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (lookup(pathname, method)) {
        return Promise.resolve(new Response(simulate(method, pathname), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      }
      return originalFetch ? originalFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
    };

    var OriginalXHR = window.XMLHttpRequest;
    if (OriginalXHR) {
      function ShadRoxXHR() {
        this._real = null;
        this._route = null;
        this._method = 'GET';
        this._url = '';
        this._pathname = '/';
        this.readyState = 0;
        this.status = 0;
        this.statusText = '';
        this.response = null;
        this.responseText = '';
        this.responseType = '';
        this.timeout = 0;
        this.withCredentials = false;
      }

      ShadRoxXHR.prototype.open = function (method, url, async) {
        var self = this;
        this._method = String(method || 'GET').toUpperCase();
        this._url = url;
        this._pathname = localPath(url);
        this._route = this._pathname === null ? null : lookup(this._pathname, this._method);

        if (!this._route) {
          this._real = new OriginalXHR();
          this._real.onreadystatechange = function () {
            self.readyState = self._real.readyState;
            self.status = self._real.status;
            self.statusText = self._real.statusText;
            try { self.response = self._real.response; self.responseText = self._real.responseText; } catch (e) {}
            if (self.onreadystatechange) self.onreadystatechange();
          };
          this._real.onload = function () { if (self.onload) self.onload(); };
          this._real.onerror = function () { if (self.onerror) self.onerror(); };
          this._real.open(method, url, async === undefined ? true : async);
          return;
        }

        this.readyState = 1;
        if (this.onreadystatechange) this.onreadystatechange();
      };

      ShadRoxXHR.prototype.setRequestHeader = function (name, value) {
        if (this._real) this._real.setRequestHeader(name, value);
      };

      ShadRoxXHR.prototype.send = function (body) {
        var self = this;
        if (this._real) { this._real.send(body); return; }
        setTimeout(function () {
          var payload = simulate(self._method, self._pathname);
          self.readyState = 4;
          self.status = 200;
          self.statusText = 'OK';
          self.responseText = payload;
          self.response = payload;
          if (self.onreadystatechange) self.onreadystatechange();
          if (self.onload) self.onload();
        }, 40);
      };

      ShadRoxXHR.prototype.abort = function () { if (this._real) this._real.abort(); };
      ShadRoxXHR.prototype.getAllResponseHeaders = function () {
        return this._real ? this._real.getAllResponseHeaders() : 'content-type: application/json\\r\\n';
      };
      ShadRoxXHR.prototype.getResponseHeader = function (name) {
        if (this._real) return this._real.getResponseHeader(name);
        return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
      };

      window.XMLHttpRequest = ShadRoxXHR;
    }
  })();
`;
}
