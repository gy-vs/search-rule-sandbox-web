import {canonicalDraft} from '../../shared/canonical';

export async function computeDraftHash(draft: {rules: unknown; samples: unknown}): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDraft(draft));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // Fallback (non-secure contexts): simple FNV-1a, still stable.
  let hash = 0x811c9dc5;
  const text = new TextDecoder().decode(bytes);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'fnv1a-' + hash.toString(16).padStart(8, '0');
}

export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}
