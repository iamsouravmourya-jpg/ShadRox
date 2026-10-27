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

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    sendJson(res, 200, {
      status: 'ok',
      brand: 'ShadRox',
      sharedKeys: {
        groq: Boolean(process.env.SHADROX_GROQ_API_KEY || process.env.GROQ_API_KEY),
        gemini: Boolean(process.env.SHADROX_GEMINI_API_KEY || process.env.GEMINI_API_KEY)
      }
    });
  });

  mount('post', '/api/byok/validate', byokValidate);
  mount('post', '/api/ai/chat', aiChat);
  mount('post', '/api/ai/fim', aiFim);
  mount('post', '/api/ai/commit-message', aiCommitMessage);
  mount('post', '/api/prompt/refine', promptRefine);

  mount('post', '/api/github/validate', githubValidate);
  mount('post', '/api/github/create-repo', githubCreateRepo);
  mount('post', '/api/github/push', githubPush);

  const mode = options.mode ?? 'development';
  let vite: ViteDevServer | null = null;

  if (mode === 'development') {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const staticDirectory = options.staticDirectory ?? path.join(__dirname, 'dist');
    app.use(express.static(staticDirectory));
    app.get('*', (_req, res) => res.sendFile(path.join(staticDirectory, 'index.html')));
  }

  const host = options.host ?? (mode === 'development' ? '0.0.0.0' : '127.0.0.1');
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

  const origin = `http://${host === '0.0.0.0' ? 'localhost' : host}:${address.port}`;
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startServer().catch((error) => {
    console.error('[server] failed to start', error);
    process.exitCode = 1;
  });
}
