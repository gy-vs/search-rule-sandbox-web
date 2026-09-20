import type {Rule} from '../src/shared/model';

export function exactRewrite(id: string, priority: number, value: string, replacement: string, scope = 'all'): Rule {
  return {id, kind: 'rewrite', enabled: true, priority, scope, match: {type: 'exact', value}, replacement};
}

export function regexRewrite(id: string, priority: number, pattern: string, replacement: string, scope = 'all'): Rule {
  return {id, kind: 'rewrite', enabled: true, priority, scope, match: {type: 'regex', pattern}, replacement};
}

export function pinRule(id: string, priority: number, value: string, pins: string[]): Rule {
  return {id, kind: 'pin', enabled: true, priority, scope: 'all', match: {type: 'exact', value}, pins};
}

export function demoteRule(id: string, priority: number, pattern: string, docIds: string[], factor = 0.1): Rule {
  return {id, kind: 'demote', enabled: true, priority, scope: 'all', match: {type: 'regex', pattern}, demoteDocIds: docIds, demoteFactor: factor};
}
