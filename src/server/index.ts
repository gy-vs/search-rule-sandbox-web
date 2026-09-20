import express from 'express';
import {fileURLToPath} from 'node:url';
import type {ExperimentRow, Rule, SampleQuery} from '../shared/model';
import {draftHash} from '../shared/drafthash';
import {compileRules} from './compile';
import {runSimulation} from './simulate';

const now = () => new Date().toISOString();

const rows: ExperimentRow[] = [
  {
    id: 'alpha',
    name: 'Apple disambiguation',
    revision: 3,
    updatedAt: new Date(0).toISOString(),
    rules: [
      {id: 'r-rewrite-apple', kind: 'rewrite', enabled: true, priority: 10, scope: 'all', match: {type: 'exact', value: 'apple'}, replacement: 'apple inc'},
      {id: 'r-pin-apple-inc', kind: 'pin', enabled: true, priority: 10, scope: 'all', match: {type: 'exact', value: 'apple inc'}, pins: ['d1']},
      {id: 'r-demote-laptops', kind: 'demote', enabled: true, priority: 5, scope: 'all', match: {type: 'regex', pattern: 'apple'}, demoteDocIds: ['d8'], demoteFactor: 0.2},
    ],
    samples: [
      {id: 's1', text: 'apple'},
      {id: 's2', text: 'apple', filters: {category: 'news'}},
      {id: 's3', text: 'mercury'},
    ],
  },
  {
    id: 'beta',
    name: 'Loop playground',
    revision: 5,
    updatedAt: new Date(1000).toISOString(),
    rules: [
      {id: 'r-java-coffee', kind: 'rewrite', enabled: true, priority: 10, scope: 'all', match: {type: 'exact', value: 'java'}, replacement: 'java coffee'},
      {id: 'r-coffee-java', kind: 'rewrite', enabled: true, priority: 9, scope: 'all', match: {type: 'exact', value: 'java coffee'}, replacement: 'java'},
    ],
    samples: [
      {id: 's1', text: 'java'},
      {id: 's2', text: 'mercury'},
    ],
  },
];

function validateMatch(match: unknown, path: string, errors: string[]): void {
  if (typeof match !== 'object' || match === null) {
    errors.push(`${path}: match must be an object`);
    return;
  }
  const spec = match as Record<string, unknown>;
  if (spec.type === 'exact' || spec.type === 'prefix') {
    if (typeof spec.value !== 'string') errors.push(`${path}: match.value must be a string`);
  } else if (spec.type === 'regex') {
    if (typeof spec.pattern !== 'string') errors.push(`${path}: match.pattern must be a string`);
    if (spec.flags !== undefined && typeof spec.flags !== 'string') errors.push(`${path}: match.flags must be a string`);
  } else {
    errors.push(`${path}: match.type must be exact, prefix or regex`);
  }
}

function validateRules(rules: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(rules)) return ['rules must be an array'];
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    const path = `rules[${index}]`;
    if (typeof rule !== 'object' || rule === null) {
      errors.push(`${path}: must be an object`);
      return;
    }
    const r = rule as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id === '') errors.push(`${path}: id is required`);
    else if (seen.has(r.id)) errors.push(`${path}: duplicate rule id ${r.id}`);
    else seen.add(r.id);
    if (!['rewrite', 'pin', 'demote'].includes(String(r.kind))) errors.push(`${path}: kind must be rewrite, pin or demote`);
    if (typeof r.enabled !== 'boolean') errors.push(`${path}: enabled must be a boolean`);
    if (typeof r.priority !== 'number' || !Number.isFinite(r.priority)) errors.push(`${path}: priority must be a finite number`);
    if (typeof r.scope !== 'string' || r.scope === '') errors.push(`${path}: scope is required`);
    validateMatch(r.match, path, errors);
    if (r.kind === 'rewrite' && typeof r.replacement !== 'string') errors.push(`${path}: replacement is required for rewrites`);
    if (r.kind === 'pin' && (!Array.isArray(r.pins) || r.pins.some((p) => typeof p !== 'string'))) errors.push(`${path}: pins must be a string array`);
    if (r.kind === 'demote') {
      if (!Array.isArray(r.demoteDocIds) || r.demoteDocIds.some((d) => typeof d !== 'string')) errors.push(`${path}: demoteDocIds must be a string array`);
      if (r.demoteFactor !== undefined && (typeof r.demoteFactor !== 'number' || r.demoteFactor <= 0)) errors.push(`${path}: demoteFactor must be a positive number`);
    }
  });
  return errors;
}

function validateSamples(samples: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(samples)) return ['samples must be an array'];
  const seen = new Set<string>();
  samples.forEach((sample, index) => {
    const path = `samples[${index}]`;
    if (typeof sample !== 'object' || sample === null) {
      errors.push(`${path}: must be an object`);
      return;
    }
    const s = sample as Record<string, unknown>;
    if (typeof s.id !== 'string' || s.id === '') errors.push(`${path}: id is required`);
    else if (seen.has(s.id)) errors.push(`${path}: duplicate sample id ${s.id}`);
    else seen.add(s.id);
    if (typeof s.text !== 'string') errors.push(`${path}: text must be a string`);
    if (s.scope !== undefined && typeof s.scope !== 'string') errors.push(`${path}: scope must be a string`);
    if (s.filters !== undefined && (typeof s.filters !== 'object' || s.filters === null || Array.isArray(s.filters))) {
      errors.push(`${path}: filters must be an object`);
    }
  });
  return errors;
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'search-relevance', mode: 'experiment-only', note: 'Rules apply to experiment traffic only; production search is never affected.', count: rows.length}),
  );

  app.get('/api/experiments', (_req, res) => res.json(rows.map(({rules: _rules, samples: _samples, ...summary}) => summary)));

  app.get('/api/experiments/:id', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });

  app.put('/api/experiments/:id', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body?.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    const errors = [...validateRules(req.body?.rules), ...validateSamples(req.body?.samples)];
    if (errors.length > 0) return res.status(400).json({error: 'invalid_draft', errors});
    row.rules = req.body.rules as Rule[];
    row.samples = req.body.samples as SampleQuery[];
    row.revision += 1;
    row.updatedAt = now();
    res.json(row);
  });

  app.post('/api/experiments/:id/simulate', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const errors = [...validateRules(req.body?.rules), ...validateSamples(req.body?.samples)];
    if (errors.length > 0) return res.status(400).json({error: 'invalid_draft', errors});
    const draft = {rules: req.body.rules as Rule[], samples: req.body.samples as SampleQuery[]};
    const expected = draftHash(draft);
    // The simulation must be bound to the exact draft the client is showing;
    // a hash from an older draft means the results would not match the editor.
    if (req.body?.draftHash !== expected) {
      return res.status(409).json({error: 'draft_hash_mismatch', expected});
    }
    const {compiled, diagnostics} = compileRules(draft.rules);
    res.json({draftHash: expected, diagnostics, results: runSimulation(compiled, draft.samples)});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
