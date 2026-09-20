import {describe, expect, it} from 'vitest';
import {compileRules} from '../src/server/compile';
import {MAX_REWRITE_ITERATIONS, runSimulation} from '../src/server/simulate';
import type {Rule, SampleQuery} from '../src/shared/model';
import {demoteRule, exactRewrite, pinRule, regexRewrite} from './helpers';

function simulate(rules: Rule[], samples: SampleQuery[]) {
  const {compiled, diagnostics} = compileRules(rules);
  return {diagnostics, results: runSimulation(compiled, samples)};
}

describe('simulation: rewrite matching', () => {
  it('lets an exact match win over a regex at equal priority', () => {
    const {results} = simulate(
      [regexRewrite('r-regex', 10, '^apple$', 'regex hit'), exactRewrite('r-exact', 10, 'apple', 'apple inc')],
      [{id: 's1', text: 'apple'}],
    );
    expect(results[0].status).toBe('ok');
    expect(results[0].finalQuery).toBe('apple inc');
    expect(results[0].chain[0]).toMatchObject({ruleId: 'r-exact', kind: 'rewrite', before: 'apple', after: 'apple inc'});
  });

  it('re-matches from the top after every rewrite', () => {
    // r-high cannot match the original query, only the rewritten one.
    const {results} = simulate(
      [exactRewrite('r-high', 10, 'apple pie', 'apple pie recipe'), exactRewrite('r-low', 1, 'apple', 'apple pie')],
      [{id: 's1', text: 'apple'}],
    );
    expect(results[0].finalQuery).toBe('apple pie recipe');
    expect(results[0].chain.map((event) => event.ruleId)).toEqual(['r-low', 'r-high']);
  });

  it('fails only the looping sample and keeps its decision chain', () => {
    const {diagnostics, results} = simulate(
      [exactRewrite('r-ab', 10, 'a', 'b'), exactRewrite('r-ba', 9, 'b', 'a')],
      [
        {id: 's1', text: 'a'},
        {id: 's2', text: 'mercury'},
      ],
    );
    expect(diagnostics.some((d) => d.code === 'rewrite_loop')).toBe(true);

    const looping = results[0];
    expect(looping.status).toBe('error');
    expect(looping.error?.code).toBe('rewrite_loop_exceeded');
    expect(looping.chain).toHaveLength(MAX_REWRITE_ITERATIONS);
    expect(looping.chain[0]).toMatchObject({ruleId: 'r-ab', before: 'a', after: 'b'});
    expect(looping.chain[1]).toMatchObject({ruleId: 'r-ba', before: 'b', after: 'a'});

    const healthy = results[1];
    expect(healthy.status).toBe('ok');
    expect(healthy.finalQuery).toBe('mercury');
    expect(healthy.results?.[0].docId).toBe('d6');
  });
});

describe('simulation: pins, demotes and filters', () => {
  it('pins a doc to the top and records the responsible rule', () => {
    const {results} = simulate([pinRule('r-pin', 10, 'apple', ['d2'])], [{id: 's1', text: 'apple'}]);
    expect(results[0].results?.[0]).toMatchObject({docId: 'd2', pinned: true, viaRuleId: 'r-pin'});
    expect(results[0].chain.some((event) => event.kind === 'pin' && event.ruleId === 'r-pin' && event.docId === 'd2')).toBe(true);
  });

  it('drops a pin that conflicts with query filters and says why', () => {
    const {results} = simulate([pinRule('r-pin', 10, 'apple', ['d2'])], [{id: 's1', text: 'apple', filters: {category: 'news'}}]);
    const result = results[0];
    expect(result.results?.some((doc) => doc.docId === 'd2')).toBe(false);
    const conflict = result.chain.find((event) => event.kind === 'pin_filtered');
    expect(conflict).toMatchObject({ruleId: 'r-pin', docId: 'd2'});
  });

  it('demotes a doc by multiplying its score', () => {
    const {results} = simulate([demoteRule('r-demote', 5, 'apple', ['d1'], 0.1)], [{id: 's1', text: 'apple'}]);
    const docs = results[0].results ?? [];
    const d1 = docs.find((doc) => doc.docId === 'd1');
    const d8 = docs.find((doc) => doc.docId === 'd8');
    expect(d1).toMatchObject({demoted: true, viaRuleId: 'r-demote'});
    expect(d1!.score).toBeLessThan(d8!.score);
    expect(docs.indexOf(d1!)).toBeGreaterThan(docs.indexOf(d8!));
    expect(results[0].chain.some((event) => event.kind === 'demote' && event.ruleId === 'r-demote' && event.docId === 'd1')).toBe(true);
  });

  it('applies higher-priority pins ahead of lower-priority ones', () => {
    const {results} = simulate([pinRule('r-low', 1, 'apple', ['d3']), pinRule('r-high', 10, 'apple', ['d8'])], [{id: 's1', text: 'apple'}]);
    expect(results[0].results?.slice(0, 2).map((doc) => doc.docId)).toEqual(['d8', 'd3']);
  });
});

describe('simulation: rule reordering', () => {
  const a = (priority: number) => exactRewrite('r-a', priority, 'apple', 'apple inc');
  const b = (priority: number) => exactRewrite('r-b', priority, 'apple', 'apple fruit');

  it('flips the winning rewrite when priorities are swapped', () => {
    const first = simulate([a(5), b(10)], [{id: 's1', text: 'apple'}]);
    expect(first.results[0].finalQuery).toBe('apple fruit');
    expect(first.diagnostics).toContainEqual(expect.objectContaining({code: 'unreachable', ruleId: 'r-a', shadowedBy: 'r-b'}));

    const second = simulate([a(10), b(5)], [{id: 's1', text: 'apple'}]);
    expect(second.results[0].finalQuery).toBe('apple inc');
    expect(second.diagnostics).toContainEqual(expect.objectContaining({code: 'unreachable', ruleId: 'r-b', shadowedBy: 'r-a'}));
  });
});

describe('simulation: scopes', () => {
  it('applies scoped rules only to queries inside that scope', () => {
    const rules = [exactRewrite('r-mobile', 10, 'apple', 'apple mobile', 'web/mobile')];
    const inside = simulate(rules, [{id: 's1', text: 'apple', scope: 'web/mobile'}]);
    expect(inside.results[0].finalQuery).toBe('apple mobile');
    const outside = simulate(rules, [{id: 's2', text: 'apple', scope: 'images'}]);
    expect(outside.results[0].finalQuery).toBe('apple');
  });
});
