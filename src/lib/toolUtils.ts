import type { WorkspaceFile } from './types';

/**
 * Downloads a single file directly to the user's computer via browser blob.
 */
export function downloadFile(name: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name.split('/').pop() || name || 'file.txt';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Rough token count estimation (~4 characters per token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Copies text cleanly to the system clipboard.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-999999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textarea);
    return successful;
  } catch {
    return false;
  }
}

/**
 * Simple beautifier / formatter for JSON, HTML, CSS, and indentation normalization.
 */
export function formatCode(content: string, language: string): { content: string; changed: boolean } {
  try {
    if (language === 'json') {
      const parsed = JSON.parse(content);
      const formatted = JSON.stringify(parsed, null, 2) + '\n';
      return { content: formatted, changed: formatted !== content };
    }

    // Standardize 2-space tab / trim trailing whitespaces
    const lines = content.split('\n');
    let changed = false;
    const formattedLines = lines.map((line) => {
      const trimmedEnd = line.replace(/\s+$/, '');
      if (trimmedEnd !== line) changed = true;
      return trimmedEnd;
    });

    const result = formattedLines.join('\n');
    return { content: result, changed };
  } catch {
    return { content, changed: false };
  }
}

/**
 * Pure TypeScript ZIP builder with 0 external dependencies.
 * Creates an uncompressed ZIP archive (Store method = 0) standard ZIP format.
 */
export function createZipArchive(files: WorkspaceFile[]): Blob {
  const textEncoder = new TextEncoder();
  const fileEntries: Array<{
    nameBytes: Uint8Array;
    contentBytes: Uint8Array;
    crc32: number;
    offset: number;
  }> = [];

  // CRC-32 Lookup Table
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c;
  }

  function calcCrc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const parts: BlobPart[] = [];
  let currentOffset = 0;

  for (const file of files) {
    // Sanitize path (strip leading slashes)
    const sanitizedName = file.name.replace(/^\/+/, '');
    const nameBytes = textEncoder.encode(sanitizedName);
    const contentBytes = textEncoder.encode(file.content);
    const crc = calcCrc32(contentBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(localHeader.buffer);

    view.setUint32(0, 0x04034b50, true); // Local file header signature
    view.setUint16(4, 20, true); // Version needed to extract
    view.setUint16(6, 0, true); // General purpose bit flag
    view.setUint16(8, 0, true); // Compression method (0 = store)
    view.setUint16(10, 0, true); // File mod time
    view.setUint16(12, 0, true); // File mod date
    view.setUint32(14, crc, true); // CRC-32
    view.setUint32(18, contentBytes.length, true); // Compressed size
    view.setUint32(22, contentBytes.length, true); // Uncompressed size
    view.setUint16(26, nameBytes.length, true); // File name length
    view.setUint16(28, 0, true); // Extra field length
    localHeader.set(nameBytes, 30);

    parts.push(localHeader);
    parts.push(contentBytes);

    fileEntries.push({
      nameBytes,
      contentBytes,
      crc32: crc,
      offset: currentOffset
    });

    currentOffset += localHeader.length + contentBytes.length;
  }

  const centralDirStartOffset = currentOffset;
  let centralDirSize = 0;

  for (const entry of fileEntries) {
    const cdHeader = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(cdHeader.buffer);

    view.setUint32(0, 0x02014b50, true); // Central directory file header signature
    view.setUint16(4, 20, true); // Version made by
    view.setUint16(6, 20, true); // Version needed
    view.setUint16(8, 0, true); // Flags
    view.setUint16(10, 0, true); // Compression method (0 = store)
    view.setUint16(12, 0, true); // Mod time
    view.setUint16(14, 0, true); // Mod date
    view.setUint32(16, entry.crc32, true); // CRC-32
    view.setUint32(20, entry.contentBytes.length, true); // Compressed size
    view.setUint32(24, entry.contentBytes.length, true); // Uncompressed size
    view.setUint16(28, entry.nameBytes.length, true); // File name length
    view.setUint16(30, 0, true); // Extra field length
    view.setUint16(32, 0, true); // File comment length
    view.setUint16(34, 0, true); // Disk number start
    view.setUint16(36, 0, true); // Internal attributes
    view.setUint32(38, 0, true); // External attributes
    view.setUint32(42, entry.offset, true); // Relative offset of local header
    cdHeader.set(entry.nameBytes, 46);

    parts.push(cdHeader);
    centralDirSize += cdHeader.length;
  }

  // End of Central Directory Record
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // End of central dir signature
  eocdView.setUint16(4, 0, true); // Disk number
  eocdView.setUint16(6, 0, true); // Disk where central directory starts
  eocdView.setUint16(8, fileEntries.length, true); // Number of central directory records on this disk
  eocdView.setUint16(10, fileEntries.length, true); // Total number of central directory records
  eocdView.setUint32(12, centralDirSize, true); // Size of central directory
  eocdView.setUint32(16, centralDirStartOffset, true); // Offset of start of central directory
  eocdView.setUint16(20, 0, true); // Comment length

  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

export function downloadWorkspaceZip(workspaceName: string, files: WorkspaceFile[]): void {
  const zipBlob = createZipArchive(files);
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = (workspaceName || 'workspace').replace(/[^a-z0-9_-]/gi, '_');
  a.download = `${safeName}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
