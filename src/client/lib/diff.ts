// Diff two ordered lists of items keyed by stable id.
// Uses LCS over the common ids so that pure reordering is reported as
// "moved" rather than remove+add.

export type FieldChange = {field: string; from: unknown; to: unknown};

export type DiffEntry =
  | {type: 'added'; id: string; toIndex: number; item: unknown}
  | {type: 'removed'; id: string; fromIndex: number; item: unknown}
  | {type: 'changed'; id: string; fromIndex: number; toIndex: number; fields: FieldChange[]}
  | {type: 'moved'; id: string; fromIndex: number; toIndex: number}
  | {type: 'unchanged'; id: string; fromIndex: number; toIndex: number};

export interface ListDiff {
  entries: DiffEntry[];
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  moved: DiffEntry[];
  isEmpty: boolean;
}

type Item = {id: string} & Record<string, unknown>;

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortValue(a)) === JSON.stringify(sortValue(b));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function fieldChanges(from: Item, to: Item): FieldChange[] {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const changes: FieldChange[] = [];
  for (const key of keys) {
    if (key === 'id') continue;
    if (!stableEqual(from[key], to[key])) changes.push({field: key, from: from[key], to: to[key]});
  }
  return changes;
}

export function diffList(fromRaw: unknown, toRaw: unknown): ListDiff {
  const from: Item[] = Array.isArray(fromRaw) ? (fromRaw as Item[]).filter((item) => item && typeof item.id === 'string') : [];
  const to: Item[] = Array.isArray(toRaw) ? (toRaw as Item[]).filter((item) => item && typeof item.id === 'string') : [];
  const fromById = new Map(from.map((item, index) => [item.id, {item, index}]));
  const toById = new Map(to.map((item, index) => [item.id, {item, index}]));

  // LCS of common ids (in each side's order) identifies items that did not move.
  const commonFrom = from.filter((item) => toById.has(item.id));
  const commonTo = to.filter((item) => fromById.has(item.id));
  const m = commonFrom.length;
  const n = commonTo.length;
  const dp: number[][] = Array.from({length: m + 1}, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = commonFrom[i].id === commonTo[j].id ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const stationary = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (commonFrom[i].id === commonTo[j].id) {
      stationary.add(commonFrom[i].id);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  const entries: DiffEntry[] = [];
  to.forEach((item, toIndex) => {
    if (!fromById.has(item.id)) {
      entries.push({type: 'added', id: item.id, toIndex, item});
      return;
    }
    const {item: old, index: fromIndex} = fromById.get(item.id)!;
    const fields = fieldChanges(old, item);
    if (fields.length > 0) entries.push({type: 'changed', id: item.id, fromIndex, toIndex, fields});
    else if (!stationary.has(item.id)) entries.push({type: 'moved', id: item.id, fromIndex, toIndex});
    else entries.push({type: 'unchanged', id: item.id, fromIndex, toIndex});
  });
  from.forEach((item, fromIndex) => {
    if (!toById.has(item.id)) entries.push({type: 'removed', id: item.id, fromIndex, item});
  });

  const added = entries.filter((entry) => entry.type === 'added');
  const removed = entries.filter((entry) => entry.type === 'removed');
  const changed = entries.filter((entry) => entry.type === 'changed');
  const moved = entries.filter((entry) => entry.type === 'moved');
  return {entries, added, removed, changed, moved, isEmpty: added.length + removed.length + changed.length + moved.length === 0};
}
