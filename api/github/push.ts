import { readJsonBody, sendError, sendJson, type ApiRequest, type ApiResponse } from '../_http.js';

interface PushBody {
  token?: string;
  owner?: string;
  repo?: string;
  files?: Array<{ name: string; content: string }>;
  commitMessage?: string;
}

const MAX_FILES = 60;

/**
 * POST /api/github/push -> commits each provided file to the repository.
 * Files are sent one by one so a single failure does not abort the whole push.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'POST method chahiye.');
    return;
  }

  const { token, owner, repo, files, commitMessage } = await readJsonBody<PushBody>(req);
  const cleanToken = (token || '').trim();

  if (!cleanToken || !owner || !repo || !Array.isArray(files) || files.length === 0) {
    sendError(res, 400, 'token, owner, repo aur files required hain.');
    return;
  }

  if (files.length > MAX_FILES) {
    sendError(res, 413, `Ek push me maximum ${MAX_FILES} files bhej sakte ho.`);
    return;
  }

  const headers = {
    Authorization: `Bearer ${cleanToken}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'ShadRox'
  };

  const message = commitMessage || `Update from ShadRox - ${new Date().toISOString()}`;
  const results: Array<{ file: string; status: 'success' | 'failed'; error: string | null }> = [];

  try {
    for (const file of files) {
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
        error: putResponse.ok ? null : putData.message || 'Unknown GitHub error'
      });
    }

    sendJson(res, 200, {
      success: results.every((result) => result.status === 'success'),
      results,
      repoUrl: `https://github.com/${owner}/${repo}`
    });
  } catch (error) {
    sendError(res, 502, error instanceof Error ? error.message : 'Push to GitHub failed.');
  }
}
