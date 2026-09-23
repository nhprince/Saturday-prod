/* ============================================================
   Saturday — admin API
   Every route here assumes the caller already passed
   verifyAdminToken; index.ts enforces that once, at the top.
   ============================================================ */
import { Env } from '../types';
import { Registry } from '../services/registry';
import { audit } from '../services/audit';
import { RateLimiter } from '../services/ratelimit';
import { verifyAdminPassword, setAdminPassword, hasCustomAdminPassword } from '../services/auth';

const json = (data: unknown, init: ResponseInit = {}) => Response.json(data, init);
const notFound = () => json({ error: 'not_found' }, { status: 404 });
const badRequest = (message: string) => json({ error: 'bad_request', message }, { status: 400 });

async function body<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

export async function handleAdmin(req: Request, env: Env, url: URL, registry: Registry, actorId: string): Promise<Response> {
  const parts = url.pathname.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean);
  const [section, id] = parts;
  const method = req.method;

  /* ---------------- system ---------------- */
  if (section === 'system') {
    if (parts[1] === 'status') {
      const [models, providers] = await Promise.all([registry.models(), registry.providerListWithConfig()]);
      let kvOk = true, d1Ok = true;
      try { await env.REGISTRY.get('admin:health-check-ping'); } catch { kvOk = false; }
      try { await env.DB.prepare('SELECT 1').first(); } catch { d1Ok = false; }
      const maintenance = (await env.REGISTRY.get('admin:maintenance', 'json')) ?? { enabled: false, message: '' };
      const rateLimits = await new RateLimiter(env).getConfig();
      return json({
        ok: kvOk && d1Ok,
        kv: kvOk, d1: d1Ok,
        providers, maintenance, rateLimits,
        customPasswordSet: await hasCustomAdminPassword(env),
        models: {
          total: models.length,
          available: models.filter((m) => m.status === 'available').length,
          degraded: models.filter((m) => m.status === 'degraded').length,
        },
        ts: Date.now(),
      });
    }
    if (parts[1] === 'maintenance') {
      if (method === 'GET') {
        return json((await env.REGISTRY.get('admin:maintenance', 'json')) ?? { enabled: false, message: '' });
      }
      if (method === 'PATCH') {
        const b = await body<{ enabled?: boolean; message?: string }>(req);
        if (!b) return badRequest('invalid JSON body');
        const current = ((await env.REGISTRY.get('admin:maintenance', 'json')) ?? { enabled: false, message: '' }) as any;
        const next = { enabled: b.enabled ?? current.enabled, message: b.message ?? current.message };
        await env.REGISTRY.put('admin:maintenance', JSON.stringify(next));
        await audit(env, actorId, 'system.maintenance', undefined, next);
        return json(next);
      }
    }
    return notFound();
  }

  /* ---------------- providers ---------------- */
  if (section === 'providers') {
    if (!id && method === 'GET') return json({ providers: await registry.providerListWithConfig() });
    if (id && method === 'PATCH') {
      const b = await body<{ enabled?: boolean; priority?: number; settings?: unknown }>(req);
      if (!b) return badRequest('invalid JSON body');
      await registry.setProviderConfig(id, b);
      await audit(env, actorId, 'provider.update', id, b);
      return json({ ok: true });
    }
    return notFound();
  }

  /* ---------------- custom (admin-added) providers ---------------- */
  if (section === 'custom-providers') {
    const mask = (key: string) => (key.length > 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : '••••••••');
    if (!id && method === 'GET') {
      const rows = await registry.listCustomProviders();
      return json({ providers: rows.map((r) => ({ ...r, api_key: mask(r.api_key) })) });
    }
    if (!id && method === 'POST') {
      const b = await body<{ name: string; baseUrl: string; apiKey: string; freeOnly?: boolean }>(req);
      if (!b?.name || !b?.baseUrl || !b?.apiKey) return badRequest('name, baseUrl and apiKey are required');
      if (!/^https:\/\//.test(b.baseUrl)) return badRequest('baseUrl must start with https://');
      const providerId = await registry.createCustomProvider(b);
      await audit(env, actorId, 'custom_provider.create', providerId, { name: b.name, baseUrl: b.baseUrl });
      return json({ id: providerId }, { status: 201 });
    }
    if (id && method === 'PATCH') {
      const b = await body<{ name?: string; baseUrl?: string; apiKey?: string; freeOnly?: boolean }>(req);
      if (!b) return badRequest('invalid JSON body');
      if (b.baseUrl && !/^https:\/\//.test(b.baseUrl)) return badRequest('baseUrl must start with https://');
      await registry.updateCustomProvider(id, b);
      await audit(env, actorId, 'custom_provider.update', id, { ...b, apiKey: b.apiKey ? '(changed)' : undefined });
      return json({ ok: true });
    }
    if (id && method === 'DELETE') {
      await registry.deleteCustomProvider(id);
      await audit(env, actorId, 'custom_provider.delete', id);
      return json({ ok: true });
    }
    return notFound();
  }

  /* ---------------- rate limits ---------------- */
  if (section === 'rate-limits') {
    const limiter = new RateLimiter(env);
    if (method === 'GET') return json(await limiter.getConfig());
    if (method === 'PATCH') {
      const b = await body<Record<string, unknown>>(req);
      if (!b) return badRequest('invalid JSON body');
      // Validate before storing: a non-numeric value here would turn every
      // comparison in the limiter into NaN and silently throttle the whole site.
      const numericKeys = ['generalPerMinutePerIP', 'chatPerMinutePerIP', 'chatPerDayPerIP', 'maxMessageChars', 'providerPerMinuteDefault'] as const;
      const patch: Record<string, unknown> = {};
      for (const k of numericKeys) {
        if (b[k] === undefined) continue;
        const n = Number(b[k]);
        if (!Number.isFinite(n) || n < 1) return badRequest(`${k} must be a positive number`);
        patch[k] = Math.floor(n);
      }
      if (b.providerPerMinute !== undefined) {
        if (typeof b.providerPerMinute !== 'object' || b.providerPerMinute === null || Array.isArray(b.providerPerMinute)) {
          return badRequest('providerPerMinute must be an object mapping provider ids to limits');
        }
        const ppm: Record<string, number> = {};
        for (const [pid, v] of Object.entries(b.providerPerMinute as Record<string, unknown>)) {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 1) return badRequest(`providerPerMinute.${pid} must be a positive number`);
          ppm[pid] = Math.floor(n);
        }
        patch.providerPerMinute = ppm;
      }
      if (!Object.keys(patch).length) return badRequest('nothing to update');
      const next = await limiter.setConfig(patch);
      await audit(env, actorId, 'rate_limits.update', undefined, patch);
      return json(next);
    }
    return notFound();
  }

  /* ---------------- admin password rotation ---------------- */
  if (section === 'change-password' && method === 'POST') {
    const b = await body<{ currentPassword: string; newPassword: string }>(req);
    if (!b?.currentPassword || !b?.newPassword) return badRequest('currentPassword and newPassword are required');
    if (b.newPassword.length < 8) return badRequest('newPassword must be at least 8 characters');
    const ok = await verifyAdminPassword(env, b.currentPassword);
    if (!ok) return json({ error: 'invalid_credentials', message: 'Current password is incorrect.' }, { status: 401 });
    await setAdminPassword(env, b.newPassword);
    await audit(env, actorId, 'admin.password_changed');
    return json({ ok: true });
  }
  if (section === 'password-status' && method === 'GET') {
    return json({ customPasswordSet: await hasCustomAdminPassword(env) });
  }

  /* ---------------- models ---------------- */
  if (section === 'models') {
    if (parts[1] === 'health-check' && method === 'POST') {
      const b = (await body<{ modelId?: string; force?: boolean }>(req)) ?? {};
      const models = await registry.models();
      const target = b.modelId ? models.filter((m) => m.id === b.modelId) : models;
      if (b.modelId && !target.length) return notFound();
      const result = await registry.healthService().sweep(
        target, (m) => registry.providerFor(m), { force: b.force, limit: b.modelId ? 1 : undefined });
      await audit(env, actorId, 'models.health_check', b.modelId ?? 'all', result);
      return json(result);
    }
    if (parts[1] === 'toggle' && method === 'POST') {
      const b = await body<{ modelId: string; disabled: boolean }>(req);
      if (!b?.modelId) return badRequest('modelId is required');
      await registry.setDisabled(b.modelId, b.disabled);
      await audit(env, actorId, b.disabled ? 'model.disable' : 'model.enable', b.modelId);
      return json({ ok: true });
    }
    return notFound();
  }

  /* ---------------- registry ---------------- */
  if (section === 'registry' && parts[1] === 'refresh' && method === 'POST') {
    const catalog = await registry.catalog(true);
    await audit(env, actorId, 'registry.refresh', undefined, { discovered: catalog.models.length });
    return json({ discovered: catalog.models.length, errors: catalog.errors });
  }

  /* ---------------- routing rules ---------------- */
  if (section === 'routing-rules') {
    if (!id && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM routing_rules ORDER BY position ASC').all();
      return json({ rules: results });
    }
    if (!id && method === 'POST') {
      const b = await body<{ name: string; matchSignal: string; preferTier?: string; preferModel?: string; position?: number }>(req);
      if (!b?.name || !b?.matchSignal) return badRequest('name and matchSignal are required');
      const ruleId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO routing_rules (id, name, match_signal, prefer_tier, prefer_model, enabled, position) VALUES (?1,?2,?3,?4,?5,1,?6)',
      ).bind(ruleId, b.name, b.matchSignal, b.preferTier ?? null, b.preferModel ?? null, b.position ?? 0).run();
      await audit(env, actorId, 'routing_rule.create', ruleId, b);
      return json({ id: ruleId }, { status: 201 });
    }
    if (id && method === 'PATCH') {
      const b = await body<Record<string, unknown>>(req);
      if (!b) return badRequest('invalid JSON body');
      const colMap: Record<string, string> = {
        name: 'name', matchSignal: 'match_signal', preferTier: 'prefer_tier',
        preferModel: 'prefer_model', enabled: 'enabled', position: 'position',
      };
      const cols = Object.keys(b).filter((k) => colMap[k]);
      if (!cols.length) return badRequest('nothing to update');
      const sql = `UPDATE routing_rules SET ${cols.map((k, i) => `${colMap[k]} = ?${i + 1}`).join(', ')} WHERE id = ?${cols.length + 1}`;
      await env.DB.prepare(sql).bind(...cols.map((k) => (k === 'enabled' ? (b[k] ? 1 : 0) : b[k])), id).run();
      await audit(env, actorId, 'routing_rule.update', id, b);
      return json({ ok: true });
    }
    if (id && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM routing_rules WHERE id = ?1').bind(id).run();
      await audit(env, actorId, 'routing_rule.delete', id);
      return json({ ok: true });
    }
    return notFound();
  }

  /* ---------------- CMS content ---------------- */
  if (section === 'cms') {
    if (!id && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM cms_content ORDER BY key ASC').all();
      return json({ content: results });
    }
    if (id && method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM cms_content WHERE key = ?1').bind(id).first();
      return row ? json(row) : notFound();
    }
    if (id && (method === 'PUT' || method === 'PATCH')) {
      const b = await body<{ value: unknown }>(req);
      if (b === null || b.value === undefined) return badRequest('value is required');
      await env.DB.prepare(
        `INSERT INTO cms_content (key, value, updated_at) VALUES (?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(id, JSON.stringify(b.value), Date.now()).run();
      await audit(env, actorId, 'cms.update', id);
      return json({ ok: true });
    }
    if (id && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM cms_content WHERE key = ?1').bind(id).run();
      await audit(env, actorId, 'cms.delete', id);
      return json({ ok: true });
    }
    return notFound();
  }

  /* ---------------- feature flags ---------------- */
  if (section === 'flags') {
    if (!id && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM feature_flags ORDER BY key ASC').all();
      return json({ flags: results });
    }
    if (id && (method === 'PUT' || method === 'PATCH')) {
      const b = await body<{ enabled?: boolean; rolloutPct?: number }>(req);
      if (!b) return badRequest('invalid JSON body');
      const existing = await env.DB.prepare('SELECT * FROM feature_flags WHERE key = ?1').bind(id).first<any>();
      const enabled = b.enabled ?? (existing ? !!existing.enabled : false);
      const rollout = b.rolloutPct ?? existing?.rollout_pct ?? 0;
      await env.DB.prepare(
        `INSERT INTO feature_flags (key, enabled, rollout_pct, updated_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, rollout_pct = excluded.rollout_pct, updated_at = excluded.updated_at`,
      ).bind(id, enabled ? 1 : 0, rollout, Date.now()).run();
      await audit(env, actorId, 'flag.update', id, { enabled, rollout });
      return json({ ok: true });
    }
    if (id && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM feature_flags WHERE key = ?1').bind(id).run();
      await audit(env, actorId, 'flag.delete', id);
      return json({ ok: true });
    }
    return notFound();
  }

  /* ---------------- users ---------------- */
  if (section === 'users') {
    if (!id && method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_seen_at,
                (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversation_count
           FROM users u ORDER BY u.last_seen_at DESC LIMIT 200`).all();
      return json({ users: results });
    }
    if (id && method === 'GET') {
      const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
      if (!user) return notFound();
      const { results: convs } = await env.DB.prepare(
        'SELECT id, title, updated_at, archived FROM conversations WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 50').bind(id).all();
      return json({ user, conversations: convs });
    }
    if (id && method === 'PATCH') {
      const b = await body<{ role?: string; status?: string; displayName?: string }>(req);
      if (!b) return badRequest('invalid JSON body');
      const cols: string[] = []; const vals: unknown[] = [];
      if (b.role) { cols.push('role'); vals.push(b.role); }
      if (b.status) { cols.push('status'); vals.push(b.status); }
      if (b.displayName !== undefined) { cols.push('display_name'); vals.push(b.displayName); }
      if (!cols.length) return badRequest('nothing to update');
      await env.DB.prepare(`UPDATE users SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(', ')} WHERE id = ?${cols.length + 1}`)
        .bind(...vals, id).run();
      await audit(env, actorId, 'user.update', id, b);
      return json({ ok: true });
    }
    if (id && method === 'DELETE') {
      const { results: convs } = await env.DB.prepare('SELECT id FROM conversations WHERE user_id = ?1').bind(id).all<{ id: string }>();
      const stmts = convs.map((c) => env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?1').bind(c.id));
      stmts.push(env.DB.prepare('DELETE FROM conversations WHERE user_id = ?1').bind(id));
      stmts.push(env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id));
      await env.DB.batch(stmts);
      await audit(env, actorId, 'user.delete', id);
      return json({ ok: true });
    }
    return notFound();
  }

  /* ---------------- conversations (cross-user moderation) ---------------- */
  if (section === 'conversations') {
    if (!id && method === 'GET') {
      const q = url.searchParams.get('q')?.trim();
      const userId = url.searchParams.get('userId');
      const clauses: string[] = []; const binds: unknown[] = [];
      if (q) { clauses.push(`(c.title LIKE ?${binds.length + 1})`); binds.push(`%${q}%`); }
      if (userId) { clauses.push(`c.user_id = ?${binds.length + 1}`); binds.push(userId); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.title, c.user_id, c.pinned, c.archived, c.updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
           FROM conversations c ${where} ORDER BY c.updated_at DESC LIMIT 100`,
      ).bind(...binds).all();
      return json({ conversations: results });
    }
    if (id && method === 'GET') {
      const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?1').bind(id).first();
      if (!conv) return notFound();
      const { results: messages } = await env.DB.prepare(
        'SELECT id, role, content, routing, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC').bind(id).all();
      return json({ conversation: conv, messages });
    }
    if (id && method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM conversations WHERE id = ?1').bind(id),
      ]);
      await audit(env, actorId, 'conversation.delete', id);
      return json({ ok: true });
    }
    return notFound();
  }

  /* ---------------- audit log ---------------- */
  if (section === 'audit') {
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));
    const action = url.searchParams.get('action');
    const { results } = action
      ? await env.DB.prepare('SELECT * FROM audit_log WHERE action = ?1 ORDER BY created_at DESC LIMIT ?2').bind(action, limit).all()
      : await env.DB.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?1').bind(limit).all();
    return json({ entries: results });
  }

  return notFound();
}
