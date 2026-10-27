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
  pushFiles,
  requiredString,
  type PushFile
} from '../_validate.js';

/**
 * POST /api/github/push -> commits each provided file to the repository.
 * Files are sent one by one so a single failure does not abort the whole push.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  let cleanToken: string;
  let owner: string;
  let repo: string;
  let files: PushFile[];
  let message: string;

  try {
    const body = await readJsonBody<Record<string, unknown>>(req, { maxBytes: BODY_LIMITS.githubPush });
    cleanToken = requiredString(body, 'token', FIELD_LIMITS.apiKeyChars, 'token, owner, repo aur files required hain.');
    owner = requiredString(body, 'owner', FIELD_LIMITS.repoNameChars, 'token, owner, repo aur files required hain.')
      .replace(/[^A-Za-z0-9._-]/g, '')
      .slice(0, FIELD_LIMITS.repoNameChars);
    repo = requiredString(body, 'repo', FIELD_LIMITS.repoNameChars, 'token, owner, repo aur files required hain.')
      .replace(/[^A-Za-z0-9._-]/g, '')
      .slice(0, FIELD_LIMITS.repoNameChars);
    if (!Array.isArray(body.files) || body.files.length === 0) {
      throw new RequestRejectedError(400, 'token, owner, repo aur files required hain.');
    }
    // File count, file-name length and per-file size are all capped here.
    files = pushFiles(body);
    message =
      optionalString(body, 'commitMessage', FIELD_LIMITS.pushCommitMessageChars).trim() ||
      `Update from ShadRox - ${new Date().toISOString()}`;
  } catch (error) {
    if (sendIfRejected(res, error)) return;
    throw error;
  }

  const headers = {
    Authorization: `Bearer ${cleanToken}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'ShadRox'
  };

  const results: Array<{ file: string; status: 'success' | 'failed'; error: string | null }> = [];

  try {
    for (const file of files) {
      // owner/repo are character-filtered and file names are path-checked in
      // `_validate.pushFiles`, so they cannot smuggle another GitHub path.
      const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${file.name}`;
      let sha: string | undefined;

      const existing = await fetch(fileUrl, { headers });
      if (existing.ok) {
        const existingData = (await existing.json()) as { sha?: string };
        sha = existingData.sha;
      }

      const putResponse = await fetch(fileUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message,
          content: Buffer.from(file.content || '', 'utf8').toString('base64'),
          ...(sha ? { sha } : {})
        })
      });

      const putData = (await putResponse.json()) as { message?: string };
      results.push({
        file: file.name,
        status: putResponse.ok ? 'success' : 'failed',
        error: putResponse.ok
          ? null
          : sanitizeErrorMessage(putData.message || 'Unknown GitHub error', 'Unknown GitHub error')
      });
    }

    sendJson(res, 200, {
      success: results.every((result) => result.status === 'success'),
      results,
      repoUrl: `https://github.com/${owner}/${repo}`
    });
  } catch (error) {
    sendError(res, 502, sanitizeErrorMessage(error, 'Push to GitHub failed.'));
  }
}
