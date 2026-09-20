import type {
  ChainStep,
  Diagnostic,
  Doc,
  RankedDoc,
  ResultEntry,
  Rule,
  SampleQuery,
  SampleResult,
} from '../shared/types';

const MAX_REWRITE_ITERATIONS = 16;

export interface Matcher {
  test: (query: string) => boolean;
  apply: (query: string) => string;
  testDoc: (doc: {id: string; title: string}) => boolean;
}

export interface CompiledRule {
  rule: Rule;
  authorIndex: number;
  matcher: Matcher;
}

export interface CompiledRules {
  /** Enabled, valid rules in execution order. */
  ordered: CompiledRule[];
  byId: Map<string, CompiledRule>;
  diagnostics: Diagnostic[];
}

function diag(
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  extra: Partial<Diagnostic> = {},
): Diagnostic {
  return {severity, code, message, ...extra};
}

function buildMatcher(rule: Pick<Rule, 'matchType' | 'pattern' | 'replacement' | 'ignoreCase'>): Matcher {
  if (rule.matchType === 'exact') {
    const pattern = rule.pattern;
    return {
      test: (query) => query === pattern,
      apply: () => rule.replacement ?? '',
      testDoc: () => false,
    };
  }
  const re = new RegExp(rule.pattern, rule.ignoreCase ? 'i' : '');
  return {
    test: (query) => re.test(query),
    apply: (query) => query.replace(re, rule.replacement ?? ''),
    testDoc: () => false,
  };
}

