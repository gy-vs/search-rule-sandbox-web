import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {computeDraftHash} from '../src/server/simulate';
import type {Rule} from '../src/shared/types';

function rewrite(id: string, pattern: string, replacement: string, extra: Partial<Rule> = {}): Rule {
  return {id, kind: 'rewrite', matchType: 'exact', pattern, replacement, scope: '*', priority: 0, enabled: true, ...extra};
}

describe('persistence and concurrent saves', () => {
  it('loads a record and enforces optimistic concurrency', async () => {
    const app = createApp();
    const before = await request(app).get('/api/experiments/alpha').expect(200);
    expect(before.body.revision).toBeTypeOf('number');
    expect(before.body.draftHash).toBeTypeOf('string');

    await request(app)
      .put('/api/experiments/alpha')
      .send({rules: [], samples: [], revision: before.body.revision})
      .expect(200)
      .expect((res) => expect(res.body.revision).toBe(before.body.revision + 1));

    const stale = await request(app)
      .put('/api/experiments/alpha')
      .send({rules: [], samples: [], revision: before.body.revision})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.revision).toBe(before.body.revision + 1);
  });

  it('two concurrent saves against the same revision cannot both win', async () => {
    const app = createApp();
    const before = await request(app).get('/api/experiments/beta').expect(200);
    const revision = before.body.revision;
    const rulesA = [rewrite('a', 'q', 'A')];
    const rulesB = [rewrite('b', 'q', 'B')];
    const [first, second] = await Promise.all([
      request(app).put('/api/experiments/beta').send({rules: rulesA, samples: [], revision}),
      request(app).put('/api/experiments/beta').send({rules: rulesB, samples: [], revision}),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winner = first.status === 200 ? first.body : second.body;
    expect(winner.rules.map((r: Rule) => r.id)).toEqual(first.status === 200 ? ['a'] : ['b']);
  });
});

describe('draft-bound simulation', () => {
  it('runs samples against the submitted draft and returns a decision chain', async () => {
    const app = createApp();
    const rules = [rewrite('rw', 'iphone 16 phone', 'iphone 16')];
    const samples = [{id: 's1', text: 'iphone 16 phone', scope: 'shop'}];
    const draftHash = computeDraftHash({rules, samples});

    const res = await request(app)
      .post('/api/experiments/alpha/simulate')
      .send({rules, samples, draftHash})
      .expect(200);
    expect(res.body.draftHash).toBe(draftHash);
    const result = res.body.results[0];
    expect(result.ok).toBe(true);
    expect(result.finalQuery).toBe('iphone 16');
    expect(result.chain[0]).toMatchObject({type: 'rewrite', ruleId: 'rw'});
  });

  it('rejects a simulation whose draftHash does not match the payload', async () => {
    const app = createApp();
    const rules = [rewrite('rw', 'a', 'b')];
    const samples: never[] = [];
    const stale = await request(app)
      .post('/api/experiments/alpha/simulate')
      .send({rules, samples, draftHash: computeDraftHash({rules: [rewrite('old', 'x', 'y')], samples})})
      .expect(409);
    expect(stale.body.error).toBe('draft_hash_mismatch');
    expect(stale.body.provided).not.toBe(stale.body.computed);
  });

  it('requires a draft hash', async () => {
    const app = createApp();
    await request(app).post('/api/experiments/alpha/simulate').send({rules: [], samples: []}).expect(400);
  });

  it('keeps simulation failures isolated to the failing sample', async () => {
    const app = createApp();
    const rules: Rule[] = [];
    const samples = [
      {id: 'bad', text: 42, scope: 'web'},
      {id: 'good', text: 'iphone 16', scope: 'web'},
    ];
    const draftHash = computeDraftHash({rules, samples});
    const res = await request(app)
      .post('/api/experiments/alpha/simulate')
      .send({rules, samples, draftHash})
      .expect(200);
    const bad = res.body.results.find((r: {sampleId: string}) => r.sampleId === 'bad');
    const good = res.body.results.find((r: {sampleId: string}) => r.sampleId === 'good');
    expect(bad.ok).toBe(false);
    expect(good.ok).toBe(true);
  });
});
