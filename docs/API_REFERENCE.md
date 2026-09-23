# API reference

Base URL is wherever you deployed — e.g. `https://saturday.your-name.workers.dev` (the same
Worker also serves the site at `/` and the panel at `/admin/`). All bodies and responses are
JSON unless noted. Admin routes require `Authorization: Bearer <token>` from
`POST /api/admin/login`.

## Public

### `GET /api/health`
Liveness check. `{ ok: true, ts }`.

### `GET /api/providers`
`{ providers: [{ id, name, configured, custom }] }` — every provider (built-in and custom),
without health/priority detail.

### `GET /api/models`
`{ models: AIModel[] }` — the full catalogue with health merged in. `?refresh=1` forces
re-discovery from every provider instead of using the hourly cache.

### `GET /api/models/available`
Same shape, filtered to `status: "available" | "degraded"` — what the router actually picks from.

### `GET /api/models/health`
`{ health: ModelHealth[] }` — raw health records (state, latency, failure count, cooldown).

### `POST /api/chat`
Non-streaming completion.
```json
{ "messages": [{ "role": "user", "content": "..." }], "model": "smart" }
```
`model` is `"smart"`, `"free"`, or an exact model id (e.g. `"nvidia-nim:meta/llama-3.1-8b-instruct"`).
Returns `{ text, model, provider, routing }` or a 429/502/503 with `{ error, message }` on failure.

### `POST /api/chat/stream`
Same body. Server-Sent Events:
- `event: routing` — a `RoutingDecision`, sent before the first token and again on fallback
- `event: delta` — `{ delta }`, one chunk of text
- `event: done` — `{ modelId, latencyMs, chars }`
- `event: error` — `{ code, message, retryAfter? }` — `code` is one of `rate_limited`,
  `no_model`, `auth_failed`, `upstream_error`, `interrupted`, `message_too_long`

Rate-limited responses (both endpoints) return `429` with a `retry-after` header and
`{ error: "rate_limited", message, retryAfter }` before any provider is ever called.
Oversized requests return `413` with `{ error: "message_too_long" }`.

### Conversations — `GET/POST/PATCH/DELETE /api/conversations[/:id]`
Scoped by the `x-saturday-user` header (a per-device id the frontend generates itself — there's
no login). `POST` creates `{ title?, modelId? }` → `{ id }`. `PATCH` accepts any of `title`,
`pinned`, `archived`, `model_id`.

### `POST /api/conversations/:id/messages`
Appends messages to an owned conversation: `{ messages: [{ id?, role, content, routing?, createdAt? }] }`
→ `{ ok, count }`. Upserts by message id, so retries and regenerated answers converge instead of
duplicating rows. `routing` is stored as JSON and surfaces in the admin panel's transcript view.
The shipped chat app calls this automatically after each exchange when a backend is configured;
the chat endpoints themselves stay stateless and never read these rows.

### `GET /api/search?q=`
`{ results: [{ id, conversation_id, role, snippet, title }] }`, scoped the same way.

### `GET /api/cms?key=` or `GET /api/cms`
Raw custom-content rows (see `docs/ADMIN.md` → Custom content). With `?key=`, one row or
`{ key, value: null }` if unset; without it, `{ content: [...] }`.

### `GET /api/cms/site`
The structured branding/content config the frontend actually reads — always a complete object
with every field filled (defaults where an admin hasn't set something):
```json
{
  "branding": { "name", "tagline", "favicon", "mark" },
  "welcome": { "heading", "subheading", "suggestions": [] },
  "composer": { "placeholder" },
  "announcement": { "enabled", "text" }
}
```

### `GET /api/flags`
`{ flags: [{ key, enabled, rollout_pct }] }`.

## Admin

`POST /api/admin/login` — `{ password }` → `{ token, expiresIn }` (12-hour token). Rate-limited
harder than everything else. Returns `503` with `admin_not_configured` if neither
`ADMIN_PASSWORD` nor a rotated password nor `ADMIN_TOKEN_SECRET` is set up.

Every route below needs the bearer token from that response.

| Route | Body / query | Notes |
|---|---|---|
| `GET /api/admin/system/status` | — | Aggregate health, providers, model counts, maintenance, rate limits |
| `GET/PATCH /api/admin/system/maintenance` | `{ enabled?, message? }` | |
| `GET/PATCH /api/admin/providers[/:id]` | `{ enabled?, priority?, settings? }` | Covers built-in *and* custom providers |
| `GET/POST/PATCH/DELETE /api/admin/custom-providers[/:id]` | `{ name, baseUrl, apiKey, freeOnly? }` | `apiKey` optional on PATCH (keeps current); listing masks the key |
| `POST /api/admin/models/health-check` | `{ modelId?, force? }` | Omit `modelId` to sweep everything |
| `POST /api/admin/models/toggle` | `{ modelId, disabled }` | |
| `POST /api/admin/registry/refresh` | — | Re-discover every provider's catalogue now |
| `GET/POST/PATCH/DELETE /api/admin/routing-rules[/:id]` | `{ name, matchSignal, preferModel?, preferTier?, position? }` | |
| `GET/PATCH /api/admin/rate-limits` | see shape below | |
| `POST /api/admin/change-password` | `{ currentPassword, newPassword }` | `newPassword` ≥ 8 chars |
| `GET /api/admin/password-status` | — | `{ customPasswordSet }` |
| `GET/PATCH/DELETE /api/admin/users[/:id]` | `{ role?, status?, displayName? }` | Delete cascades to their conversations |
| `GET/DELETE /api/admin/conversations[/:id]` | `?q=&userId=` | Cross-user; `GET /:id` includes the full transcript |
| `GET/PUT/DELETE /api/admin/cms[/:key]` | `{ value }` | `PUT` upserts; keys starting with `site.` back the structured branding editor |
| `GET/PUT/DELETE /api/admin/flags[/:key]` | `{ enabled?, rolloutPct? }` | |
| `GET /api/admin/audit` | `?limit=&action=` | Most recent first |

**Rate-limit config shape** (`GET`/`PATCH /api/admin/rate-limits`):
```json
{
  "generalPerMinutePerIP": 60,
  "chatPerMinutePerIP": 12,
  "chatPerDayPerIP": 200,
  "maxMessageChars": 8000,
  "providerPerMinuteDefault": 20,
  "providerPerMinute": { "nvidia-nim": 30, "cloudflare": 60, "openrouter": 20 }
}
```
`PATCH` deep-merges `providerPerMinute`; everything else is a plain overwrite of the fields you send.

## Error shape

Every non-2xx response is `{ error: "<code>", message?: "<human-readable>" }`. A `401` with
`error: "unauthorized"` specifically means the bearer token is invalid/expired — that's the one
case worth handling specially (log the admin out and show the login screen again); any other
error code at 401 (like `invalid_credentials` from change-password) is just a normal,
recoverable failure and doesn't mean the session ended.

## Using it from your own frontend

`api/client/saturday-client.ts` wraps `/api/chat/stream`'s SSE parsing and the conversation CRUD
routes (including `addMessages`) into a small typed class — see its file header for a usage
example. The shipped `api/public/index.html` doesn't use this file (it talks to the API directly
to stay a single portable HTML file), but it's there if you're building something else against
the same backend.
