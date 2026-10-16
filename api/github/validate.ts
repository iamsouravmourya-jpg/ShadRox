import { readJsonBody, sendError, sendJson, type ApiRequest, type ApiResponse } from '../_http.js';

interface ValidateGithubBody {
  token?: string;
}

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'Devora-AI-Studio'
});

/** POST /api/github/validate -> verifies the PAT and returns the user + recent repos. */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  const { token } = await readJsonBody<ValidateGithubBody>(req);
  const cleanToken = (token || '').trim();

  if (!cleanToken) {
    sendError(res, 400, 'GitHub personal access token required hai.');
    return;
  }

  try {
    const userResponse = await fetch('https://api.github.com/user', { headers: GH_HEADERS(cleanToken) });
    const userData = (await userResponse.json()) as Record<string, unknown>;

    if (!userResponse.ok) {
      sendError(
        res,
        userResponse.status,
        (userData.message as string) || 'GitHub token invalid hai. `repo` scope check karo.'
      );
      return;
    }

    const reposResponse = await fetch('https://api.github.com/user/repos?sort=updated&per_page=10', {
      headers: GH_HEADERS(cleanToken)
    });
    const repos = reposResponse.ok ? ((await reposResponse.json()) as Array<Record<string, unknown>>) : [];

    sendJson(res, 200, {
      user: {
        login: userData.login,
        name: userData.name || userData.login,
        avatar_url: userData.avatar_url,
        html_url: userData.html_url,
        public_repos: userData.public_repos
      },
      repos: repos.map((repo) => ({
        name: repo.name,
        full_name: repo.full_name,
        html_url: repo.html_url,
        private: repo.private,
        updated_at: repo.updated_at
      }))
    });
  } catch (error) {
    sendError(res, 502, error instanceof Error ? error.message : 'GitHub authentication failed.');
  }
}
