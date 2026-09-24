/* ============================================================
   Saturday API — Cloudflare Worker entry point
   The browser talks only to this. Provider secrets never leave it.
   ============================================================ */
import { Env } from './types';
import { Registry } from './services/registry';
import { handleChat, handleChatStream } from './api/chat';
import { handleAdmin } from './api/admin';
import { signAdminToken, verifyAdminToken, verifyAdminPassword, hasCustomAdminPassword } from './services/auth';
import { audit } from './services/audit';
import { RateLimiter } from './services/ratelimit';
import { assembleSiteConfig } from './services/site';

/* ---------------- helpers ---------------- */
const json = (data: unknown, init: ResponseInit = {}) => Response.json(data, init);

function corsHeaders(req: Request, env: Env) {
  const origin = req.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim());
  const ok = allowed.includes(origin) || allowed.includes('*');
  return {
    'access-control-allow-origin': ok ? origin : allowed[0] ?? '',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-saturday-user',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

/** Sliding window per key, so login attempts can be throttled harder than everything else.
    Fail-open: a storage fault must never lock the admin out of their own panel. */
async function rateLimit(env: Env, keyPart: string, limit: number, windowMs: number): Promise<boolean> {
  try {
    const key = `rl:${keyPart}`;
    const row = (await env.REGISTRY.get<{ t: number; n: number }>(key, 'json')) ?? { t: Date.now(), n: 0 };
    if (Date.now() - row.t > windowMs) { row.t = Date.now(); row.n = 0; }
    row.n++;
    await env.REGISTRY.put(key, JSON.stringify(row), { expirationTtl: Math.ceil(windowMs / 1000) + 30 });
    return row.n <= limit;
  } catch (e) {
    console.error('rate-limit store fault — allowing request', (e as Error).message);
    return true;
  }
}
const ipOf = (req: Request) => req.headers.get('cf-connecting-ip') ?? 'anon';

/** Creates the user row on first contact and refreshes last_seen_at otherwise. */
async function touchUser(env: Env, userId: string) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, role, status, created_at, last_seen_at) VALUES (?1,?1,'user','active',?2,?2)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).bind(userId, now).run();
}

