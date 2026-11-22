import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import type { ViteDevServer } from 'vite';

import byokValidate from './api/byok/validate';
import aiChat from './api/ai/chat';
import aiFim from './api/ai/fim';
import aiCommitMessage from './api/ai/commit-message';
import promptRefine from './api/prompt/refine';
import githubValidate from './api/github/validate';
import githubCreateRepo from './api/github/create-repo';
import githubPush from './api/github/push';
import type { ApiRequest, ApiResponse } from './api/_http';
import { sendJson } from './api/_http';


const serverFile = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
const serverDirectory = path.dirname(serverFile);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function parseHostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(0, end + 1) : '';
  }
  return trimmed.split(':')[0] || '';
}

export function isTrustedApiRequest(
  headers: Record<string, string | string[] | undefined>,
  options: { enforceLoopbackHost?: boolean } = {}
): boolean {
  const hostHeader = typeof headers.host === 'string' ? headers.host.trim() : '';
  if (options.enforceLoopbackHost) {
    const hostname = parseHostname(hostHeader);
    if (!LOOPBACK_HOSTS.has(hostname)) return false;
  }

  const originHeader = typeof headers.origin === 'string' ? headers.origin.trim() : '';
  if (originHeader === 'shadrox-app://localhost') return true;

  const secFetchSite = typeof headers['sec-fetch-site'] === 'string'
    ? headers['sec-fetch-site'].trim().toLowerCase()
    : '';
  if (secFetchSite === 'cross-site') return false;

  if (originHeader) {
    if (originHeader === 'null') return false;
    try {
      const parsedOrigin = new URL(originHeader);
      if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') return false;
      if (hostHeader && parsedOrigin.host.toLowerCase() !== hostHeader.toLowerCase()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Local development server.
 *
 * Every /api route below is the exact same handler file Vercel deploys as a
 * serverless function, so local behaviour matches production.
 */
export async function startServer(options: {
  mode?: 'development' | 'production';
  host?: string;
  port?: number;
  staticDirectory?: string;
} = {}) {
  const app = express();
  app.disable('x-powered-by');

  const enforceLoopbackHost = options.mode === 'production' && (!options.host || LOOPBACK_HOSTS.has(options.host));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (!isTrustedApiRequest(req.headers, { enforceLoopbackHost })) {
        sendJson(res, 403, { error: 'Cross-origin or untrusted API request rejected.' });
        return;
      }
    }
    next();
  });

  app.use(express.json({ limit: '20mb' }));

  const mount = (
    method: 'post' | 'get',
    route: string,
    handler: (req: ApiRequest, res: ApiResponse) => Promise<void>
  ) => {
    app[method](route, (req, res) => {
      handler(req as unknown as ApiRequest, res as unknown as ApiResponse).catch((error) => {
        console.error(`[api] ${route} failed`, error);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
      });
    });
  };

  mount('get', '/api/health', async (_req, res) => {
    sendJson(res, 200, { status: 'ok', brand: 'ShadRox' });
  });

  mount('post', '/api/byok/validate', byokValidate);
  mount('post', '/api/ai/chat', aiChat);
  mount('post', '/api/ai/fim', aiFim);
  mount('post', '/api/ai/commit-message', aiCommitMessage);
  mount('post', '/api/prompt/refine', promptRefine);

  mount('post', '/api/github/validate', githubValidate);
  mount('post', '/api/github/create-repo', githubCreateRepo);
  mount('post', '/api/github/push', githubPush);

  const mode = options.mode ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  // Reaching this function means the API is running as a local process: the
  // desktop app starts it in-process on 127.0.0.1 and `npm run dev` starts it
  // here. The Vercel deployment mounts `api/**` functions directly and never
  // calls `startServer`, so the flag is what separates "the user's own machine
  // is making this request" from "we are an open proxy" for the BYOK custom
  // endpoint. See api/ai/_endpoint.ts.
  process.env.SHADROX_LOCAL_BACKEND = '1';
  let vite: ViteDevServer | null = null;

  if (mode === 'development') {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const staticDirectory = options.staticDirectory ?? path.join(serverDirectory, 'dist');
    app.use(express.static(staticDirectory));
    app.get('*', (_req, res) => res.sendFile(path.join(staticDirectory, 'index.html')));
  }

  const host = options.host ?? (process.env.HOST?.trim() || '127.0.0.1');
  const port = options.port ?? Number(process.env.PORT || 3000);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await vite?.close();
    throw new Error('Local backend did not bind to a TCP port.');
  }

  const origin = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${address.port}`;
  console.log(`ShadRox ${mode} server running at ${origin}`);

  return {
    origin,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await vite?.close();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === serverFile) {
  dotenv.config();
  void startServer().catch((error) => {
    console.error('[server] failed to start', error);
    process.exitCode = 1;
  });
}
