import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {draftHash} from '../src/shared/drafthash';
import type {Rule, SampleQuery} from '../src/shared/model';
import {exactRewrite, pinRule} from './helpers';

const RULES: Rule[] = [exactRewrite('r-apple', 10, 'apple', 'apple inc'), pinRule('r-pin', 10, 'apple inc', ['d1'])];
const SAMPLES: SampleQuery[] = [
  {id: 's1', text: 'apple'},
  {id: 's2', text: 'mercury'},
];

describe('experiment records', () => {
  it('serves bootstrap metadata marking the workbench experiment-only', async () => {
    const app = createApp();
    const {body} = await request(app).get('/api/bootstrap').expect(200);
    expect(body.mode).toBe('experiment-only');
  });

  it('loads and conditionally updates a record', async () => {
    const app = createApp();
    const before = await request(app).get('/api/experiments/alpha').expect(200);
    expect(before.headers.etag).toBe(String(before.body.revision));

    const saved = await request(app)
      .put('/api/experiments/alpha')
      .send({revision: before.body.revision, rules: RULES, samples: SAMPLES})
      .expect(200);
    expect(saved.body.revision).toBe(before.body.revision + 1);
    expect(saved.body.rules).toHaveLength(2);

    await request(app)
      .put('/api/experiments/alpha')
      .send({revision: before.body.revision, rules: RULES, samples: SAMPLES})
      .expect(409)
      .expect((res) => expect(res.body.error).toBe('revision_conflict'));
  });

  it('lets exactly one of two concurrent saves win', async () => {
    const app = createApp();
    const before = await request(app).get('/api/experiments/beta').expect(200);
    const payload = (marker: string) => ({
      revision: before.body.revision,
      rules: [exactRewrite('r-' + marker, 10, 'apple', marker)],
      samples: SAMPLES,
    });
    const [first, second] = await Promise.all([
      request(app).put('/api/experiments/beta').send(payload('one')),
      request(app).put('/api/experiments/beta').send(payload('two')),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  it('rejects invalid drafts with per-field errors', async () => {
    const app = createApp();
    const before = await request(app).get('/api/experiments/alpha').expect(200);
    const {body} = await request(app)
      .put('/api/experiments/alpha')
      .send({revision: before.body.revision, rules: [{id: 'r-x', kind: 'rewrite'}], samples: SAMPLES})
      .expect(400);
    expect(body.error).toBe('invalid_draft');
    expect(body.errors.length).toBeGreaterThan(0);
  });
});

describe('simulation binding to the draft hash', () => {
  it('rejects a simulation whose hash does not match the posted draft', async () => {
    const app = createApp();
    const draft = {rules: RULES, samples: SAMPLES};
    const {body} = await request(app)
      .post('/api/experiments/alpha/simulate')
      .send({...draft, draftHash: '0000000000000000'})
      .expect(409);
    expect(body.error).toBe('draft_hash_mismatch');
    expect(body.expected).toBe(draftHash(draft));
  });

  it('rejects a stale hash after the draft changes', async () => {
    const app = createApp();
    const oldDraft = {rules: RULES, samples: SAMPLES};
    const staleHash = draftHash(oldDraft);
    const newDraft = {rules: [...RULES, exactRewrite('r-extra', 1, 'mercury', 'mercury planet')], samples: SAMPLES};
    // Hash belongs to the old draft, body carries the new one: must not bind.
    await request(app)
      .post('/api/experiments/alpha/simulate')
      .send({...newDraft, draftHash: staleHash})
      .expect(409);
  });

  it('runs a bound simulation and echoes the draft hash', async () => {
    const app = createApp();
    const draft = {rules: RULES, samples: SAMPLES};
    const hash = draftHash(draft);
    const {body} = await request(app)
      .post('/api/experiments/alpha/simulate')
      .send({...draft, draftHash: hash})
      .expect(200);
    expect(body.draftHash).toBe(hash);
    expect(body.results).toHaveLength(2);
    const apple = body.results[0];
    expect(apple.finalQuery).toBe('apple inc');
    expect(apple.results[0]).toMatchObject({docId: 'd1', pinned: true, viaRuleId: 'r-pin'});
    expect(apple.chain.map((event: {ruleId: string | null}) => event.ruleId)).toEqual(['r-apple', 'r-pin']);
  });

  it('isolates a failing sample from the rest of the batch', async () => {
    const app = createApp();
    const draft = {
      rules: [exactRewrite('r-ab', 10, 'a', 'b'), exactRewrite('r-ba', 9, 'b', 'a')],
      samples: [
        {id: 's1', text: 'a'},
        {id: 's2', text: 'mercury'},
      ],
    };
    const {body} = await request(app)
      .post('/api/experiments/alpha/simulate')
      .send({...draft, draftHash: draftHash(draft)})
      .expect(200);
    expect(body.diagnostics.some((d: {code: string}) => d.code === 'rewrite_loop')).toBe(true);
    expect(body.results[0]).toMatchObject({sampleId: 's1', status: 'error', error: {code: 'rewrite_loop_exceeded'}});
    expect(body.results[1]).toMatchObject({sampleId: 's2', status: 'ok', finalQuery: 'mercury'});
  });

  it('returns 404 for unknown experiments', async () => {
    const app = createApp();
    const draft = {rules: RULES, samples: SAMPLES};
    await request(app)
      .post('/api/experiments/nope/simulate')
      .send({...draft, draftHash: draftHash(draft)})
      .expect(404);
  });
});