function buildDocMatcher(rule: Rule): ((doc: {id: string; title: string}) => boolean) | null {
  const checks: Array<(doc: {id: string; title: string}) => boolean> = [];
  if (typeof rule.docId === 'string' && rule.docId.trim()) {
    const id = rule.docId.trim();
    checks.push((doc) => doc.id === id);
  }
  if (typeof rule.docPattern === 'string' && rule.docPattern.trim()) {
    const re = new RegExp(rule.docPattern, 'i');
    checks.push((doc) => re.test(doc.id) || re.test(doc.title));
  }
  if (checks.length === 0) return null;
  return (doc) => checks.every((check) => check(doc));
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

/**
 * Normalize and validate one rule. Returns null (with a pushed diagnostic)
 * for rules that cannot be compiled at all.
 */
function normalizeRule(raw: unknown, index: number, diagnostics: Diagnostic[]): Rule | null {
  if (raw === null || typeof raw !== 'object') {
    diagnostics.push(diag('error', 'invalid_rule', `Rule at index ${index} is not an object.`));
    return null;
  }
  const source = raw as Record<string, unknown>;
  const id = asString(source.id)?.trim() ?? '';
  if (!id) {
    diagnostics.push(diag('error', 'invalid_rule', `Rule at index ${index} is missing an id.`));
    return null;
  }
  const kind = source.kind;
  if (kind !== 'rewrite' && kind !== 'pin' && kind !== 'demote') {
    diagnostics.push(diag('error', 'invalid_kind', `Rule ${id}: unknown kind "${String(kind)}".`, {ruleId: id}));
    return null;
  }
  const matchType = source.matchType;
  if (matchType !== 'exact' && matchType !== 'regex') {
    diagnostics.push(diag('error', 'invalid_match_type', `Rule ${id}: matchType must be exact or regex.`, {ruleId: id}));
    return null;
  }
  const pattern = asString(source.pattern)?.trim() ?? '';
  if (!pattern) {
    diagnostics.push(diag('error', 'empty_pattern', `Rule ${id}: pattern must not be empty.`, {ruleId: id}));
    return null;
  }
  const scope = asString(source.scope)?.trim() || '*';
  const priority = asInt(source.priority) ?? 0;
  const enabled = asBoolean(source.enabled, true);
  const ignoreCase = asBoolean(source.ignoreCase, false);

  if (matchType === 'regex') {
    try {
      new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (error) {
      diagnostics.push(
        diag('error', 'invalid_regex', `Rule ${id}: ${(error as Error).message}`, {ruleId: id}),
      );
      return null;
    }
  }

  const rule: Rule = {id, kind, matchType, pattern, scope, priority, enabled};

  if (kind === 'rewrite') {
    rule.replacement = asString(source.replacement) ?? '';
    rule.ignoreCase = ignoreCase;
  }

  if (kind === 'pin') {
    const docId = asString(source.docId)?.trim() ?? '';
    const position = asInt(source.position);
    if (!docId) {
      diagnostics.push(diag('error', 'pin_requires_doc', `Rule ${id}: pin needs a docId.`, {ruleId: id}));
      return null;
    }
    if (position === null || position < 1) {
      diagnostics.push(diag('error', 'pin_requires_position', `Rule ${id}: pin position must be >= 1.`, {ruleId: id}));
      return null;
    }
    rule.docId = docId;
    rule.position = position;
  }

  if (kind === 'demote') {
    const action = source.action;
    if (action !== 'filter' && action !== 'downweight') {
      diagnostics.push(diag('error', 'demote_requires_action', `Rule ${id}: action must be filter or downweight.`, {ruleId: id}));
      return null;
    }
    rule.action = action;
    const docId = asString(source.docId)?.trim();
    const docPattern = asString(source.docPattern)?.trim();
    if (!docId && !docPattern) {
      diagnostics.push(
        diag('error', 'demote_requires_target', `Rule ${id}: demote needs docId or docPattern.`, {ruleId: id}),
      );
      return null;
    }
    if (docId) rule.docId = docId;
    if (docPattern) {
      try {
        new RegExp(docPattern, 'i');
      } catch (error) {
        diagnostics.push(diag('error', 'invalid_regex', `Rule ${id}: docPattern ${(error as Error).message}`, {ruleId: id}));
        return null;
      }
      rule.docPattern = docPattern;
    }
    if (action === 'downweight') {
      const factor = source.factor;
      if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0 || factor >= 1) {
        diagnostics.push(
          diag('error', 'bad_factor', `Rule ${id}: factor must be a number in [0, 1).`, {ruleId: id}),
        );
        return null;
      }
      rule.factor = factor;
    }
  }

  return rule;
}

/** Rules compete when they share a concrete scope or one of them is global. */
function scopesOverlap(a: Rule, b: Rule): boolean {
  return a.scope === b.scope || a.scope === '*' || b.scope === '*';
}

function patternsOverlap(earlier: Rule, later: Rule): boolean {
  // Returns true when the later rule can never win over the earlier one
  // for some input they both match.
  if (earlier.matchType === 'exact' && later.matchType === 'exact') {
    return earlier.pattern === later.pattern;
  }
  if (earlier.matchType === 'regex' && later.matchType === 'exact') {
    return new RegExp(earlier.pattern, earlier.ignoreCase ? 'i' : '').test(later.pattern);
  }
  if (earlier.matchType === 'regex' && later.matchType === 'regex') {
    return earlier.pattern === later.pattern && !!earlier.ignoreCase === !!later.ignoreCase;
  }
  return false;
}

function precedenceKey(rule: Rule, authorIndex: number) {
  // Scope specificity first (concrete scopes outrank '*'), then priority,
  // then match type (exact before regex), then authoring order.
  return [rule.scope === '*' ? 1 : 0, rule.scope, -rule.priority, rule.matchType === 'exact' ? 0 : 1, authorIndex];
}

export function compileRules(rawRules: unknown, corpus?: Doc[]): CompiledRules {
  const diagnostics: Diagnostic[] = [];
  const list = Array.isArray(rawRules) ? rawRules : [];

  const normalized: Array<{rule: Rule; authorIndex: number}> = [];
  const seenIds = new Set<string>();
  list.forEach((raw, index) => {
    const rule = normalizeRule(raw, index, diagnostics);
    if (!rule) return;
    if (seenIds.has(rule.id)) {
      diagnostics.push(diag('error', 'duplicate_rule_id', `Rule ${rule.id}: duplicate id; later copy ignored.`, {ruleId: rule.id}));
      return;
    }
    seenIds.add(rule.id);
    normalized.push({rule, authorIndex: index});
  });

  const knownDocs = new Set(corpus?.map((doc) => doc.id) ?? []);
  for (const {rule} of normalized) {
    const ref = rule.kind === 'pin' ? rule.docId : rule.docId;
    if (ref && corpus && !knownDocs.has(ref)) {
      diagnostics.push(
        diag('warning', 'unknown_doc', `Rule ${rule.id} references unknown document "${ref}".`, {ruleId: rule.id}),
      );
    }
  }

  // Static shadow / unreachable analysis, only across enabled rules.
  const enabled = normalized.filter((entry) => entry.rule.enabled);
  const sorted = [...enabled].sort((a, b) => {
    const ka = precedenceKey(a.rule, a.authorIndex);
    const kb = precedenceKey(b.rule, b.authorIndex);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });

  for (let i = 0; i < sorted.length; i += 1) {
    const later = sorted[i].rule;
    for (let j = 0; j < i; j += 1) {
      const earlier = sorted[j].rule;
      if (earlier.kind !== later.kind || !scopesOverlap(earlier, later)) continue;
      if (patternsOverlap(earlier, later)) {
        diagnostics.push(
          diag(
            'warning',
            'unreachable_rule',
            `Rule ${later.id} is shadowed by earlier rule ${earlier.id} and can never fire.`,
            {ruleId: later.id, otherRuleId: earlier.id},
          ),
        );
        break;
      }
    }
  }

  // Same-slot pin conflicts: same trigger, same position, different docs.
  const pins = enabled.filter((entry) => entry.rule.kind === 'pin');
  for (let i = 0; i < pins.length; i += 1) {
    for (let j = i + 1; j < pins.length; j += 1) {
      const a = pins[i].rule;
      const b = pins[j].rule;
      const sameTrigger =
        a.matchType === b.matchType &&
        (a.matchType === 'exact' ? a.pattern === b.pattern : a.pattern === b.pattern && !!a.ignoreCase === !!b.ignoreCase);
      if (sameTrigger && scopesOverlap(a, b) && a.position === b.position && a.docId !== b.docId) {
        diagnostics.push(
          diag(
            'warning',
            'pin_slot_conflict',
            `Rules ${a.id} and ${b.id} both occupy pin slot ${a.position}.`,
            {ruleId: a.id, otherRuleId: b.id},
          ),
        );
      }
    }
  }

  // Potential rewrite cycles: edge a -> b when a's output can feed b.
  detectRewriteCycles(enabled.map((entry) => entry.rule), diagnostics);

  // Static pin vs filter conflicts (resolved per sample at runtime).
  const filters = enabled.filter((entry) => entry.rule.kind === 'demote' && entry.rule.action === 'filter');
  for (const {rule: pin} of pins) {
    for (const {rule: filter} of filters) {
      if (!scopesOverlap(pin, filter)) continue;
      if (!triggersOverlap(pin, filter)) continue;
      if (filterTargetsDoc(filter, pin.docId!, corpus)) {
        diagnostics.push(
          diag(
            'warning',
            'pin_filter_conflict',
            `Pin ${pin.id} (doc ${pin.docId}) conflicts with filter ${filter.id}; the filter wins at runtime.`,
            {ruleId: pin.id, otherRuleId: filter.id},
          ),
        );
      }
    }
  }

  const ordered = sorted.map((entry) => ({
    rule: entry.rule,
    authorIndex: entry.authorIndex,
    matcher: compileMatcher(entry.rule),
  }));
  const byId = new Map<string, CompiledRule>();
  for (const entry of ordered) byId.set(entry.rule.id, entry);

  return {ordered, byId, diagnostics};
}

function compileMatcher(rule: Rule): Matcher {
  const base = buildMatcher(rule);
  const docMatcher = buildDocMatcher(rule);
  return {...base, testDoc: docMatcher ?? (() => false)};
}

function triggersOverlap(a: Rule, b: Rule): boolean {
  if (a.matchType === 'exact' && b.matchType === 'exact') return a.pattern === b.pattern;
  if (a.matchType === 'regex' && b.matchType === 'exact') return new RegExp(a.pattern, a.ignoreCase ? 'i' : '').test(b.pattern);
  if (a.matchType === 'exact' && b.matchType === 'regex') return new RegExp(b.pattern, b.ignoreCase ? 'i' : '').test(a.pattern);
  return a.pattern === b.pattern;
}

function filterTargetsDoc(filter: Rule, docId: string, corpus?: Doc[]): boolean {
  if (filter.docId) return filter.docId === docId;
  if (filter.docPattern) {
    const re = new RegExp(filter.docPattern, 'i');
    if (re.test(docId)) return true;
    const doc = corpus?.find((value) => value.id === docId);
    if (doc && re.test(doc.title)) return true;
  }
  return false;
}

function literalOutput(rule: Rule): string {
  // Best-effort static output for cycle graph edges.
  return (rule.replacement ?? '').replace(/\$\d+/g, '');
}

function detectRewriteCycles(rules: Rule[], diagnostics: Diagnostic[]): void {
  const rewrites = rules.filter((rule) => rule.kind === 'rewrite');
  const edges = new Map<string, string[]>();
  for (const a of rewrites) {
    const outgoing: string[] = [];
    const output = literalOutput(a);
    for (const b of rewrites) {
      if (!scopesOverlap(a, b)) continue;
      // A rule edges to itself only when its own (literal) output still
      // matches its own pattern; otherwise regex->regex would self-loop on
      // every rewrite.
      if (a.id === b.id) {
        const selfMatches = b.matchType === 'regex' ? new RegExp(b.pattern, b.ignoreCase ? 'i' : '').test(output) : output === b.pattern;
        if (selfMatches) outgoing.push(b.id);
        continue;
      }
      let reaches = false;
      if (b.matchType === 'exact') {
        reaches = output === b.pattern;
      } else if (a.matchType === 'regex' && b.matchType === 'regex') {
        reaches = a.pattern === b.pattern;
      } else if (b.matchType === 'regex') {
        reaches = new RegExp(b.pattern, b.ignoreCase ? 'i' : '').test(output);
      }
      if (reaches) outgoing.push(b.id);
    }
    edges.set(a.id, outgoing);
  }
  const cycle = findCycle(rewrites.map((rule) => rule.id), edges);
  if (cycle) {
    diagnostics.push(
      diag(
        'warning',
        'rewrite_cycle_potential',
        `Potential rewrite cycle: ${cycle.join(' -> ')}. Runtime simulation reports the actual cycle per sample.`,
      ),
    );
  }
}

function findCycle(nodes: string[], edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on stack, 2 done
  const stack: string[] = [];
  let found: string[] | null = null;
  const visit = (node: string): boolean => {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const mark = state.get(next) ?? 0;
      if (mark === 1) {
        found = [...stack.slice(stack.indexOf(next)), next];
        return true;
      }
      if (mark === 0 && visit(next)) return true;
    }
    stack.pop();
    state.set(node, 2);
    return false;
  };
  for (const node of nodes) {
    if ((state.get(node) ?? 0) === 0 && visit(node)) return found;
  }
  return null;
}

