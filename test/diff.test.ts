import {describe, expect, it} from 'vitest';
import {diffList} from '../src/client/lib/diff';

const rule = (id: string, extra = {}) => ({id, kind: 'rewrite', pattern: id, ...extra});

describe('diffList', () => {
  it('reports no changes for identical lists', () => {
    expect(diffList([rule('a')], [rule('a')]).isEmpty).toBe(true);
  });

  it('detects added and removed rules', () => {
    const diff = diffList([rule('a'), rule('b')], [rule('a'), rule('b'), rule('c')]);
    expect(diff.added.map((entry) => entry.id)).toEqual(['c']);
    expect(diff.removed).toEqual([]);
    const removed = diffList([rule('a')], []);
    expect(removed.removed.map((entry) => entry.id)).toEqual(['a']);
  });

  it('reports field changes keyed by id', () => {
    const diff = diffList([rule('a', {priority: 0})], [rule('a', {priority: 10})]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].type === 'changed' && diff.changed[0].fields).toEqual([
      {field: 'priority', from: 0, to: 10},
    ]);
  });

  it('classifies a pure reorder as moved, not add/remove', () => {
    const diff = diffList([rule('a'), rule('b'), rule('c')], [rule('c'), rule('a'), rule('b')]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.moved.map((entry) => entry.id)).toEqual(['c']);
    const moved = diff.moved[0];
    expect(moved.type === 'moved' && moved.fromIndex).toBe(2);
    expect(moved.type === 'moved' && moved.toIndex).toBe(0);
  });

  it('treats a change plus position shift as changed', () => {
    const diff = diffList([rule('a', {pattern: 'x'}), rule('b')], [rule('b'), rule('a', {pattern: 'y'})]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.map((entry) => entry.id)).toEqual(['a']);
  });

  it('handles empty and malformed inputs', () => {
    expect(diffList(null, undefined).isEmpty).toBe(true);
    expect(diffList([{noId: true}], [rule('a')]).added.map((entry) => entry.id)).toEqual(['a']);
  });
});
