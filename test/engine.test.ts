import {describe, expect, it} from 'vitest';
import {compileRules, evaluateSample, evaluateSampleSafe, type CompiledRules} from '../src/server/engine';
import {DEFAULT_CORPUS} from '../src/server/simulate';
import type {Doc, Rule, SampleQuery} from '../src/shared/types';

const web: SampleQuery = {id: 's-web', text: 'iphone 16', scope: 'web'};

function rule(partial: Partial<Rule> & Pick<Rule, 'id' | 'kind'>): Rule {
  return {
    matchType: 'exact',
    pattern: 'iphone 16',
    scope: '*',
    priority: 0,
    enabled: true,
    ...partial,
  };
}

function run(rules: Rule[], sample: SampleQuery, corpus: Doc[] = DEFAULT_CORPUS) {
  return evaluateSample(sample, compileRules(rules, corpus), corpus);
}

describe('match precedence', () => {
  it('fires exact before regex at the same priority and scope', () => {
    const exact = rule({id: 'ex', kind: 'rewrite', replacement: 'EXACT'});
    const re = rule({id: 're', kind: 'rewrite', matchType: 'regex', pattern: 'iphone.*', replacement: 'REGEX'});
    const result = run([re, exact], web);
    expect(result.finalQuery).toBe('EXACT');
    expect(result.chain.find((step) => step.type === 'rewrite')?.ruleId).toBe('ex');
  });

  it('higher priority regex beats lower priority exact', () => {
    const exact = rule({id: 'ex', kind: 'rewrite', replacement: 'EXACT', priority: 1});
    const re = rule({id: 're', kind: 'rewrite', matchType: 'regex', pattern: 'iphone.*', replacement: 'REGEX', priority: 10});
    const result = run([exact, re], web);
    expect(result.finalQuery).toBe('REGEX');
  });

  it('concrete scope beats a higher-priority global rule inside that scope', () => {
    const global = rule({id: 'global', kind: 'rewrite', replacement: 'GLOBAL', scope: '*', priority: 50});
    const scoped = rule({id: 'scoped', kind: 'rewrite', replacement: 'SCOPED', scope: 'web', priority: 1});
    expect(run([global, scoped], web).finalQuery).toBe('SCOPED');
    expect(run([global, scoped], {...web, scope: 'shop'}).finalQuery).toBe('GLOBAL');
  });

  it('flags an exact rule shadowed by an earlier regex that always matches it', () => {
    const re = rule({id: 're', kind: 'rewrite', matchType: 'regex', pattern: 'iphone.*', replacement: 'REGEX', priority: 10});
    const exact = rule({id: 'ex', kind: 'rewrite', pattern: 'iphone 16', replacement: 'EXACT', priority: 1});
    const compiled = compileRules([re, exact], DEFAULT_CORPUS);
    const hit = compiled.diagnostics.find((d) => d.code === 'unreachable_rule');
    expect(hit?.ruleId).toBe('ex');
    expect(hit?.otherRuleId).toBe('re');
    // An exact rule for text the regex does not cover remains reachable.
    const safe = rule({id: 'safe', kind: 'rewrite', pattern: 'galaxy s25', replacement: 'GALAXY', priority: 1});
    expect(compileRules([re, safe], DEFAULT_CORPUS).diagnostics).toEqual([]);
  });

  it('flags duplicate exact rules but not distinct patterns', () => {
    const a = rule({id: 'a', kind: 'rewrite', pattern: 'iphone 16', replacement: 'A'});
    const b = rule({id: 'b', kind: 'rewrite', pattern: 'iphone 16 pro', replacement: 'B'});
    expect(compileRules([a, b], DEFAULT_CORPUS).diagnostics).toEqual([]);
    const c = rule({id: 'c', kind: 'rewrite', pattern: 'iphone 16', replacement: 'C'});
    const hit = compileRules([a, c], DEFAULT_CORPUS).diagnostics.find((d) => d.code === 'unreachable_rule');
    expect(hit?.ruleId).toBe('c');
    expect(hit?.otherRuleId).toBe('a');
  });
});

describe('rewrite rematching', () => {
  it('rewritten output is matched again and each hop is recorded in the chain', () => {
    const r1 = rule({id: 'r1', kind: 'rewrite', pattern: 'iphone 16', replacement: 'iphone 16 pro'});
    const r2 = rule({id: 'r2', kind: 'rewrite', pattern: 'iphone 16 pro', replacement: 'iphone 16 pro case'});
    const result = run([r2, r1], web);
    expect(result.finalQuery).toBe('iphone 16 pro case');
    const hops = result.chain.filter((step) => step.type === 'rewrite');
    expect(hops.map((step) => step.ruleId)).toEqual(['r1', 'r2']);
    expect(hops[1]).toMatchObject({input: 'iphone 16 pro', output: 'iphone 16 pro case'});
  });

  it('supports regex capture groups in replacements', () => {
    const r1 = rule({
      id: 'cap',
      kind: 'rewrite',
      matchType: 'regex',
      pattern: '^(iphone) (16)$',
      replacement: '$2 $1',
    });
    expect(run([r1], web).finalQuery).toBe('16 iphone');
  });
});

