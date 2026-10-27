import {
  readJsonBody,
  sanitizeErrorMessage,
  sendError,
  sendIfRejected,
  sendJson,
  type ApiRequest,
  type ApiResponse
} from '../_http.js';
import { BODY_LIMITS, FIELD_LIMITS, requiredString } from '../_validate.js';

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'ShadRox'
});

/** POST /api/github/validate -> verifies the PAT and returns the user + recent repos. */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  let cleanToken: string;
  try {
    const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.githubSmall });
    cleanToken = requiredString(body, 'token', FIELD_LIMITS.apiKeyChars, 'GitHub personal access token required hai.');
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
  }

  try {
    const userResponse = await fetch('https://api.github.com/user', { headers: GH_HEADERS(cleanToken) });
    const userData = (await userResponse.json()) as Record<string, unknown>;

    if (!userResponse.ok) {
      sendError(
        res,
        userResponse.status,
        sanitizeErrorMessage(
          (userData.message as string) || 'GitHub token invalid hai. `repo` scope check karo.',
          'GitHub token invalid hai. `repo` scope check karo.'
        )
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
    sendError(res, 502, sanitizeErrorMessage(error, 'GitHub authentication failed.'));
  }
}
