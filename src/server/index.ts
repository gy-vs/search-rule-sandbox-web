import express from 'express';
import {fileURLToPath} from 'node:url';
import type {Experiment, ExperimentDraft} from '../shared/types';
import {seedExperiments} from './seed';
import {computeDraftHash, simulate} from './simulate';

export interface ExperimentRow extends Experiment {}

export function createApp(rows: ExperimentRow[] = seedExperiments()) {
  const app = express();
  app.use(express.json({limit: '2mb'}));

  function findRow(id: string) {
    return rows.find((row) => row.id === id);
  }

  app.get('/api/bootstrap', (_req, res) => {
    res.json({family: 'search-relevance', count: rows.length});
  });

  app.get('/api/experiments', (_req, res) => {
    res.json(
      rows.map(({rules, samples, ...summary}) => ({
        ...summary,
        draftHash: computeDraftHash({rules, samples}),
        ruleCount: rules.length,
        sampleCount: samples.length,
      })),
    );
  });

  app.get('/api/experiments/:id', (req, res) => {
    const row = findRow(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json({...row, draftHash: computeDraftHash({rules: row.rules, samples: row.samples})});
  });

  app.put('/api/experiments/:id', (req, res) => {
    const row = findRow(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const body = (req.body ?? {}) as Partial<ExperimentDraft & {revision: unknown}>;
    const revision = typeof body.revision === 'number' ? body.revision : NaN;
    if (revision !== row.revision) {
      return res.status(409).json({
        error: 'revision_conflict',
        current: {...row, draftHash: computeDraftHash({rules: row.rules, samples: row.samples})},
      });
    }
    const rules = Array.isArray(body.rules) ? body.rules : [];
    const samples = Array.isArray(body.samples) ? body.samples : [];
    row.rules = rules as ExperimentRow['rules'];
    row.samples = samples as ExperimentRow['samples'];
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json({...row, draftHash: computeDraftHash({rules: row.rules, samples: row.samples})});
  });

  // Draft-bound simulation: results are only returned when the claimed
  // draftHash matches the payload, so stale UI can never adopt them.
  app.post('/api/experiments/:id/simulate', (req, res) => {
    const row = findRow(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const body = (req.body ?? {}) as {rules?: unknown; samples?: unknown; draftHash?: unknown};
    if (!Array.isArray(body.rules) || !Array.isArray(body.samples)) {
      return res.status(400).json({error: 'bad_request', message: 'rules and samples arrays are required'});
    }
    if (typeof body.draftHash !== 'string') {
      return res.status(400).json({error: 'bad_request', message: 'draftHash is required'});
    }
    const outcome = simulate({rules: body.rules, samples: body.samples, draftHash: body.draftHash});
    if (outcome.hashMismatch) {
      return res.status(409).json({
        error: 'draft_hash_mismatch',
        message: 'Simulation results belong to a different draft.',
        ...outcome.hashMismatch,
      });
    }
    res.json({id: row.id, revision: row.revision, ...outcome});
  });

  // Simulate the persisted revision (no draft binding).
  app.post('/api/experiments/:id/simulate-saved', (req, res) => {
    const row = findRow(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const outcome = simulate({rules: row.rules, samples: row.samples});
    res.json({id: row.id, revision: row.revision, ...outcome});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
