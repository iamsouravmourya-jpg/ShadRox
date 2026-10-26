import { readJsonBody, sendError, sendJson, type ApiRequest, type ApiResponse } from '../_http.js';

interface CreateRepoBody {
  token?: string;
  name?: string;
  description?: string;
  isPrivate?: boolean;
}

/** POST /api/github/create-repo -> creates a repository for the authenticated user. */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  const { token, name, description, isPrivate } = await readJsonBody<CreateRepoBody>(req);
  const cleanToken = (token || '').trim();
  const repoName = (name || '').trim();

  if (!cleanToken || !repoName) {
    sendError(res, 400, 'Token aur repository name dono chahiye.');
    return;
  }

  try {
    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ShadRox'
      },
      body: JSON.stringify({
        name: repoName.replace(/\s+/g, '-'),
        description: description || 'Created with ShadRox',
        private: !!isPrivate,
        auto_init: true
      })
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      sendError(res, response.status, (data.message as string) || 'Repository create nahi ho payi.');
      return;
    }

    sendJson(res, 200, {
      success: true,
      repo: {
        name: data.name,
        full_name: data.full_name,
        html_url: data.html_url,
        clone_url: data.clone_url,
        private: data.private
      }
    });
  } catch (error) {
    sendError(res, 502, error instanceof Error ? error.message : 'Repository creation failed.');
  }
}
