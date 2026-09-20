// Deterministic draft hashing shared by client and server.
// The client tags every simulation request with the hash of the draft it
// ran; the server recomputes the hash over the received payload and rejects
// mismatches, so stale results can never be attached to a newer draft.

/** JSON.stringify with sorted object keys; undefined drops like JSON does. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) {
    return '[' + value.map((item) => (item === undefined ? 'null' : canonicalize(item))).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalize(record[key]));
  return '{' + parts.join(',') + '}';
}

/** 64-bit FNV-1a over the canonical form — stable across client and server. */
export function draftHash(value: unknown): string {
  const text = canonicalize(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
