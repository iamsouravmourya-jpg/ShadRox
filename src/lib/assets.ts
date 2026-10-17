/**
 * Binary assets (images, fonts, media) live outside the editor workspace.
 *
 * A browser build normally hands these to the dev server through `/public` or a
 * `?url` import; there is no server here, so every asset is read from disk once
 * and kept as a data URL keyed by its workspace-relative path.
 */
export type AssetMap = Record<string, string>;

/** Anything larger is skipped — base64 in a data URL inflates it by ~33%. */
const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/** Paths are workspace-relative and always use forward slashes. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  path.split('/').forEach((segment) => {
    if (!segment || segment === '.') return;
    if (segment === '..') {
      parts.pop();
      return;
    }
    parts.push(segment);
  });
  return parts.join('/');
}

/** Reads one file into a data URL, or null when it is too large / unreadable. */
export async function readAssetFile(file: File, path: string): Promise<{ path: string; dataUrl: string } | null> {
  if (file.size > MAX_ASSET_BYTES) return null;
  const dataUrl = await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  return dataUrl ? { path, dataUrl } : null;
}

/**
 * Looks a URL-ish specifier up in the asset map.
 *
 * `/logo.png` and `logo.png` both find a mounted `public/logo.png`, mirroring how
 * Vite serves the `public/` folder from the site root.
 */
export function findAsset(specifier: string, importer: string, assets: AssetMap): string | null {
  const clean = specifier.replace(/[?#].*$/, '');
  if (!clean) return null;

  const candidates: string[] = [];
  if (clean.startsWith('/')) {
    const relative = clean.replace(/^\/+/, '');
    candidates.push(`public/${relative}`, relative);
  } else if (clean.startsWith('.')) {
    const base = importer.includes('/') ? `${importer.slice(0, importer.lastIndexOf('/'))}/${clean}` : clean;
    candidates.push(normalizePath(base));
  } else {
    const relative = normalizePath(clean);
    candidates.push(relative, `public/${relative}`);
  }

  for (const candidate of candidates) {
    const hit = assets[candidate];
    if (hit) return hit;
  }

  // Windows-cased mounts (`Logo.PNG`) should still match a `/logo.png` reference.
  const wanted = candidates.map((candidate) => candidate.toLowerCase());
  const key = Object.keys(assets).find((assetPath) => wanted.includes(assetPath.toLowerCase()));
  return key ? assets[key] : null;
}

/** Rewrites root-relative `src`/`href` references in an HTML document to data URLs. */
export function inlineHtmlAssets(html: string, assets: AssetMap): string {
  if (Object.keys(assets).length === 0) return html;
  return html.replace(
    /(\bsrc|\bhref)(\s*=\s*)(["'])(\/[^"']+)\3/gi,
    (match, attribute: string, assign: string, quote: string, url: string) => {
      const dataUrl = findAsset(url, '', assets);
      return dataUrl ? `${attribute}${assign}${quote}${dataUrl}${quote}` : match;
    }
  );
}
