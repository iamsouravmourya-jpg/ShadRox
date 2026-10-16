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

/** Files we can actually render in the live preview sandbox. */
export function isRenderableInPreview(fileName: string): boolean {
  const language = detectLanguage(fileName);
  return language === 'html' || language === 'markdown';
}

const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.mp4', '.mov', '.mp3', '.wav', '.zip', '.tar', '.gz',
  '.exe', '.dll', '.bin', '.woff', '.woff2', '.ttf', '.lock'
];

const IGNORED_DIRECTORIES = [
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.cache', '.vercel', '.turbo', 'vendor', '__pycache__'
];

export function shouldSkipFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.startsWith('.')) return true;
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function shouldSkipDirectory(dirName: string): boolean {
  return IGNORED_DIRECTORIES.includes(dirName);
}
