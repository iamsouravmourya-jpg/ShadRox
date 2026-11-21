import type { Extension } from '@codemirror/state';

type LanguageLoaderKey = 'tsx' | 'ts' | 'jsx' | 'js' | 'html' | 'css' | 'json' | 'markdown' | 'python';

const loadedExtensions = new Map<LanguageLoaderKey, Extension>();
const inFlightLoads = new Map<LanguageLoaderKey, Promise<Extension | null>>();

export function detectLanguage(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'py':
    case 'python':
      return 'python';
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'css':
    case 'scss':
      return 'css';
    case 'sql':
      return 'sql';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'xml':
    case 'svg':
      return 'xml';
    default:
      return 'plaintext';
  }
}

export function resolveLanguageLoaderKey(fileName: string, language?: string): LanguageLoaderKey | null {
  const lang = (language || detectLanguage(fileName)).toLowerCase();
  const lowerName = fileName.toLowerCase();
  switch (lang) {
    case 'typescript':
      return lowerName.endsWith('.tsx') ? 'tsx' : 'ts';
    case 'javascript':
      return lowerName.endsWith('.jsx') ? 'jsx' : 'js';
    case 'html':
    case 'xml':
      return 'html';
    case 'css':
      return 'css';
    case 'json':
      return 'json';
    case 'markdown':
      return 'markdown';
    case 'python':
      return 'python';
    default:
      return null;
  }
}

export function getCachedLanguageExtension(fileName: string, language?: string): Extension | null {
  const key = resolveLanguageLoaderKey(fileName, language);
  return key ? (loadedExtensions.get(key) ?? null) : null;
}

export async function loadLanguageExtension(fileName: string, language?: string): Promise<Extension | null> {
  const key = resolveLanguageLoaderKey(fileName, language);
  if (!key) return null;
  const cached = loadedExtensions.get(key);
  if (cached) return cached;

  const existing = inFlightLoads.get(key);
  if (existing) return existing;

  const loader = (async (): Promise<Extension | null> => {
    let ext: Extension | null = null;
    switch (key) {
      case 'tsx': {
        const { javascript } = await import('@codemirror/lang-javascript');
        ext = javascript({ typescript: true, jsx: true });
        break;
      }
      case 'ts': {
        const { javascript } = await import('@codemirror/lang-javascript');
        ext = javascript({ typescript: true, jsx: false });
        break;
      }
      case 'jsx': {
        const { javascript } = await import('@codemirror/lang-javascript');
        ext = javascript({ jsx: true });
        break;
      }
      case 'js': {
        const { javascript } = await import('@codemirror/lang-javascript');
        ext = javascript({ jsx: false });
        break;
      }
      case 'html': {
        const { html } = await import('@codemirror/lang-html');
        ext = html();
        break;
      }
      case 'css': {
        const { css } = await import('@codemirror/lang-css');
        ext = css();
        break;
      }
      case 'json': {
        const { json } = await import('@codemirror/lang-json');
        ext = json();
        break;
      }
      case 'markdown': {
        const { markdown } = await import('@codemirror/lang-markdown');
        ext = markdown();
        break;
      }
      case 'python': {
        const { python } = await import('@codemirror/lang-python');
        ext = python();
        break;
      }
    }
    if (ext) loadedExtensions.set(key, ext);
    return ext;
  })().finally(() => {
    inFlightLoads.delete(key);
  });

  inFlightLoads.set(key, loader);
  return loader;
}

/** Returns the cached CodeMirror syntax extension if already loaded. */
export function getLanguageExtension(fileName: string, language?: string): Extension | null {
  return getCachedLanguageExtension(fileName, language);
}

/** Files we can actually render in the live preview sandbox. */
export function isRenderableInPreview(fileName: string): boolean {
  const language = detectLanguage(fileName);
  return language === 'html' || language === 'markdown';
}

const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.zip', '.tar', '.gz',
  '.exe', '.dll', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.lock'
];

/**
 * Binary files the live preview can actually render. Instead of dropping these
 * during a folder scan they are read as data URLs, so `/public/logo.png` and
 * `import logo from './logo.png?url'` work inside the sandbox.
 */
const PREVIEW_ASSET_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wav', '.pdf'
];

const IGNORED_DIRECTORIES = [
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.cache', '.vercel', '.turbo', 'vendor', '__pycache__'
];

export function isBinaryFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Binary file the preview serves as an inline data URL instead of skipping. */
export function isPreviewAsset(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return PREVIEW_ASSET_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function shouldSkipFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.startsWith('.')) return true;
  return isBinaryFile(lower);
}

export function shouldSkipDirectory(dirName: string): boolean {
  return IGNORED_DIRECTORIES.includes(dirName);
}
