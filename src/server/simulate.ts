import type {ChainEvent, ResultDoc, Rule, SampleQuery, SampleResult} from '../shared/model';
import {scopeCovers, type CompiledRule} from './compile';

export const MAX_REWRITE_ITERATIONS = 8;

export type CorpusDoc = {id: string; title: string; category: string; tags: string[]};

/** Deterministic demo corpus; simulation never touches production search. */
export const CORPUS: CorpusDoc[] = [
  {id: 'd1', title: 'Apple Inc quarterly results', category: 'news', tags: ['apple', 'company', 'stocks']},
  {id: 'd2', title: 'Apple pie recipe', category: 'recipes', tags: ['apple', 'dessert', 'pie']},
  {id: 'd3', title: 'History of Apple computers', category: 'docs', tags: ['apple', 'computers', 'history']},
  {id: 'd4', title: 'Java programming guide', category: 'docs', tags: ['java', 'programming', 'guide']},
  {id: 'd5', title: 'Java coffee beans', category: 'shop', tags: ['java', 'coffee']},
  {id: 'd6', title: 'Mercury planet facts', category: 'science', tags: ['mercury', 'planet', 'space']},
  {id: 'd7', title: 'Mercury element safety', category: 'science', tags: ['mercury', 'element', 'chemistry']},
  {id: 'd8', title: 'Best apple laptops 2026', category: 'news', tags: ['apple', 'laptop', 'review']},
];

class RewriteLoopError extends Error {
  chain: ChainEvent[];
  constructor(chain: ChainEvent[]) {
    super(`Query did not settle after ${MAX_REWRITE_ITERATIONS} rewrites`);
    this.name = 'RewriteLoopError';
    this.chain = chain;
  }
}

function matches(rule: CompiledRule, query: string): boolean {
  const match = rule.match;
  switch (match.type) {
    case 'exact':
      return match.caseSensitive ? query === match.value : query.toLowerCase() === match.value.toLowerCase();
    case 'prefix':
      return match.caseSensitive
        ? query.startsWith(match.value)
        : query.toLowerCase().startsWith(match.value.toLowerCase());
    case 'regex':
      rule.regex!.lastIndex = 0;
      return rule.regex!.test(query);
  }
}

function applyRewrite(rule: CompiledRule, query: string): string {
  const match = rule.match;
  switch (match.type) {
    case 'exact':
      return rule.replacement ?? '';
    case 'prefix': {
      const head = query.slice(0, match.value.length);
      const tail = query.slice(match.value.length);
      const hit = match.caseSensitive ? head === match.value : head.toLowerCase() === match.value.toLowerCase();
      return hit ? (rule.replacement ?? '') + tail : query;
    }
    case 'regex':
      rule.regex!.lastIndex = 0;
      return query.replace(rule.regex!, rule.replacement ?? '');
  }
}

function ruleAppliesToScope(rule: Rule, scope: string): boolean {
  return scopeCovers(rule.scope, scope);
}

function scoreDoc(doc: CorpusDoc, tokens: string[]): number {
  const title = doc.title.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 2;
    if (doc.tags.some((tag) => tag.includes(token))) score += 3;
  }
  return score;
}

