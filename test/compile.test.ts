import {describe, expect, it} from 'vitest';
import {compileRules} from '../src/server/compile';
import {exactRewrite, pinRule, regexRewrite} from './helpers';

describe('compileRules ordering', () => {
  it('orders exact matchers ahead of regex at equal priority and scope', () => {
    const {compiled} = compileRules([
      regexRewrite('r-regex', 10, '^apple$', 'regex hit'),
      exactRewrite('r-exact', 10, 'apple', 'apple inc'),
    ]);
    expect(compiled.map((rule) => rule.id)).toEqual(['r-exact', 'r-regex']);
  });

  it('orders a narrower scope ahead of a broader one at equal priority', () => {
    const {compiled} = compileRules([
      exactRewrite('r-global', 10, 'apple', 'apple inc', 'all'),
      regexRewrite('r-scoped', 10, '^apple', 'apple mobile', 'web/mobile'),
    ]);
    expect(compiled.map((rule) => rule.id)).toEqual(['r-scoped', 'r-global']);
  });

  it('orders by priority before anything else', () => {
    const {compiled} = compileRules([
      exactRewrite('r-low', 1, 'apple', 'low', 'web/mobile'),
      regexRewrite('r-high', 100, '^apple', 'high', 'all'),
    ]);
    expect(compiled.map((rule) => rule.id)).toEqual(['r-high', 'r-low']);
  });
});

describe('compileRules diagnostics', () => {
  it('flags a rewrite shadowed by a higher-priority identical matcher as unreachable', () => {
    const {diagnostics} = compileRules([exactRewrite('r-top', 10, 'apple', 'apple inc'), exactRewrite('r-bottom', 5, 'apple', 'apple fruit')]);
    expect(diagnostics).toContainEqual(expect.objectContaining({code: 'unreachable', ruleId: 'r-bottom', shadowedBy: 'r-top'}));
  });

  it('does not flag rewrites in sibling scopes that never overlap', () => {
    const {diagnostics} = compileRules([exactRewrite('r-web', 10, 'apple', 'apple inc', 'web'), exactRewrite('r-images', 5, 'apple', 'apple fruit', 'images')]);
    expect(diagnostics.filter((d) => d.code === 'unreachable')).toEqual([]);
  });

  it('flags equal-priority identical matchers with different rewrites as an override conflict', () => {
    const {compiled, diagnostics} = compileRules([exactRewrite('r-b', 10, 'apple', 'apple fruit'), exactRewrite('r-a', 10, 'apple', 'apple inc')]);
    const conflict = diagnostics.find((d) => d.code === 'override_conflict');
    expect(conflict).toBeDefined();
    expect(conflict).toMatchObject({ruleIds: ['r-a', 'r-b'], winner: 'r-a'});
    // Deterministic winner: id order breaks the tie.
    expect(compiled[0].id).toBe('r-a');
  });

  it('detects a two-rule rewrite loop', () => {
    const {diagnostics} = compileRules([exactRewrite('r-ab', 10, 'a', 'b'), exactRewrite('r-ba', 9, 'b', 'a')]);
    const loop = diagnostics.find((d) => d.code === 'rewrite_loop');
    expect(loop).toBeDefined();
    expect(loop).toMatchObject({ruleIds: expect.arrayContaining(['r-ab', 'r-ba'])});
  });

  it('detects a self-referencing rewrite loop', () => {
    const {diagnostics} = compileRules([exactRewrite('r-self', 10, 'a', 'a')]);
    expect(diagnostics.some((d) => d.code === 'rewrite_loop' && 'ruleIds' in d && d.ruleIds.includes('r-self'))).toBe(true);
  });

  it('reports invalid regexes and excludes them from the compiled set', () => {
    const {compiled, diagnostics} = compileRules([regexRewrite('r-broken', 10, '(', 'x'), exactRewrite('r-ok', 5, 'apple', 'apple inc')]);
    expect(diagnostics).toContainEqual(expect.objectContaining({code: 'invalid_regex', ruleId: 'r-broken'}));
    expect(compiled.map((rule) => rule.id)).toEqual(['r-ok']);
  });

  it('flags duplicate pin effects on the same matcher', () => {
    const {diagnostics} = compileRules([pinRule('r-pin-1', 10, 'apple', ['d1']), pinRule('r-pin-2', 5, 'apple', ['d1'])]);
    expect(diagnostics).toContainEqual(expect.objectContaining({code: 'duplicate_effect', ruleId: 'r-pin-2', shadowedBy: 'r-pin-1'}));
  });

  it('ignores disabled rules entirely', () => {
    const disabled = {...exactRewrite('r-off', 10, 'apple', 'x'), enabled: false};
    const {compiled, diagnostics} = compileRules([disabled, exactRewrite('r-on', 5, 'apple', 'apple inc')]);
    expect(compiled.map((rule) => rule.id)).toEqual(['r-on']);
    expect(diagnostics).toEqual([]);
  });
});