describe('rewrite loops', () => {
  const a = rule({id: 'a', kind: 'rewrite', pattern: 'a', replacement: 'b'});
  const b = rule({id: 'b', kind: 'rewrite', pattern: 'b', replacement: 'a'});

  it('detects the loop at runtime, keeps the final state, and lists the cycle', () => {
    const result = run([a, b], {...web, text: 'a'});
    const loopStep = result.chain.find((step) => step.type === 'rewrite-loop');
    expect(loopStep?.cycle).toEqual(['a', 'b', 'a']);
    expect(result.finalQuery).toBe('a');
    expect(result.diagnostics.some((d) => d.code === 'rewrite_loop')).toBe(true);
  });

  it('warns about the potential cycle at compile time', () => {
    const compiled = compileRules([a, b], DEFAULT_CORPUS);
    expect(compiled.diagnostics.some((d) => d.code === 'rewrite_cycle_potential')).toBe(true);
  });

  it('detects self loops', () => {
    const self = rule({id: 'self', kind: 'rewrite', matchType: 'regex', pattern: 'x', replacement: 'x'});
    const result = run([self], {...web, text: 'x'});
    expect(result.chain.some((step) => step.type === 'rewrite-loop')).toBe(true);
  });
});

describe('pin / filter / downweight', () => {
  it('filter wins over a conflicting pin, with a conflict step linking both rules', () => {
    const pin = rule({
      id: 'pin-outlet',
      kind: 'pin',
      pattern: 'cheap phone',
      docId: 'cheap-phones',
      position: 1,
      priority: 50,
    });
    const filter = rule({
      id: 'filter-outlet',
      kind: 'demote',
      pattern: 'cheap phone',
      docId: 'cheap-phones',
      action: 'filter',
      priority: 1,
    });
    const result = run([pin, filter], {...web, text: 'cheap phone'});
    expect(result.results.find((entry) => entry.docId === 'cheap-phones')).toBeUndefined();
    const conflict = result.chain.find((step) => step.type === 'conflict');
    expect(conflict).toMatchObject({ruleId: 'filter-outlet', otherRuleId: 'pin-outlet', outcome: 'filter_wins'});
    const staticDiag = compileRules([pin, filter], DEFAULT_CORPUS).diagnostics.find(
      (d) => d.code === 'pin_filter_conflict',
    );
    expect(staticDiag).toMatchObject({ruleId: 'pin-outlet', otherRuleId: 'filter-outlet'});
  });

  it('pins beat downweights: pinned doc stays pinned and the conflict is recorded', () => {
    const pin = rule({id: 'pin-pro', kind: 'pin', docId: 'iphone-16-pro', position: 1});
    const demote = rule({
      id: 'demote-pro',
      kind: 'demote',
      matchType: 'regex',
      pattern: 'iphone',
      docId: 'iphone-16-pro',
      action: 'downweight',
      factor: 0.1,
    });
    const result = run([pin, demote], web);
    expect(result.results[0]).toMatchObject({docId: 'iphone-16-pro', basis: 'pin'});
    expect(result.chain.some((step) => step.type === 'conflict' && step.outcome === 'pin_wins')).toBe(true);
  });

  it('downweight multiplies organic scores and ranks the target lower', () => {
    const demote = rule({
      id: 'demote-cases',
      kind: 'demote',
      matchType: 'regex',
      pattern: 'iphone',
      docPattern: 'case',
      action: 'downweight',
      factor: 0.1,
    });
    const sample: SampleQuery = {id: 's', text: 'iphone', scope: 'shop'};
    const baseline = run([], sample);
    const demoted = run([demote], sample);
    const baseCase = baseline.organic.find((entry) => entry.docId === 'iphone-16-case');
    const afterCase = demoted.organic.find((entry) => entry.docId === 'iphone-16-case');
    expect(baseCase && afterCase).toBeTruthy();
    expect(afterCase!.score).toBeCloseTo(baseCase!.score * 0.1, 5);
    expect(afterCase!.ruleIds).toContain('demote-cases');
    expect(demoted.organic.indexOf(afterCase!)).toBeGreaterThan(baseline.organic.indexOf(baseCase!));
  });

  it('filter removes only matched organic documents', () => {
    const filter = rule({
      id: 'f',
      kind: 'demote',
      matchType: 'regex',
      pattern: 'iphone',
      docPattern: 'case|charger',
      action: 'filter',
    });
    const result = run([filter], {id: 's', text: 'iphone', scope: 'shop'});
    expect(result.results.some((entry) => entry.docId === 'iphone-16-case')).toBe(false);
    expect(result.results.some((entry) => entry.docId === 'iphone-16')).toBe(true);
  });
});

