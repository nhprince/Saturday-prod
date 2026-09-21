/* ============================================================
   Saturday — rate limiting
   Two layers, because a public, no-login site needs both:
   per-IP limits stop one visitor from hammering the API, and a
   global per-provider limit stops the COMBINED traffic of every
   visitor from ever exceeding what a free provider key can take.
   Config lives in KV so an admin can tune it without a deploy.
   ============================================================ */
import { Env } from '../types';

export interface RateLimitConfig {
  generalPerMinutePerIP: number;
  chatPerMinutePerIP: number;
  chatPerDayPerIP: number;
  maxMessageChars: number;
  providerPerMinuteDefault: number;
  providerPerMinute: Record<string, number>;
}

export const RATE_LIMIT_DEFAULTS: RateLimitConfig = {
  generalPerMinutePerIP: 60,
  chatPerMinutePerIP: 12,
  chatPerDayPerIP: 200,
  maxMessageChars: 8000,
  providerPerMinuteDefault: 20,
  providerPerMinute: {
    'nvidia-nim': 30,
    cloudflare: 60,
    openrouter: 20,
  },
};

const CONFIG_KEY = 'admin:rate-limits';

export class RateLimiter {
  constructor(private env: Env) {}

  async getConfig(): Promise<RateLimitConfig> {
    const stored = (await this.env.REGISTRY.get<Partial<RateLimitConfig>>(CONFIG_KEY, 'json')) ?? {};
    return {
      ...RATE_LIMIT_DEFAULTS,
      ...stored,
      providerPerMinute: { ...RATE_LIMIT_DEFAULTS.providerPerMinute, ...(stored.providerPerMinute ?? {}) },
    };
  }

  async setConfig(patch: Partial<RateLimitConfig>): Promise<RateLimitConfig> {
    const current = await this.getConfig();
    const next: RateLimitConfig = {
      ...current,
      ...patch,
      providerPerMinute: { ...current.providerPerMinute, ...(patch.providerPerMinute ?? {}) },
    };
    await this.env.REGISTRY.put(CONFIG_KEY, JSON.stringify(next));
    return next;
  }

  /** Fixed-window counter in KV. Good enough for edge rate limiting without a sliding-log's cost. */
  private async take(key: string, limit: number, windowMs: number): Promise<{ ok: boolean; remaining: number; retryAfter: number }> {
    const row = (await this.env.REGISTRY.get<{ t: number; n: number }>(key, 'json')) ?? { t: Date.now(), n: 0 };
    const now = Date.now();
    if (now - row.t > windowMs) { row.t = now; row.n = 0; }
    const ok = row.n < limit;
    if (ok) row.n++;
    await this.env.REGISTRY.put(key, JSON.stringify(row), { expirationTtl: Math.ceil(windowMs / 1000) + 30 });
    return { ok, remaining: Math.max(0, limit - row.n), retryAfter: Math.max(1, Math.ceil((row.t + windowMs - now) / 1000)) };
  }

  async generalAllowed(ip: string) {
    const cfg = await this.getConfig();
    return this.take(`rl:general:${ip}`, cfg.generalPerMinutePerIP, 60_000);
  }

  /** Per-IP: stops one visitor from spamming the composer. */
  async chatAllowed(ip: string) {
    const cfg = await this.getConfig();
    const perMinute = await this.take(`rl:chat:min:${ip}`, cfg.chatPerMinutePerIP, 60_000);
    if (!perMinute.ok) return { ok: false, retryAfter: perMinute.retryAfter, reason: 'per_minute' as const };
    const perDay = await this.take(`rl:chat:day:${ip}`, cfg.chatPerDayPerIP, 86_400_000);
    if (!perDay.ok) return { ok: false, retryAfter: perDay.retryAfter, reason: 'per_day' as const };
    return { ok: true, retryAfter: 0, reason: null };
  }

  /**
   * Global, cross-visitor: the reason this exists at all. Every request to a
   * given provider — from every visitor combined — draws from the same
   * bucket, so the site can never collectively exceed what that provider's
   * free key allows, no matter how much traffic the site gets.
   */
  async providerAllowed(providerId: string) {
    const cfg = await this.getConfig();
    const limit = cfg.providerPerMinute[providerId] ?? cfg.providerPerMinuteDefault;
    const result = await this.take(`rl:provider:${providerId}`, limit, 60_000);
    return { ok: result.ok, retryAfter: result.retryAfter, limit };
  }

  async maxMessageChars(): Promise<number> {
    return (await this.getConfig()).maxMessageChars;
  }
}
