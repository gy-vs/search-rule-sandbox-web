import {createHash} from 'node:crypto';
import {canonicalDraft} from '../shared/canonical';
import type {Diagnostic, Doc, SampleQuery, SimulationResponse} from '../shared/types';
import {compileRules, evaluateSampleSafe, type CompiledRules} from './engine';

export const DEFAULT_CORPUS: Doc[] = [
  {id: 'iphone-16', title: 'iPhone 16', scopes: ['web', 'shop']},
  {id: 'iphone-16-pro', title: 'iPhone 16 Pro', scopes: ['web', 'shop']},
  {id: 'iphone-16-case', title: 'iPhone 16 Case Clear', scopes: ['shop']},
  {id: 'iphone-charger', title: 'iPhone Charger USB-C', scopes: ['shop']},
  {id: 'iphone-repair', title: 'iPhone Screen Repair Service', scopes: ['web', 'shop']},
  {id: 'galaxy-s25', title: 'Galaxy S25 Phone', scopes: ['web', 'shop']},
  {id: 'cheap-phones', title: 'Cheap Phones Outlet', scopes: ['web', 'shop']},
  {id: 'nike-run', title: 'Nike Running Shoes', scopes: ['shop']},
];

export function computeDraftHash(draft: {rules: unknown; samples: unknown}): string {
  return createHash('sha256').update(canonicalDraft(draft)).digest('hex');
}

export interface SimulationInput {
  rules: unknown;
  samples: unknown;
  draftHash?: string;
  corpus?: Doc[];
}

export interface Simulated extends SimulationResponse {
  hashMismatch?: {provided: string; computed: string};
}

export function simulate(input: SimulationInput): Simulated {
  const rules = Array.isArray(input.rules) ? input.rules : [];
  const samples: SampleQuery[] = Array.isArray(input.samples) ? (input.samples as SampleQuery[]) : [];
  const corpus = input.corpus ?? DEFAULT_CORPUS;
  const draftHash = computeDraftHash({rules, samples});
  const result: Simulated = {draftHash, diagnostics: [], compiledOrder: [], results: []};

  if (input.draftHash !== undefined && input.draftHash !== draftHash) {
    result.hashMismatch = {provided: String(input.draftHash), computed: draftHash};
  }

  const compiled: CompiledRules = compileRules(rules, corpus);
  result.diagnostics = compiled.diagnostics;
  result.compiledOrder = compiled.ordered.map((entry) => entry.rule.id);
  result.results = samples.map((sample) => evaluateSampleSafe(sample, compiled, corpus));

  // Aggregate runtime diagnostics after compilation diagnostics.
  const runtime: Diagnostic[] = [];
  for (const sample of result.results) runtime.push(...sample.diagnostics);
  result.diagnostics = [...result.diagnostics, ...runtime];

  return result;
}
