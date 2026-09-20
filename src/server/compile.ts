import type {Diagnostic, MatchSpec, Rule} from '../shared/model';

export type CompiledRule = Rule & {
  /** Precompiled regex for regex matchers; absent for exact/prefix. */
  regex?: RegExp;
};

export function scopeSpecificity(scope: string): number {
  return scope === 'all' ? 0 : scope.split('/').filter(Boolean).length;
}

/** True when a query in scope `b` is also covered by rule scope `a`. */
export function scopeCovers(a: string, b: string): boolean {
  return a === 'all' || a === b || b.startsWith(a + '/');
}

export function matchSpecificity(match: MatchSpec): number {
  switch (match.type) {
    case 'exact':
      return 3;
    case 'prefix':
      return 2;
    case 'regex':
      return 1;
  }
}

function normalizeLiteral(value: string, caseSensitive?: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

/** Normalized identity of a matcher — two matchers with the same key match the same queries. */
export function matcherKey(match: MatchSpec): string {
  switch (match.type) {
    case 'exact':
      return 'exact:' + normalizeLiteral(match.value, match.caseSensitive);
    case 'prefix':
      return 'prefix:' + normalizeLiteral(match.value, match.caseSensitive);
    case 'regex':
      return 'regex:' + match.pattern + '/' + (match.flags ?? '');
  }
}

function sameMatcher(a: MatchSpec, b: MatchSpec): boolean {
  return matcherKey(a) === matcherKey(b);
}

/**
 * Evaluation order: priority desc, then narrower scope first, then
 * exact > prefix > regex, then rule id for a deterministic total order.
 */
export function compareRules(a: Rule, b: Rule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const scopeDiff = scopeSpecificity(b.scope) - scopeSpecificity(a.scope);
  if (scopeDiff !== 0) return scopeDiff;
  const matchDiff = matchSpecificity(b.match) - matchSpecificity(a.match);
  if (matchDiff !== 0) return matchDiff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function effectKey(rule: Rule): string {
  switch (rule.kind) {
    case 'rewrite':
      return 'rewrite->' + (rule.replacement ?? '');
    case 'pin':
      return 'pin:' + (rule.pins ?? []).join(',');
    case 'demote':
      return 'demote:' + (rule.demoteDocIds ?? []).join(',') + '@' + (rule.demoteFactor ?? 'default');
  }
}

/**
 * Detect cycles among exact-match rewrite rules: 'a' -> 'b' plus 'b' -> 'a'
 * would bounce forever at runtime. Returns one diagnostic per cycle found.
 */
function detectRewriteLoops(rewrites: CompiledRule[]): Diagnostic[] {
  const edges = new Map<string, {to: string; ruleId: string}[]>();
  for (const rule of rewrites) {
    if (rule.match.type !== 'exact') continue;
    const from = normalizeLiteral(rule.match.value, rule.match.caseSensitive);
    const to = normalizeLiteral(rule.replacement ?? '', rule.match.caseSensitive);
    const list = edges.get(from) ?? [];
    list.push({to, ruleId: rule.id});
    edges.set(from, list);
  }
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const visiting: string[] = [];
  const done = new Set<string>();

  function visit(node: string): void {
    if (done.has(node)) return;
    const cycleStart = visiting.indexOf(node);
    if (cycleStart !== -1) {
      const cycleNodes = visiting.slice(cycleStart);
      const ruleIds: string[] = [];
      for (let i = 0; i < cycleNodes.length; i++) {
        const from = cycleNodes[i];
        const to = cycleNodes[(i + 1) % cycleNodes.length];
        const edge = (edges.get(from) ?? []).find((candidate) => candidate.to === to);
        if (edge) ruleIds.push(edge.ruleId);
      }
      const key = [...ruleIds].sort().join('|');
      if (ruleIds.length > 0 && !reported.has(key)) {
        reported.add(key);
        diagnostics.push({
          code: 'rewrite_loop',
          ruleIds,
          message: `Rewrite rules ${ruleIds.join(', ')} form a loop (${[...cycleNodes, cycleNodes[0]].join(' -> ')}); queries entering it can never settle.`,
        });
      }
      return;
    }
    visiting.push(node);
    for (const edge of edges.get(node) ?? []) visit(edge.to);
    visiting.pop();
    done.add(node);
  }

  for (const node of edges.keys()) visit(node);
  return diagnostics;
}

export function compileRules(rules: Rule[]): {compiled: CompiledRule[]; diagnostics: Diagnostic[]} {
  const diagnostics: Diagnostic[] = [];
  const compiled: CompiledRule[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.match.type === 'regex') {
      try {
        compiled.push({...rule, regex: new RegExp(rule.match.pattern, rule.match.flags ?? '')});
      } catch (error) {
        diagnostics.push({
          code: 'invalid_regex',
          ruleId: rule.id,
          message: `Rule ${rule.id} has an invalid regex (${(error as Error).message}); it is excluded from simulation.`,
        });
        continue;
      }
    } else {
      compiled.push({...rule});
    }
  }

  compiled.sort(compareRules);

  // Unreachable / duplicate / override detection over pairs in evaluation order.
  for (let i = 0; i < compiled.length; i++) {
    for (let j = i + 1; j < compiled.length; j++) {
      const upper = compiled[i];
      const lower = compiled[j];
      if (upper.kind !== lower.kind) continue;
      if (!sameMatcher(upper.match, lower.match)) continue;
      if (!scopeCovers(upper.scope, lower.scope)) continue;
      if (upper.kind === 'rewrite') {
        if (upper.priority === lower.priority && scopeSpecificity(upper.scope) === scopeSpecificity(lower.scope) && effectKey(upper) !== effectKey(lower)) {
          diagnostics.push({
            code: 'override_conflict',
            ruleIds: [upper.id, lower.id],
            winner: upper.id,
            message: `Rules ${upper.id} and ${lower.id} have equal priority and identical matchers but different rewrites; ${upper.id} wins deterministically.`,
          });
        } else {
          diagnostics.push({
            code: 'unreachable',
            ruleId: lower.id,
            shadowedBy: upper.id,
            message: `Rewrite ${lower.id} can never fire: ${upper.id} matches the same queries and is evaluated first.`,
          });
        }
      } else if (effectKey(upper) === effectKey(lower)) {
        diagnostics.push({
          code: 'duplicate_effect',
          ruleId: lower.id,
          shadowedBy: upper.id,
          message: `Rule ${lower.id} repeats the effect of ${upper.id} on the same queries and adds nothing.`,
        });
      }
    }
  }

  diagnostics.push(...detectRewriteLoops(compiled.filter((rule) => rule.kind === 'rewrite')));
  return {compiled, diagnostics};
}
