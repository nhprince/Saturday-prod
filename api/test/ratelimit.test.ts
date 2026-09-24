import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter, RATE_LIMIT_DEFAULTS } from '../src/services/ratelimit';
import { fakeEnv } from './helpers';

afterEach(() => vi.useRealTimers());

describe('rate-limit config', () => {
  it('returns defaults when nothing is stored', async () => {
    const cfg = await new RateLimiter(fakeEnv()).getConfig();
    expect(cfg).toEqual(RATE_LIMIT_DEFAULTS);
  });

  it('deep-merges provider limits on top of defaults', async () => {
    const limiter = new RateLimiter(fakeEnv());
    await limiter.setConfig({ providerPerMinute: { 'custom-x': 7 } });
    const cfg = await limiter.getConfig();
    expect(cfg.providerPerMinute['custom-x']).toBe(7);
    expect(cfg.providerPerMinute['nvidia-nim']).toBe(30); // default preserved
  });
});

describe('fixed-window counters', () => {
  it('allows up to the limit, then blocks with a retry-after', async () => {
    const limiter = new RateLimiter(fakeEnv());
    await limiter.setConfig({ generalPerMinutePerIP: 2 });
    expect((await limiter.generalAllowed('1.2.3.4')).ok).toBe(true);
    expect((await limiter.generalAllowed('1.2.3.4')).ok).toBe(true);
    const blocked = await limiter.generalAllowed('1.2.3.4');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    // another IP is unaffected
    expect((await limiter.generalAllowed('5.6.7.8')).ok).toBe(true);
  });

  it('resets when the window passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const limiter = new RateLimiter(fakeEnv());
    await limiter.setConfig({ generalPerMinutePerIP: 1 });
    expect((await limiter.generalAllowed('ip')).ok).toBe(true);
    expect((await limiter.generalAllowed('ip')).ok).toBe(false);
    vi.setSystemTime(1_000_000 + 61_000);
    expect((await limiter.generalAllowed('ip')).ok).toBe(true);
  });

  it('chat gate reports per_minute before per_day', async () => {
    const limiter = new RateLimiter(fakeEnv());
    await limiter.setConfig({ chatPerMinutePerIP: 1, chatPerDayPerIP: 100 });
    expect((await limiter.chatAllowed('ip')).ok).toBe(true);
    const second = await limiter.chatAllowed('ip');
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('per_minute');
  });

  it('chat gate reports per_day once the daily budget is spent', async () => {
    const limiter = new RateLimiter(fakeEnv());
    await limiter.setConfig({ chatPerMinutePerIP: 100, chatPerDayPerIP: 2 });
    expect((await limiter.chatAllowed('ip')).ok).toBe(true);
    expect((await limiter.chatAllowed('ip')).ok).toBe(true);
    const third = await limiter.chatAllowed('ip');
    expect(third.ok).toBe(false);
    expect(third.reason).toBe('per_day');
  });

  it('provider limits are global across visitors and default for unknown providers', async () => {
    const limiter = new RateLimiter(fakeEnv());
    await limiter.setConfig({ providerPerMinuteDefault: 1 });
    // NB: providerAllowed consumes a token when it succeeds — so check limit and
    // admission on the same call.
    const first = await limiter.providerAllowed('brand-new-provider');
    expect(first.limit).toBe(1);
    expect(first.ok).toBe(true);
    expect((await limiter.providerAllowed('brand-new-provider')).ok).toBe(false);
  });

  it('maxMessageChars reflects stored config', async () => {
    const limiter = new RateLimiter(fakeEnv());
    expect(await limiter.maxMessageChars()).toBe(8000);
    await limiter.setConfig({ maxMessageChars: 4000 });
    expect(await limiter.maxMessageChars()).toBe(4000);
  });
});

describe('storage faults fail OPEN, never take the API down', () => {
  /* Regression test for a production outage: when KV writes hit the free
     plan's daily quota, every limiter threw *outside* the request's error
     handler and the whole Worker answered Cloudflare 1101 for every route —
     including /api/health. */
  const deadKV = {
    async get() { throw new Error('KV_STORAGE_QUOTA_EXCEEDED'); },
    async put() { throw new Error('KV_STORAGE_QUOTA_EXCEEDED'); },
    async delete() { throw new Error('KV_STORAGE_QUOTA_EXCEEDED'); },
  };

  it('generalAllowed allows when the store is down', async () => {
    const limiter = new RateLimiter(fakeEnv({ REGISTRY: deadKV } as any));
    expect((await limiter.generalAllowed('ip')).ok).toBe(true);
  });

  it('chatAllowed allows when the store is down', async () => {
    const limiter = new RateLimiter(fakeEnv({ REGISTRY: deadKV } as any));
    expect((await limiter.chatAllowed('ip')).ok).toBe(true);
  });

  it('providerAllowed allows when the store is down', async () => {
    const limiter = new RateLimiter(fakeEnv({ REGISTRY: deadKV } as any));
    expect((await limiter.providerAllowed('nvidia-nim')).ok).toBe(true);
  });

  it('maxMessageChars falls back to the default when the store is down', async () => {
    const limiter = new RateLimiter(fakeEnv({ REGISTRY: deadKV } as any));
    expect(await limiter.maxMessageChars()).toBe(8000);
  });
});
