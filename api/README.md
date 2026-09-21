# Saturday API

The server half of Saturday: a multi-provider AI API on Cloudflare Workers, with a full admin
surface behind it. This is a quick reference — see `../docs/BACKEND.md` and
`../docs/API_REFERENCE.md` in the project root for the full picture.

```
Saturday frontend            Saturday admin panel
      │  fetch /api/*              │  fetch /api/admin/* (bearer token)
      ▼                            ▼
            Saturday API (Worker)
      │
      ├─ Registry ──── discovery · normalization · KV catalogue · provider on/off · custom providers
      ├─ Health ────── probes · TTL · backoff · circuit breaker · budget
      ├─ Router ────── classification · Free Router · Smart Router · admin rules · fallback
      ├─ RateLimiter ── per-IP chat limits · global per-provider limits, all admin-tunable
      └─ Auth ──────── HMAC admin tokens · PBKDF2 password rotation · audit log
                            │
              NVIDIA NIM · Cloudflare AI · OpenRouter · any admin-added custom provider
```

## Deploy

See `../docs/DEPLOYMENT.md` for the full walkthrough (including the Cloudflare Pages proxy
trick for a same-origin, zero-config setup). Short version:

```bash
npm install
npx wrangler kv namespace create REGISTRY      # paste the id into wrangler.toml
npx wrangler d1 create saturday                # paste the id into wrangler.toml
npx wrangler d1 execute saturday --file=schema.sql --remote

npx wrangler secret put NVIDIA_NIM_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put CLOUDFLARE_API_KEY
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put ADMIN_TOKEN_SECRET      # long random string — signs admin sessions
npx wrangler secret put ADMIN_PASSWORD          # the admin panel's login password

npm run deploy
```

A provider with no key is simply absent from `buildProviders()` — never listed, never routed
to, never reported as available. `schema.sql` is fully idempotent (`CREATE TABLE IF NOT EXISTS`
throughout) — safe to re-run after pulling an update that adds a table.

## Endpoints

Full reference with request/response shapes: `../docs/API_REFERENCE.md`. Summary:

**Public:** `/api/health`, `/api/providers`, `/api/models[/available|/health]`,
`/api/chat[/stream]`, `/api/conversations[/:id]`, `/api/search`, `/api/cms[/:key]`,
`/api/cms/site`, `/api/flags`.

**Admin** (bearer token from `POST /api/admin/login`): `/api/admin/system/status`,
`/api/admin/system/maintenance`, `/api/admin/providers[/:id]`,
`/api/admin/custom-providers[/:id]`, `/api/admin/models/health-check`,
`/api/admin/models/toggle`, `/api/admin/registry/refresh`, `/api/admin/routing-rules[/:id]`,
`/api/admin/rate-limits`, `/api/admin/change-password`, `/api/admin/password-status`,
`/api/admin/users[/:id]`, `/api/admin/conversations[/:id]`, `/api/admin/cms[/:key]`,
`/api/admin/flags[/:key]`, `/api/admin/audit`.

## How the pieces work

Discovery, health checking, routing, rate limiting, and the admin/auth model are each explained
in depth in `../docs/BACKEND.md` and `../docs/SECURITY.md` — including the design reasoning
behind decisions like keeping rate-limit hits out of the health-tracking system, and why a
`401` from the bearer-token check is distinguished from other business-logic 401s.

## Wiring a frontend of your own

`client/saturday-client.ts` wraps the SSE streaming and conversation CRUD into a small typed
class, if you're building something other than the shipped `frontend/index.html` against this
same backend. See its file header for a usage example.

## Status

Provider abstraction, dynamic discovery, health checking with caching/backoff/circuit-breaking,
Free and Smart routing with admin-authored rules, two-layer rate limiting, streaming chat,
conversation CRUD, search, custom provider management, a structured CMS, feature flags,
maintenance mode, admin password rotation, and a full audit log — all built, all tested.

Open for extension: real end-user authentication (see `../docs/SECURITY.md` for what the
current per-device id does and doesn't provide), and R2-backed attachment storage with
server-side text extraction.
