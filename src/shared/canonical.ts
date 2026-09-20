// Deterministic JSON serialization so that draft hashes are stable
// regardless of key insertion order.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalJSON(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJSON(item ?? null)).join(',') + ']';
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  }
  return 'null';
}

/** Stable hashable view of a draft: only rules and samples participate. */
export function canonicalDraft(draft: {rules: unknown; samples: unknown}): string {
  return canonicalJSON({rules: draft.rules ?? [], samples: draft.samples ?? []});
}