/* ---------------- conversations (D1) ---------------- */
async function conversations(req: Request, env: Env, url: URL): Promise<Response> {
  const userId = req.headers.get('x-saturday-user') ?? 'local';
  const id = url.pathname.split('/')[3];
  const sub = url.pathname.split('/')[4];

  if (req.method === 'GET' && !id) {
    const { results } = await env.DB.prepare(
      'SELECT id, title, pinned, archived, model_id, created_at, updated_at FROM conversations WHERE user_id = ?1 ORDER BY pinned DESC, updated_at DESC LIMIT 200',
    ).bind(userId).all();
    return json({ conversations: results });
  }

  if (req.method === 'GET' && id) {
    const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
    if (!conv) return json({ error: 'not_found' }, { status: 404 });
    const { results } = await env.DB.prepare(
      'SELECT id, role, content, routing, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC',
    ).bind(id).all();
    return json({ conversation: conv, messages: results });
  }

  if (req.method === 'POST' && !id) {
    const body = (await req.json().catch(() => ({}))) as { title?: string; modelId?: string };
    await touchUser(env, userId);
    const newId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO conversations (id, user_id, title, model_id, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)',
    ).bind(newId, userId, body.title ?? 'New chat', body.modelId ?? 'smart', now).run();
    return json({ id: newId }, { status: 201 });
  }

  if (req.method === 'PATCH' && id && !sub) {
    const body = (await req.json()) as Record<string, unknown>;
    const allowed = ['title', 'pinned', 'archived', 'model_id'] as const;
    const sets = allowed.filter((k) => k in body);
    if (!sets.length) return json({ error: 'nothing_to_update' }, { status: 400 });
    const sql = `UPDATE conversations SET ${sets.map((k, i) => `${k} = ?${i + 1}`).join(', ')}, updated_at = ?${sets.length + 1} WHERE id = ?${sets.length + 2} AND user_id = ?${sets.length + 3}`;
    await env.DB.prepare(sql).bind(...sets.map((k) => body[k]), Date.now(), id, userId).run();
    await touchUser(env, userId);
    return json({ ok: true });
  }

  /* Append messages to an owned conversation. Upserts by client-provided id so
     retries and regenerate calls converge instead of duplicating rows. */
  if (req.method === 'POST' && id && sub === 'messages') {
    const conv = await env.DB.prepare('SELECT user_id FROM conversations WHERE id = ?1').bind(id).first<{ user_id: string }>();
    if (!conv || conv.user_id !== userId) return json({ error: 'not_found' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string; role?: string; content?: string; routing?: unknown; createdAt?: number }>;
    };
    const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(0, 50)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0);
    if (!msgs.length) return json({ error: 'bad_request', message: 'messages must contain at least one { role, content } entry' }, { status: 400 });
    const now = Date.now();
    const stmts = msgs.map((m) => env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, routing, created_at) VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, routing = excluded.routing`,
    ).bind(
      m.id ?? crypto.randomUUID(), id, m.role!,
      m.content!.slice(0, 100_000),
      m.routing !== undefined ? JSON.stringify(m.routing).slice(0, 4000) : null,
      m.createdAt ?? now,
    ));
    stmts.push(env.DB.prepare('UPDATE conversations SET updated_at = ?1 WHERE id = ?2').bind(now, id));
    await env.DB.batch(stmts);
    await touchUser(env, userId);
    return json({ ok: true, count: msgs.length }, { status: 201 });
  }

  if (req.method === 'DELETE' && id && !sub) {
    // Ownership gate comes first: messages must never be deleted for a
    // conversation the caller does not own.
    const conv = await env.DB.prepare('SELECT user_id FROM conversations WHERE id = ?1').bind(id).first<{ user_id: string }>();
    if (!conv || conv.user_id !== userId) return json({ error: 'not_found' }, { status: 404 });
    await env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?1').bind(id),
      env.DB.prepare('DELETE FROM conversations WHERE id = ?1').bind(id),
    ]);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, { status: 405 });
}

/* ---------------- worker ---------------- */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const respond = (r: Response) => {
      const headers = new Headers(r.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(r.body, { status: r.status, headers });
    };

    const p = url.pathname;

    /* ---- admin login: public, rate-limited harder than everything else ---- */
    if (p === '/api/admin/login' && req.method === 'POST') {
      if (!(await rateLimit(env, `login:${ipOf(req)}`, 8, 60_000))) {
        return respond(json({ error: 'rate_limited' }, { status: 429 }));
      }
      if (!env.ADMIN_TOKEN_SECRET) {
        return respond(json({ error: 'admin_not_configured', message: 'Set ADMIN_TOKEN_SECRET to enable the admin panel.' }, { status: 503 }));
      }
      if (!env.ADMIN_PASSWORD && !(await hasCustomAdminPassword(env))) {
        return respond(json({ error: 'admin_not_configured', message: 'Set ADMIN_PASSWORD to enable the admin panel.' }, { status: 503 }));
      }
      const { password } = (await req.json().catch(() => ({}))) as { password?: string };
      if (!password || !(await verifyAdminPassword(env, password))) {
        await audit(env, ipOf(req), 'admin.login_failed');
        return respond(json({ error: 'invalid_credentials' }, { status: 401 }));
      }
      const token = await signAdminToken(env);
      await audit(env, 'admin', 'admin.login');
      return respond(json({ token, expiresIn: 12 * 60 * 60 }));
    }

    // General per-IP limit, admin-tunable — covers every route except the ones below it.
    const limiter = new RateLimiter(env);
    const general = await limiter.generalAllowed(ipOf(req));
    if (!general.ok) {
      return respond(json({ error: 'rate_limited', message: 'Too many requests.' }, { status: 429, headers: { 'retry-after': String(general.retryAfter) } }));
    }

    /* ---- maintenance mode: everything but health and admin routes is paused ---- */
    if (!p.startsWith('/api/admin') && p !== '/api/health') {
      const maintenance = (await env.REGISTRY.get('admin:maintenance', 'json').catch(() => null)) as { enabled?: boolean; message?: string } | null;
      if (maintenance?.enabled) {
        return respond(json({ error: 'maintenance', message: maintenance.message || 'Saturday is briefly offline for maintenance.' }, { status: 503 }));
      }
    }

    const registry = new Registry(env);

    try {
      /* ---- public ---- */
      if (p === '/api/health') return respond(json({ ok: true, ts: Date.now() }));
      if (p === '/api/providers') return respond(json({ providers: await registry.providerList() }));

      if (p === '/api/models') {
        const force = url.searchParams.get('refresh') === '1';
        return respond(json({ models: await registry.models({ force }) }));
      }
      if (p === '/api/models/available') return respond(json({ models: await registry.available() }));
      if (p === '/api/models/health') return respond(json({ health: await registry.healthReport() }));

      /* ---- chat: a second, tighter, AI-specific limit on top of the general one.
         This is what keeps a public, login-free site from ever burning through a
         provider's quota — per-visitor here, and per-provider globally inside
         handleChat/handleChatStream itself. ---- */
      if ((p === '/api/chat' || p === '/api/chat/stream') && req.method === 'POST') {
        const gate = await limiter.chatAllowed(ipOf(req));
        if (!gate.ok) {
          const message = gate.reason === 'per_day'
            ? "You've reached today's message limit for this deployment. Please try again tomorrow."
            : "You're sending messages a little fast — please slow down for a moment.";
          return respond(json({ error: 'rate_limited', message, retryAfter: gate.retryAfter },
            { status: 429, headers: { 'retry-after': String(gate.retryAfter) } }));
        }
      }
      if (p === '/api/chat' && req.method === 'POST') return respond(await handleChat(req, env));
      if (p === '/api/chat/stream' && req.method === 'POST') return respond(await handleChatStream(req, env));

      if (p.startsWith('/api/conversations')) return respond(await conversations(req, env, url));

      if (p === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q')?.trim();
        const userId = req.headers.get('x-saturday-user') ?? 'local';
        if (!q) return respond(json({ results: [] }));
        const { results } = await env.DB.prepare(
          `SELECT m.id, m.conversation_id, m.role, substr(m.content, 1, 240) AS snippet, c.title
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE c.user_id = ?1 AND m.content LIKE ?2 ORDER BY m.created_at DESC LIMIT 40`,
        ).bind(userId, `%${q}%`).all();
        return respond(json({ results }));
      }

      /* ---- CMS + flags are readable by any client, so the frontend can render them ---- */
      if (p === '/api/cms/site' && req.method === 'GET') {
        return respond(json(await assembleSiteConfig(env)));
      }
      if (p === '/api/cms' && req.method === 'GET') {
        const key = url.searchParams.get('key');
        if (key) {
          const row = await env.DB.prepare('SELECT * FROM cms_content WHERE key = ?1').bind(key).first();
          return respond(json(row ?? { key, value: null }));
        }
        const { results } = await env.DB.prepare('SELECT * FROM cms_content').all();
        return respond(json({ content: results }));
      }
      if (p === '/api/flags' && req.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT key, enabled, rollout_pct FROM feature_flags').all();
        return respond(json({ flags: results }));
      }

      /* ---- admin: one auth check, then dispatch ---- */
      if (p.startsWith('/api/admin')) {
        if (!(await rateLimit(env, `admin:${ipOf(req)}`, 120, 60_000))) {
          return respond(json({ error: 'rate_limited' }, { status: 429 }));
        }
        const authz = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
        const payload = await verifyAdminToken(env, authz);
        if (!payload) return respond(json({ error: 'unauthorized' }, { status: 401 }));
        return respond(await handleAdmin(req, env, url, registry, payload.sub));
      }

      return respond(json({ error: 'not_found' }, { status: 404 }));
    } catch (e) {
      // Never leak provider internals to the browser; keep the detail in the log.
      console.error('saturday-api', (e as Error).stack ?? e);
      return respond(json({ error: 'internal_error', message: 'Something went wrong on our side.' }, { status: 500 }));
    }
  },

  /** Cron: refresh the catalogue, then sweep a budgeted slice of it. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const registry = new Registry(env);
      await registry.catalog(true);
      const models = await registry.models();
      await registry.healthService().sweep(models, (m) => registry.providerFor(m));
    })());
  },
};
