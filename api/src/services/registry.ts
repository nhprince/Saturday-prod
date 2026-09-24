/* ============================================================
   Saturday — model registry
   Discovery → normalization → health merge → available set.
   The registry is the single source of truth the API exposes;
   nothing else in the system keeps its own model list.
   ============================================================ */
import { AIModel, AIProvider, Env, ModelHealth, ModelStatus } from '../types';
import { buildProviders, CustomProvider } from '../providers';
import { HealthService } from './health';

// v2: catalogues now exclude non-chat models at discovery — don't reuse v1 caches.
const CATALOG_KEY = 'registry:catalog:v2';
const CATALOG_TTL = 60 * 60; // provider catalogues change slowly

interface Catalog { discoveredAt: number; models: AIModel[]; errors: Record<string, string>; }

export interface ProviderConfigRow {
  provider_id: string;
  enabled: number;
  priority: number;
  settings: string | null;
  updated_at: number;
}

export interface RoutingRule {
  id: string;
  name: string;
  match_signal: string;
  prefer_tier: string | null;
  prefer_model: string | null;
  enabled: number;
  position: number;
}

export interface CustomProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  free_only: number;
  created_at: number;
  updated_at: number;
}

export class Registry {
  private staticProviders: AIProvider[];
  private providers: AIProvider[];
  private health: HealthService;
  /** Resolves once admin-added custom providers (from D1) have been merged into `providers`. */
  private readyPromise: Promise<void>;

  constructor(private env: Env) {
    this.staticProviders = buildProviders(env);
    this.providers = [...this.staticProviders];
    this.health = new HealthService(env);
    this.readyPromise = this.refreshCustomProviders();
  }

  private async loadCustomProviders(): Promise<AIProvider[]> {
    try {
      const { results } = await this.env.DB.prepare('SELECT * FROM custom_providers').all<CustomProviderRow>();
      return results.map((row) => new CustomProvider(row));
    } catch {
      // Table may not exist yet on a database that hasn't run the latest schema.sql — degrade, don't crash.
      return [];
    }
  }

  /** Re-reads custom providers from D1 and rebuilds the runtime provider list from scratch. */
  private async refreshCustomProviders(): Promise<void> {
    const custom = await this.loadCustomProviders();
    this.providers = [...this.staticProviders, ...custom];
  }

  async providerList() {
    await this.readyPromise;
    return this.providers.map((p) => ({ id: p.id, name: p.name, configured: p.isConfigured(), custom: p instanceof CustomProvider }));
  }

  /** Same list, but merged with admin enable/priority — what the admin panel renders. */
  async providerListWithConfig() {
    await this.readyPromise;
    const configs = await this.providerConfigs();
    return this.providers.map((p) => {
      const c = configs.get(p.id);
      return {
        id: p.id, name: p.name, configured: p.isConfigured(), custom: p instanceof CustomProvider,
        enabled: c ? !!c.enabled : true, priority: c?.priority ?? 100,
      };
    });
  }

  /** Provider list merged with admin-set enabled/priority, for the admin panel and for filtering. */
  async providerConfigs(): Promise<Map<string, ProviderConfigRow>> {
    const { results } = await this.env.DB.prepare('SELECT * FROM provider_config').all<ProviderConfigRow>();
    return new Map(results.map((r) => [r.provider_id, r]));
  }

  async setProviderConfig(id: string, patch: { enabled?: boolean; priority?: number; settings?: unknown }) {
    const now = Date.now();
    const existing = (await this.providerConfigs()).get(id);
    const enabled = patch.enabled ?? (existing ? !!existing.enabled : true);
    const priority = patch.priority ?? existing?.priority ?? 100;
    const settings = patch.settings !== undefined ? JSON.stringify(patch.settings) : existing?.settings ?? null;
    await this.env.DB.prepare(
      `INSERT INTO provider_config (provider_id, enabled, priority, settings, updated_at) VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(provider_id) DO UPDATE SET enabled=excluded.enabled, priority=excluded.priority, settings=excluded.settings, updated_at=excluded.updated_at`,
    ).bind(id, enabled ? 1 : 0, priority, settings, now).run();
  }

  async routingRules(): Promise<RoutingRule[]> {
    const { results } = await this.env.DB.prepare(
      'SELECT * FROM routing_rules WHERE enabled = 1 ORDER BY position ASC').all<RoutingRule>();
    return results;
  }

  /* ---- custom (admin-added) OpenAI-compatible providers ---- */
  async listCustomProviders(): Promise<CustomProviderRow[]> {
    const { results } = await this.env.DB.prepare('SELECT * FROM custom_providers ORDER BY created_at DESC').all<CustomProviderRow>();
    return results;
  }

