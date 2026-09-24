import { describe, it, expect } from 'vitest';
import { HealthService } from '../src/services/health';
import { fakeEnv } from './helpers';
import { AIModel } from '../src/types';

const mkModel = (id: string) => ({
  id, provider: 'p', providerModelId: id, displayName: id,
  capabilities: { text: true, vision: false, tools: false },
  free: true, tier: 'small', status: 'unknown',
} as unknown as AIModel);

const workingProvider = {
  id: 'p', name: 'P', isConfigured: () => true,
  healthCheck: async () => ({ state: 'WORKING' as const, latencyMs: 5 }),
  listModels: async () => [], generate: async () => { throw new Error('nope'); },
  stream: async function* () { /* never */ },
};

describe('health observe', () => {
  it('marks a successful generation as working with zero failures', async () => {
    const h = new HealthService(fakeEnv());
    const rec = await h.observe('m1', true, 120);
    expect(rec.state).toBe('WORKING');
    expect(rec.status).toBe('available');
    expect(rec.failures).toBe(0);
    expect(rec.cooldownUntil).toBe(0);
    expect(h.usable(rec)).toBe(true);
  });

  it('smooths latency instead of replacing it', async () => {
    const h = new HealthService(fakeEnv());
    await h.observe('m1', true, 100);
    const rec = await h.observe('m1', true, 200);
    expect(rec.latencyMs).toBe(140); // 100*0.6 + 200*0.4
  });

  it('hard failures cool down for ~24h and report unavailable', async () => {
    const h = new HealthService(fakeEnv());
    const rec = await h.observe('m1', false, 50, 'AUTH_FAILED', 'bad key');
    const dayMs = 24 * 60 * 60_000;
    expect(rec.status).toBe('unavailable');
    expect(rec.cooldownUntil - Date.now()).toBeGreaterThan(dayMs - 5000);
    expect(h.usable(rec)).toBe(false);
  });

  it('transient failures back off exponentially, doubling per failure', async () => {
    const h = new HealthService(fakeEnv());
    const first = await h.observe('m1', false, 50, 'ERROR');
    const second = await h.observe('m1', false, 50, 'ERROR');
    const firstWindow = first.cooldownUntil - first.checkedAt;
    const secondWindow = second.cooldownUntil - second.checkedAt;
    expect(firstWindow).toBe(60_000);          // base ERROR cooldown
    expect(secondWindow).toBe(120_000);        // doubled
    expect(second.failures).toBe(2);
    expect(second.status).toBe('degraded');    // transient errors degrade, never vanish
  });

  it('provider 429s degrade with a 5-minute base cooldown', async () => {
    const h = new HealthService(fakeEnv());
    const rec = await h.observe('m1', false, 30, 'RATE_LIMITED');
    expect(rec.status).toBe('degraded');
    expect(rec.cooldownUntil - rec.checkedAt).toBe(5 * 60_000);
  });

  it('a later success clears failures and cooldown', async () => {
    const h = new HealthService(fakeEnv());
    await h.observe('m1', false, 50, 'ERROR');
    const rec = await h.observe('m1', true, 80);
    expect(rec.failures).toBe(0);
    expect(rec.cooldownUntil).toBe(0);
    expect(h.usable(rec)).toBe(true);
  });

  it('fresh() honours the TTL', async () => {
    const h = new HealthService(fakeEnv({ HEALTH_TTL_SECONDS: '10' }));
    const rec = await h.observe('m1', true, 80);
    expect(h.fresh(rec)).toBe(true);
    expect(h.fresh({ ...rec, checkedAt: Date.now() - 20_000 })).toBe(false);
  });

  it('health records persist in KV and come back in all()', async () => {
    const env = fakeEnv();
    const h = new HealthService(env);
    await h.observe('m1', true, 90);
    await h.observe('m2', false, 10, 'NOT_FOUND');
    const all = await new HealthService(env).all();
    expect(all.map((r) => r.modelId).sort()).toEqual(['m1', 'm2']);
  });
});

describe('health sweeps', () => {
  it('a cron-style sweep respects an exhausted budget', async () => {
    const h = new HealthService(fakeEnv({ HEALTH_PROBE_BUDGET: '0' }));
    const r = await h.sweep([mkModel('a'), mkModel('b')], () => workingProvider as any);
    expect(r.checked).toBe(0);
    expect(r.reason).toBe('budget exhausted');
  });

  it('a forced (admin) sweep bypasses the budget', async () => {
    const h = new HealthService(fakeEnv({ HEALTH_PROBE_BUDGET: '0' }));
    const r = await h.sweep([mkModel('a'), mkModel('b')], () => workingProvider as any, { force: true });
    expect(r.checked).toBe(2);
  });

  it('forced passes never re-check what they just probed, so multi-pass runs terminate', async () => {
    const h = new HealthService(fakeEnv());
    const models = [mkModel('a'), mkModel('b')];
    await h.sweep(models, () => workingProvider as any, { force: true });
    const again = await h.sweep(models, () => workingProvider as any, { force: true });
    expect(again.checked).toBe(0);
  });
});
