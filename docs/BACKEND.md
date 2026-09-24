# The backend

`api/` is a single Cloudflare Worker. This document explains how its pieces fit together;
`docs/API_REFERENCE.md` lists every endpoint, and `docs/SECURITY.md` covers the rate-limiting
and auth model in depth.

```
api/src/
├── index.ts              entry point: CORS, rate limiting, maintenance mode, route dispatch
├── types.ts               shared types + the AIProvider interface every provider implements
├── providers/index.ts     NVIDIA NIM, Cloudflare AI, OpenRouter, and CustomProvider
├── services/
│   ├── registry.ts        discovery, normalization, catalogue cache, custom-provider CRUD
│   ├── health.ts          probing, TTL, exponential backoff, circuit breaking, probe budget
│   ├── router.ts          request classification, Free/Smart routing, admin rule matching
│   ├── ratelimit.ts        per-IP and global per-provider rate limiting
│   ├── auth.ts             admin bearer tokens, PBKDF2 password hashing/rotation
│   ├── audit.ts            one row per admin mutation
│   └── site.ts             structured branding/content defaults + assembly
└── api/
    ├── chat.ts             POST /api/chat and /api/chat/stream
    └── admin.ts            everything under /api/admin/*
```

## The provider abstraction

Every provider — built-in or custom — implements the same interface (`AIProvider` in
`types.ts`): `isConfigured()`, `listModels()`, `healthCheck()`, `generate()`, `stream()`.
NVIDIA NIM and OpenRouter both speak the OpenAI chat-completions dialect, so they share an
`OpenAICompatible` base class; Cloudflare AI gets its own implementation (it can use the native
Workers AI binding or the raw HTTP API); `CustomProvider` — anything an admin adds from the
panel — is just `OpenAICompatible` instantiated with a name, base URL, and key from the
database, which is why adding one gets discovery, health checking, generation, and streaming
for free, with zero new code.

Adding a genuinely new *kind* of provider (one that doesn't speak OpenAI's dialect) means
implementing the five interface methods once — see `CloudflareProvider` for the pattern — and
adding one line to `buildProviders()`. Nothing else in the system needs to change.

## Discovery and normalization

`Registry.catalog()` asks every provider for its model list, normalizes each into a common
`AIModel` shape (capabilities inferred from the model's name and metadata: vision, tools,
reasoning, JSON support; tier inferred from parameter-count hints in the name), and caches the
result in KV for an hour. **Entries that cannot hold a conversation are filtered out at this
point** — provider catalogues list guardrails, embedders, translators, OCR, image and music
generators alongside chat models; name hints (plus declared output modalities where the provider
publishes them) keep those out, so "available" can never describe a model that won't reply.
Provider-specific metadata survives on `.raw` in case anything needs it later. Custom providers
are loaded from D1 fresh on every `Registry` construction (once per request) and merged into the
same list — admin CRUD operations force an immediate re-discovery so a newly added provider's
models don't wait for the hourly cache to expire.

## Health

A model appearing in a provider's catalogue doesn't mean this account can actually call it.
Each model is probed with a cheap one-token completion and classified into one of nine states
(`WORKING`, `DEGRADED`, `RATE_LIMITED`, `AUTH_FAILED`, `NOT_FOUND`, `UNSUPPORTED`, `TIMEOUT`,
`ERROR`, `UNKNOWN`), which collapse to the four statuses the UI cares about (`available`,
`degraded`, `unavailable`, `unknown`). Auth and 404 failures cool down for 24 hours since they
won't fix themselves without a configuration change; other failures back off exponentially,
capped at an hour. A KV token bucket limits how many probes run in any 15-minute window for the
*cron* sweep — an explicit "health-check all" from the admin panel bypasses the budget but is
capped at 25 probes per pass (the panel loops passes, so a big catalogue finishes in a few
clicks' worth of patience, not one minutes-long request that "checks 0").
Real generations also feed this system (`health.observe()`), so most of the signal is free —
and a HTTP-200 reply with **zero generated characters counts as a failure**, not a success, so
a model that accepts the request but returns nothing falls back like any other error. Streams
get a 30s time-to-first-byte watchdog (cleared once bytes flow, so slow-but-working models are
never killed mid-answer) and non-streaming calls a 90s whole-request timeout.

## Routing

`RouterService.route()` classifies the request (see the signal list in `docs/FRONTEND.md` —
the server-side classifier mirrors the client-side one), filters the currently-available models
by the capabilities that classification implies, then:

- **Free Router** sorts by tier (cheapest first) and takes the top of the list.
- **Smart Router** first checks admin-authored routing rules (`routing_rules` in D1) — the
  first enabled rule whose signal matches and whose preferred model or tier is still eligible
  wins — then falls back to picking the model whose tier is closest to what the task needs.

Either way, the response includes a `RoutingDecision`: which model, why, and which alternatives
were considered — this is what powers the routing badge in the UI. If the first choice fails,
`api/chat.ts` walks the alternatives in order, re-announcing the routing decision each time,
and stops (rather than silently retrying) once tokens have actually reached the client.

## Rate limiting

Two independent layers — see `docs/SECURITY.md` for the full design rationale:

1. A **per-visitor** limit on the composer (messages per minute, messages per day, by IP).
2. A **global, cross-visitor** limit per provider — every request to, say, NVIDIA NIM draws
   from one shared 60-second counter no matter which visitor sent it, so the site's *combined*
   traffic can never exceed what that provider's free key allows.

Both are stored in KV, both are admin-configurable from the panel with no redeploy, and neither
touches the health-tracking system — a rate-limit hit isn't a sign the model is broken, so it
doesn't get treated like one.

## Admin surface

Every admin route requires a bearer token from `POST /api/admin/login`, verified with a pure
HMAC check (no session store — any Worker instance can verify a token statelessly). Every
mutation writes a row to `audit_log`. The admin password itself can be rotated from the panel:
a PBKDF2 hash in KV takes priority over the `ADMIN_PASSWORD` Worker secret once one is set, so
credentials can change without touching secrets or redeploying.

## Data model (D1)

`users`, `conversations`, `messages` — the product's own data, scoped by a per-device id sent
as `x-saturday-user` (there's no login for regular visitors; see `docs/SECURITY.md` for what
this does and doesn't mean for privacy). The chat endpoints stay stateless: persistence happens
through the conversation CRUD routes (`POST /api/conversations/:id/messages` upserts by
client-provided message id), which the shipped frontend calls after each finished exchange when
a backend is configured. `provider_config` and `custom_providers` — provider
enable/priority/credentials. `routing_rules`, `cms_content`, `feature_flags` — everything the
admin panel controls. `audit_log` — every admin action. Full schema in `api/schema.sql`, and
every statement in it is `IF NOT EXISTS`, so re-running it after an update is always safe.

One discovery nuance: the Cloudflare provider lists its catalogue through Cloudflare's REST
API when `CLOUDFLARE_API_KEY`/`CLOUDFLARE_ACCOUNT_ID` are set; in a binding-only deployment
(`[ai]` with no REST key) it falls back to a small static list of known Workers AI models and
lets health checks prove which ones run.
