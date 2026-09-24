/* ============================================================
   Saturday — model health
   A provider listing a model does not mean this account can call
   it. Health is measured, cached, backed off and budgeted so the
   checks never eat the free quota they exist to protect.
   ============================================================ */
import { AIModel, AIProvider, Env, HealthState, ModelHealth, ModelStatus } from '../types';

const KEY = (id: string) => `health:${id}`;
const INDEX_KEY = 'health:index';
const BUDGET_KEY = 'health:budget';

const STATUS_OF: Record<HealthState, ModelStatus> = {
  WORKING: 'available',
  DEGRADED: 'degraded',
  RATE_LIMITED: 'degraded',
  TIMEOUT: 'degraded',
  ERROR: 'degraded',
  AUTH_FAILED: 'unavailable',
  NOT_FOUND: 'unavailable',
  UNSUPPORTED: 'unavailable',
  UNKNOWN: 'unknown',
};

/** Failures that mean "never retry until configuration changes". */
const HARD = new Set<HealthState>(['AUTH_FAILED', 'NOT_FOUND', 'UNSUPPORTED']);

/** Base cooldown per state, doubled per consecutive failure, capped at 1h. */
const BASE_COOLDOWN: Partial<Record<HealthState, number>> = {
  RATE_LIMITED: 5 * 60_000,
  TIMEOUT: 60_000,
  ERROR: 60_000,
  DEGRADED: 30_000,
};

export class HealthService {
  private ttl: number;
  private budget: number;

  constructor(private env: Env) {
    this.ttl = Number(env.HEALTH_TTL_SECONDS ?? 900) * 1000;
    this.budget = Number(env.HEALTH_PROBE_BUDGET ?? 12);
  }

  async get(modelId: string): Promise<ModelHealth | null> {
    return this.env.REGISTRY.get<ModelHealth>(KEY(modelId), 'json');
  }

  async all(): Promise<ModelHealth[]> {
    const index = (await this.env.REGISTRY.get<string[]>(INDEX_KEY, 'json')) ?? [];
    const rows = await Promise.all(index.map((id) => this.get(id)));
    return rows.filter((r): r is ModelHealth => !!r);
  }

  /** True when a model may be used right now. */
  usable(h: ModelHealth | null): boolean {
    if (!h) return false;
    if (h.status === 'unavailable') return false;
    if (h.cooldownUntil > Date.now()) return false;
    return true;
  }

  fresh(h: ModelHealth | null): boolean {
    return !!h && Date.now() - h.checkedAt < this.ttl;
  }

  /** Record the outcome of a real generation — free health signal, no extra request. */
  async observe(modelId: string, ok: boolean, latencyMs: number, state: HealthState = 'ERROR', message?: string) {
    const prev = await this.get(modelId);
    const failures = ok ? 0 : (prev?.failures ?? 0) + 1;
    const effective: HealthState = ok ? 'WORKING' : state;
    const base = BASE_COOLDOWN[effective] ?? 0;
    const cooldownUntil = ok ? 0
      : HARD.has(effective) ? Date.now() + 24 * 60 * 60_000
      : base ? Date.now() + Math.min(base * 2 ** (failures - 1), 60 * 60_000) : 0;

    const record: ModelHealth = {
      modelId,
      state: effective,
      status: STATUS_OF[effective],
      latencyMs: ok ? (prev?.latencyMs ? Math.round(prev.latencyMs * 0.6 + latencyMs * 0.4) : latencyMs) : prev?.latencyMs,
      checkedAt: Date.now(),
      failures,
      cooldownUntil,
      message: ok ? undefined : message?.slice(0, 200),
    };
    await this.write(record);
    return record;
  }

  private async write(record: ModelHealth) {
    try {
      await this.env.REGISTRY.put(KEY(record.modelId), JSON.stringify(record));
      const index = (await this.env.REGISTRY.get<string[]>(INDEX_KEY, 'json')) ?? [];
      if (!index.includes(record.modelId)) {
        index.push(record.modelId);
        await this.env.REGISTRY.put(INDEX_KEY, JSON.stringify(index));
      }
    } catch (e) {
      // Health bookkeeping must never break the request it was observing.
      console.error('health record write failed', (e as Error).message);
    }
  }

  /** One deliberate probe. Skips anything still fresh or still cooling down. */
  async probe(model: AIModel, provider: AIProvider, force = false): Promise<ModelHealth> {
    const prev = await this.get(model.id);
    if (!force && this.fresh(prev) && prev) return prev;
    if (!force && prev && prev.cooldownUntil > Date.now()) return prev;

    const { state, latencyMs, message } = await provider.healthCheck(model);
    return this.observe(model.id, state === 'WORKING', latencyMs, state, message);
  }

  /**
   * Sweep a slice of the catalogue. Bounded three ways: a per-window probe
   * budget, a concurrency limit, and the freshness/cooldown skip above.
   * Called from the cron trigger and from the admin panel — never from a
   * user request path.
   */
  async sweep(models: AIModel[], providerOf: (m: AIModel) => AIProvider | null, opts: { force?: boolean; limit?: number } = {}) {
    const budget = await this.takeBudget(opts.limit ?? this.budget);
    if (budget <= 0) return { checked: 0, skipped: models.length, reason: 'budget exhausted' };

    // Oldest-checked first, so attention spreads evenly across the catalogue.
    const withHealth = await Promise.all(models.map(async (m) => ({ m, h: await this.get(m.id) })));
    const queue = withHealth
      .filter(({ h }) => opts.force || (!this.fresh(h) && (h?.cooldownUntil ?? 0) <= Date.now()))
      .sort((a, b) => (a.h?.checkedAt ?? 0) - (b.h?.checkedAt ?? 0))
      .slice(0, budget);

    let checked = 0;
    const CONCURRENCY = 4;
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const batch = queue.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ({ m }) => {
        const p = providerOf(m);
        if (!p) return;
        try { await this.probe(m, p, opts.force); checked++; } catch { /* recorded as a failure by probe */ }
      }));
    }
    return { checked, skipped: models.length - checked };
  }

  /** Simple token bucket in KV so parallel workers cannot overspend the quota.
      Fail-open like the rate limiter: a storage fault stalls probing, not the site. */
  private async takeBudget(want: number): Promise<number> {
    try {
      const now = Date.now();
      const row = (await this.env.REGISTRY.get<{ window: number; used: number }>(BUDGET_KEY, 'json')) ?? { window: now, used: 0 };
      const WINDOW = 15 * 60_000;
      if (now - row.window > WINDOW) { row.window = now; row.used = 0; }
      const remaining = Math.max(0, this.budget - row.used);
      const grant = Math.min(want, remaining);
      row.used += grant;
      await this.env.REGISTRY.put(BUDGET_KEY, JSON.stringify(row), { expirationTtl: 3600 });
      return grant;
    } catch (e) {
      console.error('probe budget store fault — granting request', (e as Error).message);
      return want;
    }
  }
}
