import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { createServer as createViteServer } from 'vite';

import byokValidate from './api/byok/validate';
import aiChat from './api/ai/chat';
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
async function startServer() {
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
    sendJson(res, 200, { status: 'ok', hasDevoraKey: Boolean(process.env.DEVORA_GEMINI_API_KEY) });
  });

  mount('post', '/api/byok/validate', byokValidate);
  mount('post', '/api/ai/chat', aiChat);
  mount('post', '/api/prompt/refine', promptRefine);

  mount('post', '/api/github/validate', githubValidate);
  mount('post', '/api/github/create-repo', githubCreateRepo);
  mount('post', '/api/github/push', githubPush);

  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });

  app.use(vite.middlewares);

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Devora dev server running on http://localhost:${port}`);
  });
}

startServer();
