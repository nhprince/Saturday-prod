# Saturday — project overview

Saturday is a complete, self-hostable AI chatbot: a chat app, an admin panel, and the
multi-provider API behind both. This document is the map; the other files in `docs/` go deep
on each piece.

```
saturday/
├── README.md                  quickstart
├── docs/                      you are here
│   ├── OVERVIEW.md
│   ├── FRONTEND.md
│   ├── BACKEND.md
│   ├── ADMIN.md
│   ├── API_REFERENCE.md
│   ├── SECURITY.md
│   └── DEPLOYMENT.md
├── frontend/index.html        the chat app — one file, no build step
├── admin/index.html           the admin panel — one file, no build step
└── api/                       Cloudflare Worker: providers, routing, health, rate limiting, admin API
    ├── src/
    ├── schema.sql
    ├── wrangler.toml
    └── client/saturday-client.ts
```

## The three pieces, in one paragraph each

**The frontend** (`frontend/index.html`) is a single self-contained HTML file — no build tool,
no framework, no dependencies beyond two Google Fonts. It runs two ways depending on where it's
opened: inside Claude.ai (or any Claude Artifact host), it talks to Claude directly through the
artifact's built-in model-sampling capability, so it works with zero configuration and zero
cost. Opened anywhere else — a plain browser tab, a Cloudflare Pages deployment — it can
instead (or additionally) talk to your own deployed API, which is how it gets its own provider
keys, persistent storage, and admin-controlled branding. See `docs/FRONTEND.md`.

**The admin panel** (`admin/index.html`) is a second, equally dependency-free file: a real
dashboard over the API's admin endpoints. Providers, models, routing rules, rate limits, users,
conversations, site branding and content, feature flags, an audit log, and maintenance mode —
all of it live, all of it backed by a real endpoint, none of it decorative. See `docs/ADMIN.md`.

**The API** (`api/`) is a Cloudflare Worker. It normalizes multiple AI providers behind one
interface, health-checks them, routes requests between them (a cheap/fast "Free Router" and a
task-aware "Smart Router"), rate-limits aggressively enough to survive being fully public with
no login wall, and exposes everything the admin panel needs to control the product without a
redeploy. See `docs/BACKEND.md` and `docs/API_REFERENCE.md`.

## Design principles that show up everywhere in the code

- **A provider that isn't configured doesn't exist.** No provider is ever listed, routed to, or
  reported as available unless its credentials are actually present and it actually responded
  to a health check. This applies identically to the three built-in providers and to any custom
  one an admin adds.
- **Nothing here reports success it didn't earn.** The routing badge in the chat UI shows the
  model that *actually* answered, not the one that was asked for; a fallback re-announces itself
  rather than silently swapping models; health status comes from real probes and real
  generations, never assumptions.
- **The admin panel can change anything without a deploy.** Branding, copy, favicon, routing
  rules, rate limits, provider credentials, feature flags, maintenance mode, even the admin
  password — all of it is data in KV/D1, read fresh on every relevant request, never baked into
  the deployed code.
- **Public and login-free doesn't mean unprotected.** See `docs/SECURITY.md` for the two-layer
  rate limiting that keeps a busy, anonymous, public site from ever exceeding what a free
  provider key allows — the specific concern that shaped a lot of the backend's design.

## Where to go next

- Deploying for the first time → `docs/DEPLOYMENT.md`
- Understanding what the admin panel can actually do → `docs/ADMIN.md`
- Calling the API from your own code → `docs/API_REFERENCE.md`
- How routing/health/rate-limiting actually work → `docs/BACKEND.md`
- What's configurable in the chat app itself → `docs/FRONTEND.md`