  async createCustomProvider(input: { name: string; baseUrl: string; apiKey: string; freeOnly?: boolean }): Promise<string> {
    const id = 'custom-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const now = Date.now();
    await this.env.DB.prepare(
      'INSERT INTO custom_providers (id, name, base_url, api_key, free_only, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)',
    ).bind(id, input.name, input.baseUrl.replace(/\/+$/, ''), input.apiKey, input.freeOnly ? 1 : 0, now).run();
    await this.setProviderConfig(id, { enabled: true, priority: 100 });
    await this.refreshCustomProviders();
    await this.catalog(true); // so it appears immediately, not after the hourly cache expires
    return id;
  }

  async updateCustomProvider(id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; freeOnly?: boolean }) {
    const cols: string[] = []; const vals: unknown[] = [];
    if (patch.name !== undefined) { cols.push('name'); vals.push(patch.name); }
    if (patch.baseUrl !== undefined) { cols.push('base_url'); vals.push(patch.baseUrl.replace(/\/+$/, '')); }
    if (patch.apiKey !== undefined) { cols.push('api_key'); vals.push(patch.apiKey); }
    if (patch.freeOnly !== undefined) { cols.push('free_only'); vals.push(patch.freeOnly ? 1 : 0); }
    if (!cols.length) return;
    cols.push('updated_at'); vals.push(Date.now());
    await this.env.DB.prepare(
      `UPDATE custom_providers SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(', ')} WHERE id = ?${cols.length + 1}`,
    ).bind(...vals, id).run();
    await this.refreshCustomProviders();
    await this.catalog(true);
  }

  async deleteCustomProvider(id: string) {
    await this.env.DB.batch([
      this.env.DB.prepare('DELETE FROM custom_providers WHERE id = ?1').bind(id),
      this.env.DB.prepare('DELETE FROM provider_config WHERE provider_id = ?1').bind(id),
    ]);
    await this.refreshCustomProviders();
    await this.catalog(true);
  }

  /** Cached catalogue; `force` re-discovers from every configured provider. */
  async catalog(force = false): Promise<Catalog> {
    await this.readyPromise;
    if (!force) {
      const cached = await this.env.REGISTRY.get<Catalog>(CATALOG_KEY, 'json');
      if (cached) return cached;
    }
    const models: AIModel[] = [];
    const errors: Record<string, string> = {};
    const results = await Promise.allSettled(this.providers.map((p) => p.listModels()));
    results.forEach((r, i) => {
      const p = this.providers[i]!;
      if (r.status === 'fulfilled') models.push(...r.value);
      else errors[p.id] = (r.reason as Error)?.message ?? 'discovery failed';
    });
    // Stable order: provider priority, then small models first.
    const rank = { small: 0, medium: 1, large: 2 } as const;
    models.sort((a, b) =>
      this.providers.findIndex((p) => p.id === a.provider) - this.providers.findIndex((p) => p.id === b.provider) ||
      rank[a.tier] - rank[b.tier] || a.displayName.localeCompare(b.displayName));

    const catalog: Catalog = { discoveredAt: Date.now(), models, errors };
    await this.env.REGISTRY.put(CATALOG_KEY, JSON.stringify(catalog), { expirationTtl: CATALOG_TTL })
      .catch((e) => console.error('catalog cache write failed', (e as Error).message));
    return catalog;
  }

  /** Catalogue with live health merged in, and admin overrides applied. */
  async models(opts: { force?: boolean } = {}): Promise<AIModel[]> {
    const [{ models }, health, disabled, providerConfigs] = await Promise.all([
      this.catalog(opts.force),
      this.health.all(),
      this.disabledSet(),
      this.providerConfigs(),
    ]);
    const byId = new Map(health.map((h) => [h.modelId, h]));
    return models.map((m) => {
      const providerDisabled = providerConfigs.get(m.provider)?.enabled === 0;
      const h = byId.get(m.id);
      const status: ModelStatus = disabled.has(m.id) || providerDisabled ? 'unavailable' : h ? h.status : 'unknown';
      return {
        ...m, status, latencyMs: h?.latencyMs,
        lastCheckedAt: h ? new Date(h.checkedAt).toISOString() : undefined,
      };
    });
  }

  /** What the user-facing picker and the routers are allowed to choose from. */
  async available(): Promise<AIModel[]> {
    const models = await this.models();
    return models.filter((m) => m.status === 'available' || m.status === 'degraded');
  }

  async byId(id: string): Promise<AIModel | null> {
    return (await this.models()).find((m) => m.id === id) ?? null;
  }

  providerFor(model: AIModel): AIProvider | null {
    return this.providers.find((p) => p.id === model.provider) ?? null;
  }

  healthService() { return this.health; }

  /* ---- admin overrides: a broken model is disabled without a deploy ---- */
  private async disabledSet(): Promise<Set<string>> {
    const rows = await this.env.REGISTRY.get<string[]>('admin:disabled-models', 'json');
    return new Set(rows ?? []);
  }
  async setDisabled(modelId: string, disabled: boolean) {
    const set = await this.disabledSet();
    disabled ? set.add(modelId) : set.delete(modelId);
    await this.env.REGISTRY.put('admin:disabled-models', JSON.stringify([...set]));
  }

  async healthReport(): Promise<ModelHealth[]> { return this.health.all(); }
}