// ---------- Runtime simulation ----------

function tokenize(query: string): string[] {
  // Single characters like "a" (a loop remainder) are not searchable terms.
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
}

function organicSearch(query: string, scope: string, corpus: Doc[]): Array<RankedDoc & {doc: Doc}> {
  const tokens = tokenize(query);
  return corpus
    .filter((doc) => doc.scopes.includes(scope))
    .map((doc) => {
      const hayTitle = doc.title.toLowerCase();
      const hayId = doc.id.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (hayTitle === token) score += 3;
        else if (hayTitle.includes(token)) score += 1.5;
        if (hayId.includes(token)) score += 0.5;
      }
      return {doc, docId: doc.id, title: doc.title, score, ruleIds: []};
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
}

function appliesIn(rule: Rule, scope: string): boolean {
  return rule.scope === '*' || rule.scope === scope;
}

interface PinnedCandidate {
  compiled: CompiledRule;
  doc: Doc;
}

/** Run one sample. Never throws: callers get ok:false instead. */
export function evaluateSample(sample: SampleQuery, compiled: CompiledRules, corpus: Doc[]): SampleResult {
  const chain: ChainStep[] = [];
  const sampleDiagnostics: Diagnostic[] = [];
  let stepIndex = 0;
  const push = (step: Omit<ChainStep, 'index'>): ChainStep => {
    const full = {...step, index: stepIndex};
    stepIndex += 1;
    chain.push(full);
    return full;
  };

  // 1. Rewrite loop. The initial query is recorded as a visited state, so
  // returning to it (or any intermediate query) closes the cycle.
  const rewrites = compiled.ordered.filter((entry) => entry.rule.kind === 'rewrite' && appliesIn(entry.rule, sample.scope));
  let query = sample.text;
  const states: Array<{query: string; ruleId?: string}> = [{query: sample.text}];
  let looped = false;
  let iteration = 0;
  while (iteration < MAX_REWRITE_ITERATIONS) {
    const hit = rewrites.find((entry) => entry.matcher.test(query));
    if (!hit) break;
    const output = hit.matcher.apply(query);
    push({type: 'rewrite', iteration, ruleId: hit.rule.id, query, input: query, output});
    const previous = states.findIndex((state) => state.query === output);
    if (previous !== -1) {
      // Rules fired while leaving the repeated state, then the rule that
      // re-enters it; the cycle closes back on the first of those rules.
      const trail = states.slice(previous + 1).map((state) => state.ruleId!);
      const cycleRuleIds = trail.length === 0 ? [hit.rule.id, hit.rule.id] : [...trail, hit.rule.id, trail[0]];
      push({type: 'rewrite-loop', ruleId: hit.rule.id, cycle: cycleRuleIds, input: query, output});
      sampleDiagnostics.push(
        diag('warning', 'rewrite_loop', `Rewrite loop detected: ${cycleRuleIds.join(' -> ')}.`, {
          sampleId: sample.id,
        }),
      );
      query = output;
      looped = true;
      break;
    }
    states.push({query, ruleId: hit.rule.id});
    query = output;
    iteration += 1;
  }
  if (!looped && iteration >= MAX_REWRITE_ITERATIONS) {
    push({type: 'rewrite-limit', query});
    sampleDiagnostics.push(
      diag('warning', 'rewrite_limit', `Rewrite chain exceeded ${MAX_REWRITE_ITERATIONS} iterations.`, {
        sampleId: sample.id,
      }),
    );
  }

  // 2. Pins, evaluated against the final rewritten query.
  const pinned: PinnedCandidate[] = [];
  const pinnedDocIds = new Set<string>();
  const pinRuleByDoc = new Map<string, CompiledRule>();
  for (const entry of compiled.ordered) {
    const rule = entry.rule;
    if (rule.kind !== 'pin' || !appliesIn(rule, sample.scope) || !entry.matcher.test(query)) continue;
    const doc = corpus.find((value) => value.id === rule.docId);
    if (!doc) {
      push({type: 'pin-ignored', ruleId: rule.id, docId: rule.docId, reason: 'unknown_doc'});
      continue;
    }
    if (!doc.scopes.includes(sample.scope)) {
      push({type: 'pin-ignored', ruleId: rule.id, docId: doc.id, reason: 'out_of_scope'});
      continue;
    }
    if (pinnedDocIds.has(doc.id)) {
      push({type: 'pin-ignored', ruleId: rule.id, docId: doc.id, reason: 'duplicate', otherRuleId: pinRuleByDoc.get(doc.id)?.rule.id});
      continue;
    }
    pinnedDocIds.add(doc.id);
    pinRuleByDoc.set(doc.id, entry);
    pinned.push({compiled: entry, doc});
    push({type: 'pin', ruleId: rule.id, docId: doc.id, position: rule.position});
  }
  pinned.sort((a, b) => {
    const diff = (a.compiled.rule.position ?? 0) - (b.compiled.rule.position ?? 0);
    if (diff !== 0) return diff;
    return compiled.ordered.indexOf(a.compiled) - compiled.ordered.indexOf(b.compiled);
  });

  // 3. Organic pool + demotions (filters / downweights).
  // Pinned documents never also occupy an organic slot. A later filter that
  // wins against the pin removes them from both pools anyway.
  const organic = organicSearch(query, sample.scope, corpus).filter((entry) => !pinnedDocIds.has(entry.docId));
  const organicById = new Map(organic.map((entry) => [entry.docId, entry]));

  for (const entry of compiled.ordered) {
    const rule = entry.rule;
    if (rule.kind !== 'demote' || !appliesIn(rule, sample.scope) || !entry.matcher.test(query)) continue;

    if (rule.action === 'filter') {
      const removedOrganic: string[] = [];
      for (const doc of organic) {
        if (entry.matcher.testDoc(doc.doc)) {
          removedOrganic.push(doc.docId);
        }
      }
      for (const docId of removedOrganic) organicById.delete(docId);
      const remainingOrganic = organic.filter((value) => organicById.has(value.docId));
      organic.length = 0;
      organic.push(...remainingOrganic);

      const removedPins: PinnedCandidate[] = [];
      for (const candidate of pinned) {
        if (entry.matcher.testDoc(candidate.doc)) {
          removedPins.push(candidate);
          push({
            type: 'conflict',
            ruleId: rule.id,
            otherRuleId: candidate.compiled.rule.id,
            docId: candidate.doc.id,
            outcome: 'filter_wins',
          });
        }
      }
      for (const candidate of removedPins) {
        pinned.splice(pinned.indexOf(candidate), 1);
        pinnedDocIds.delete(candidate.doc.id);
      }
      if (removedOrganic.length > 0) {
        push({type: 'filter', ruleId: rule.id, docIds: removedOrganic});
      }
      continue;
    }

    // downweight: organic docs are multiplied; pins are immune.
    const affected: string[] = [];
    for (const doc of organic) {
      if (entry.matcher.testDoc(doc.doc)) {
        doc.score *= rule.factor ?? 1;
        doc.ruleIds.push(rule.id);
        affected.push(doc.docId);
      }
    }
    for (const candidate of pinned) {
      if (entry.matcher.testDoc(candidate.doc)) {
        push({
          type: 'conflict',
          ruleId: rule.id,
          otherRuleId: candidate.compiled.rule.id,
          docId: candidate.doc.id,
          outcome: 'pin_wins',
        });
      }
    }
    if (affected.length > 0) {
      organic.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
      push({type: 'downweight', ruleId: rule.id, factor: rule.factor, docIds: affected});
    }
  }

  push({type: 'organic', query, docIds: organic.map((entry) => entry.docId)});

  const results: ResultEntry[] = [];
  const pinnedOut: RankedDoc[] = [];
  for (const candidate of pinned) {
    const base = corpus.find((doc) => doc.id === candidate.doc.id)!;
    const score = organicSearch(query, sample.scope, [base])[0]?.score ?? 0;
    const ranked: RankedDoc = {
      docId: base.id,
      title: base.title,
      score,
      ruleIds: [candidate.compiled.rule.id],
    };
    pinnedOut.push(ranked);
    results.push({docId: ranked.docId, title: ranked.title, score, basis: 'pin', ruleIds: ranked.ruleIds});
  }
  const organicOut: RankedDoc[] = organic.map((entry) => ({
    docId: entry.docId,
    title: entry.title,
    score: Number(entry.score.toFixed(6)),
    ruleIds: [...entry.ruleIds],
  }));
  for (const entry of organicOut) {
    results.push({docId: entry.docId, title: entry.title, score: entry.score, basis: 'organic', ruleIds: entry.ruleIds});
  }

  return {
    sampleId: sample.id,
    ok: true,
    scope: sample.scope,
    originalQuery: sample.text,
    finalQuery: query,
    chain,
    pinned: pinnedOut,
    organic: organicOut,
    results,
    diagnostics: sampleDiagnostics,
  };
}

/** Defensive wrapper: a failure for one sample never breaks the simulation. */
export function evaluateSampleSafe(sample: unknown, compiled: CompiledRules, corpus: Doc[]): SampleResult {
  const fallback = {
    sampleId: (sample as SampleQuery)?.id ?? 'unknown',
    ok: false,
    scope: (sample as SampleQuery)?.scope ?? '',
    originalQuery: (sample as SampleQuery)?.text ?? '',
    finalQuery: (sample as SampleQuery)?.text ?? '',
    chain: [],
    pinned: [],
    organic: [],
    results: [],
    diagnostics: [],
  };
  try {
    if (sample === null || typeof sample !== 'object' || typeof (sample as SampleQuery).text !== 'string') {
      throw new Error('sample is malformed');
    }
    return evaluateSample(sample as SampleQuery, compiled, corpus);
  } catch (error) {
    return {...fallback, error: (error as Error).message};
  }
}
