import {
  readJsonBody,
  sanitizeErrorMessage,
  sendError,
  sendIfRejected,
  sendJson,
  type ApiRequest,
  type ApiResponse
} from '../_http.js';
import {
  BODY_LIMITS,
  FIELD_LIMITS,
  RequestRejectedError,
  optionalString,
  requiredString
} from '../_validate.js';

/** POST /api/github/create-repo -> creates a repository for the authenticated user. */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  let cleanToken: string;
  let repoName: string;
  let description: string;
  let isPrivate: boolean;

  try {
    const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.githubSmall });
    cleanToken = requiredString(body, 'token', FIELD_LIMITS.apiKeyChars, 'Token aur repository name dono chahiye.');
    repoName = requiredString(body, 'name', FIELD_LIMITS.repoNameChars, 'Token aur repository name dono chahiye.');
    description = optionalString(body, 'description', FIELD_LIMITS.repoDescriptionChars).trim();
    if (body.isPrivate !== undefined && typeof body.isPrivate !== 'boolean') {
      throw new RequestRejectedError(400, '`isPrivate` boolean hona chahiye.');
    }
    isPrivate = body.isPrivate === true;
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
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
        private: isPrivate,
        auto_init: true
      })
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      sendError(
        res,
        response.status,
        sanitizeErrorMessage(
          (data.message as string) || 'Repository create nahi ho payi.',
          'Repository create nahi ho payi.'
        )
      );
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
    sendError(res, 502, sanitizeErrorMessage(error, 'Repository creation failed.'));
  }
}
