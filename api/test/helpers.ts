/* Shared fakes: an in-memory KV namespace and a tiny D1 stub that can answer
   the exact queries the services under test issue. TTLs are ignored — window
   behaviour is tested by faking the clock instead. */
import { Env } from '../src/types';

export function fakeKV() {
  const store = new Map<string, string>();
  const kv = {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
  };
  return kv as unknown as KVNamespace & { store: Map<string, string> };
}

export function fakeD1(rows: Array<{ key: string; value: string }> = []) {
  return {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => this,
        all: async () => ({ results: sql.includes('cms_content') ? rows : [] }),
        first: async <T>() => null as T | null,
        run: async () => ({}),
      };
    },
    batch: async () => [],
  } as unknown as D1Database;
}

export function fakeEnv(overrides: Record<string, unknown> = {}) {
  return {
    REGISTRY: fakeKV(),
    DB: fakeD1(),
    ALLOWED_ORIGINS: '',
    HEALTH_TTL_SECONDS: '900',
    HEALTH_PROBE_BUDGET: '12',
    ADMIN_TOKEN_SECRET: 'test-secret-that-is-long-enough-0123456789',
    ADMIN_PASSWORD: 'correct horse battery staple',
    ...overrides,
  } as unknown as Env;
}
