/**
 * The version a save transaction must believe is on disk right now.
 *
 * `electron/workspace.cjs` refuses a stage or commit whose `expectedVersion`
 * does not match the file's current hash, which is what stops ShadRox from
 * overwriting an edit made outside it. The refusal only works if the renderer
 * hands over the version it actually last saw — a checkpoint restore hands back
 * stored contents with no version at all, and pinning that to nothing used to
 * read as "this file does not exist yet".
 */

export async function contentVersion(content: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `undefined` means "we have never seen this file on disk, so there is nothing
 * to compare" and the transaction skips the stage-time check; it still pins the
 * version it reads at stage time, so a commit cannot land on a foreign edit.
 * With a known baseline there is always an answer: the buffer's remembered disk
 * version, or the hash of the content we last knew was out there.
 */
export async function expectedDiskVersion(
  buffer: { version?: string },
  baseline: string | undefined,
  hash: (content: string) => Promise<string> = contentVersion
): Promise<string | undefined> {
  if (baseline === undefined) return undefined;
  if (typeof buffer.version === 'string' && buffer.version.length > 0) return buffer.version;
  return hash(baseline);
}
