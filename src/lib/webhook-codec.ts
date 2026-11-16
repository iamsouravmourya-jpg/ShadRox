/**
 * Reversible obfuscation for the baked-in feedback webhook URL.
 *
 * Obfuscation deters casual extraction only; the real protection is a write-only endpoint + quota.
 */

const KEY = 'ShadRox';

function xor(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[i] = bytes[i] ^ KEY.charCodeAt(i % KEY.length);
  }
  return out;
}

export function encodeWebhook(url: string): string {
  if (!url) return '';
  const scrambled = xor(new TextEncoder().encode(url));
  let binary = '';
  for (let i = 0; i < scrambled.length; i += 1) {
    binary += String.fromCharCode(scrambled[i]);
  }
  return btoa(binary);
}

export function decodeWebhook(encoded: string): string {
  if (!encoded) return '';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(xor(bytes));
}