describe('rule reordering', () => {
  it('reversing same-priority exact rewrites reverses which one fires', () => {
    const r1 = rule({id: 'r1', kind: 'rewrite', pattern: 'q', replacement: 'one'});
    const r2 = rule({id: 'r2', kind: 'rewrite', pattern: 'q', replacement: 'two'});
    expect(run([r1, r2], {...web, text: 'q'}).finalQuery).toBe('one');
    expect(run([r2, r1], {...web, text: 'q'}).finalQuery).toBe('two');
  });

  it('authoring order is only a tiebreaker after priority and match type', () => {
    const lowExact = rule({id: 'low-exact', kind: 'rewrite', replacement: 'LOW', priority: 1});
    const highRegex = rule({
      id: 'high-regex',
      kind: 'rewrite',
      matchType: 'regex',
      pattern: 'iphone.*',
      replacement: 'HIGH',
      priority: 10,
    });
    const compiled = compileRules([lowExact, highRegex], DEFAULT_CORPUS);
    expect(compiled.ordered[0].rule.id).toBe('high-regex');
  });
});

describe('rule validation', () => {
  it('reports invalid regex without crashing and excludes the rule', () => {
    const bad = rule({id: 'bad', kind: 'demote', matchType: 'regex', pattern: '([', action: 'filter', docId: 'x'});
    const compiled = compileRules([bad], DEFAULT_CORPUS);
    expect(compiled.diagnostics.some((d) => d.code === 'invalid_regex' && d.ruleId === 'bad')).toBe(true);
    expect(compiled.ordered.some((entry) => entry.rule.id === 'bad')).toBe(false);
  });

  it('warns about unknown documents and out-of-scope pins are ignored at runtime', () => {
    const pin = rule({id: 'pin-ghost', kind: 'pin', docId: 'ghost-doc', position: 1});
    const compiled = compileRules([pin], DEFAULT_CORPUS);
    expect(compiled.diagnostics.some((d) => d.code === 'unknown_doc')).toBe(true);
    const result = evaluateSample(web, compiled, DEFAULT_CORPUS);
    expect(result.chain.find((step) => step.type === 'pin-ignored')?.reason).toBe('unknown_doc');
  });
});

describe('failure isolation and traceability', () => {
  it('a throwing sample is reported as ok:false without affecting others', () => {
    const compiled = compileRules([], DEFAULT_CORPUS);
    const malicious: CompiledRules = {
      ...compiled,
      ordered: [
        {
          authorIndex: 0,
          rule: rule({id: 'boom', kind: 'rewrite'}),
          matcher: {
            test: () => {
              throw new Error('matcher exploded');
            },
            apply: () => '',
            testDoc: () => false,
          },
        },
      ],
    };
    const failed = evaluateSampleSafe({id: 'broken', text: 'x', scope: 'web'}, malicious, DEFAULT_CORPUS);
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/matcher exploded/);

    const healthy = evaluateSampleSafe({id: 'fine', text: 'iphone 16', scope: 'web'}, compiled, DEFAULT_CORPUS);
    expect(healthy.ok).toBe(true);
  });

  it('every final result traces back to the rule that produced it', () => {
    const pin = rule({id: 'pin-pro', kind: 'pin', pattern: 'iphone', docId: 'iphone-16-pro', position: 2});
    const demote = rule({
      id: 'dw',
      kind: 'demote',
      matchType: 'regex',
      pattern: 'iphone',
      docPattern: 'case',
      action: 'downweight',
      factor: 0.2,
    });
    const result = run([pin, demote], {id: 's', text: 'iphone', scope: 'shop'});
    const pinned = result.results.find((entry) => entry.basis === 'pin')!;
    expect(pinned.ruleIds).toEqual(['pin-pro']);
    const downweighted = result.results.find((entry) => entry.docId === 'iphone-16-case')!;
    expect(downweighted.ruleIds).toEqual(['dw']);
    // Every chain step that names a rule points at an existing rule.
    const ids = new Set([pin.id, demote.id]);
    for (const step of result.chain) {
      if (step.ruleId) expect(ids.has(step.ruleId)).toBe(true);
      if (step.otherRuleId) expect(ids.has(step.otherRuleId)).toBe(true);
    }
  });
});
