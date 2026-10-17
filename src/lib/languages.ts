import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import type { Extension } from '@codemirror/state';

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

/** Returns the CodeMirror syntax extension matching the file */
export function getLanguageExtension(fileName: string, language?: string): Extension | null {
  const lang = (language || detectLanguage(fileName)).toLowerCase();
  switch (lang) {
    case 'typescript':
      return javascript({ typescript: true, jsx: fileName.endsWith('.tsx') });
    case 'javascript':
      return javascript({ jsx: fileName.endsWith('.jsx') });
    case 'html':
    case 'xml':
      return html();
    case 'css':
      return css();
    case 'json':
      return json();
    case 'markdown':
      return markdown();
    case 'python':
      return python();
    default:
      return null;
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