function simulateSample(compiled: CompiledRule[], sample: SampleQuery): SampleResult {
  const chain: ChainEvent[] = [];
  let seq = 0;
  const push = (event: Omit<ChainEvent, 'seq'>) => chain.push({seq: ++seq, ...event});
  const scope = sample.scope ?? 'all';

  // Phase 1: rewrites. After every rewrite, matching restarts from the top
  // of the compiled order, so higher-priority rules get another chance.
  let current = sample.text;
  const rewrites = compiled.filter((rule) => rule.kind === 'rewrite');
  for (let iteration = 0; ; iteration++) {
    if (iteration >= MAX_REWRITE_ITERATIONS) throw new RewriteLoopError(chain);
    const rule = rewrites.find((candidate) => ruleAppliesToScope(candidate, scope) && matches(candidate, current));
    if (!rule) break;
    const next = applyRewrite(rule, current);
    if (next === current) {
      push({ruleId: rule.id, kind: 'rewrite_noop', before: current, after: next, message: `Rewrite ${rule.id} left the query unchanged; stopping to avoid a no-op loop.`});
      break;
    }
    push({ruleId: rule.id, kind: 'rewrite', before: current, after: next, message: `Rewrite ${rule.id}: "${current}" -> "${next}".`});
    current = next;
  }

  // Phase 2: base retrieval over the demo corpus, then hard filters.
  const tokens = current.toLowerCase().split(/\s+/).filter(Boolean);
  const filters = sample.filters ?? {};
  const filterEntries = Object.entries(filters);
  const docs = CORPUS.map((doc) => ({doc, score: scoreDoc(doc, tokens)}));
  const kept = docs.filter(({doc}) => filterEntries.every(([field, value]) => String(doc[field as keyof CorpusDoc]) === value));
  if (filterEntries.length > 0) {
    const removed = docs.filter((entry) => !kept.includes(entry)).map((entry) => entry.doc.id);
    push({ruleId: null, kind: 'filter', message: `Query filters ${JSON.stringify(filters)} removed ${removed.length} doc(s)${removed.length ? ': ' + removed.join(', ') : ''}.`});
  }

  const board = kept.map(({doc, score}) => ({doc, score, pinned: false, demoted: false, viaRuleId: undefined as string | undefined}));

  // Phase 3: demotions (score multiplier), in compiled order.
  for (const rule of compiled) {
    if (rule.kind !== 'demote' || !ruleAppliesToScope(rule, scope) || !matches(rule, current)) continue;
    const factor = rule.demoteFactor ?? 0.5;
    for (const docId of rule.demoteDocIds ?? []) {
      const entry = board.find((candidate) => candidate.doc.id === docId);
      if (!entry) continue;
      entry.score = entry.score * factor;
      entry.demoted = true;
      entry.viaRuleId = rule.id;
      push({ruleId: rule.id, kind: 'demote', docId, message: `Demote ${rule.id}: ${docId} score multiplied by ${factor}.`});
    }
  }

  // Phase 4: pins, in compiled order — higher-priority rules pin first.
  let pinSlot = 0;
  const pinnedOrder: string[] = [];
  for (const rule of compiled) {
    if (rule.kind !== 'pin' || !ruleAppliesToScope(rule, scope) || !matches(rule, current)) continue;
    for (const docId of rule.pins ?? []) {
      const inCorpus = CORPUS.some((doc) => doc.id === docId);
      if (!inCorpus) {
        push({ruleId: rule.id, kind: 'pin_unknown_doc', docId, message: `Pin ${rule.id} references unknown doc ${docId}; skipped.`});
        continue;
      }
      const entry = board.find((candidate) => candidate.doc.id === docId);
      if (!entry) {
        push({ruleId: rule.id, kind: 'pin_filtered', docId, message: `Pin ${rule.id} conflicts with query filters: ${docId} is excluded, so the pin is dropped.`});
        continue;
      }
      if (pinnedOrder.includes(docId)) continue;
      pinnedOrder.push(docId);
      entry.pinned = true;
      entry.viaRuleId = rule.id;
      push({ruleId: rule.id, kind: 'pin', docId, message: `Pin ${rule.id}: ${docId} fixed at position ${++pinSlot}.`});
    }
  }

  const pinned = pinnedOrder.map((docId) => board.find((entry) => entry.doc.id === docId)!);
  const rest = board
    .filter((entry) => !entry.pinned)
    .sort((a, b) => b.score - a.score || (a.doc.id < b.doc.id ? -1 : 1));
  const results: ResultDoc[] = [...pinned, ...rest].map((entry) => ({
    docId: entry.doc.id,
    title: entry.doc.title,
    category: entry.doc.category,
    score: Math.round(entry.score * 1000) / 1000,
    pinned: entry.pinned,
    demoted: entry.demoted,
    ...(entry.viaRuleId ? {viaRuleId: entry.viaRuleId} : {}),
  }));

  return {sampleId: sample.id, status: 'ok', finalQuery: current, results, chain};
}

/**
 * Runs every sample independently: a failure (e.g. a rewrite loop hitting the
 * iteration cap) is captured on that sample only and never aborts the others.
 */
export function runSimulation(compiled: CompiledRule[], samples: SampleQuery[]): SampleResult[] {
  return samples.map((sample) => {
    try {
      return simulateSample(compiled, sample);
    } catch (error) {
      const isLoop = error instanceof RewriteLoopError;
      return {
        sampleId: sample.id,
        status: 'error' as const,
        error: {code: isLoop ? 'rewrite_loop_exceeded' : 'simulation_error', message: (error as Error).message},
        // Keep the chain so a looping sample can still be traced back to its rules.
        chain: isLoop ? (error as RewriteLoopError).chain : [],
      };
    }
  });
}
