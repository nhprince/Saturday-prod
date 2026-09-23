# Saturday

A premium AI chatbot: calm, editorial, quietly powerful — with a real admin panel and a
production-grade backend behind it. This is the complete, ready-to-run project.

```
saturday/
├── docs/                    detailed documentation — start with docs/OVERVIEW.md
└── api/                     one Cloudflare Worker = the whole product
    ├── public/index.html        the chat app at / — one self-contained file, no build step
    ├── public/admin/index.html  the admin panel at /admin/ — also one file, no build step
    └── src/                     the API at /api/* — providers, routing, health, rate limiting
```

**New here?** → `docs/DEPLOYMENT.md` gets you live on Cloudflare's free tier in about 15 minutes —
one Worker, one Git-connected deploy, and **no card required** (KV and D1 are free-plan products;
only R2 would need a payment method, and Saturday doesn't use it).
**Want the full picture first?** → `docs/OVERVIEW.md`.

## Two ways to run the chat app

**1. Zero setup, inside Claude.** Open a copy of `api/public/index.html` as a Claude.ai artifact
and it runs immediately — Free Router and Smart Router use Claude itself as the model, through
the artifact's built-in `sample` capability. No deploy, no keys, no backend.

**2. Self-hosted, with your own provider keys, fully public.** Deploy to Cloudflare (see
`docs/DEPLOYMENT.md`) and a single Worker serves the chat app at `/`, the admin panel at
`/admin/`, and the API at `/api/*` — same origin, so there is no CORS to configure and no Pages
project to babysit. The app discovers NVIDIA NIM, Cloudflare AI, OpenRouter, and any custom
providers you've added, and routes between them automatically. This path is built to run
publicly with no login wall: see `docs/SECURITY.md` for the two-layer rate limiting that keeps
combined visitor traffic from ever exceeding what a free provider key allows.

Both paths can be active at once, and it's the same file either way — nothing about it is
Claude.ai-specific except the one capability it tries first.

## What's actually in this build

- **Multi-provider AI**, dynamically discovered, health-checked, and routed — NVIDIA NIM,
  Cloudflare AI, OpenRouter, plus **any OpenAI-compatible endpoint an admin adds from the
  panel**, with its own key, no code change or redeploy.
- **A real admin panel**, not a mockup: providers, custom providers, models, routing rules,
  rate limits, users, conversations, a full CMS for every visitor-facing text/icon/favicon/logo,
  feature flags, an audit log, maintenance mode, and admin-password rotation. Every screen is
  wired to a real endpoint.
- **Production-grade rate limiting** — per-visitor limits on the composer, and a global
  per-provider limit that every visitor's traffic shares, specifically so a public, login-free
  deployment can never exceed a free provider key's quota. Fully configurable from the panel.
- **A live-editable CMS** — brand name, tagline, favicon, logo mark, welcome copy, suggestion
  chips, composer placeholder, an announcement banner — all editable from the admin panel and
  applied to every visitor's next page load, no redeploy.
- **Zero-cost infrastructure** — one Cloudflare Worker (serving the static apps too) plus KV + D1,
  sized to run comfortably inside the free tier (see the limits table in `docs/DEPLOYMENT.md`).

## Documentation

| Document | Covers |
|---|---|
| `docs/OVERVIEW.md` | Architecture map, design principles |
| `docs/DEPLOYMENT.md` | Deploying to Cloudflare for free, step by step |
| `docs/FRONTEND.md` | The chat app's features and internals |
| `docs/ADMIN.md` | Every admin panel screen, what it controls |
| `docs/BACKEND.md` | Providers, routing, health, discovery internals |
| `docs/API_REFERENCE.md` | Every endpoint, request/response shapes |
| `docs/SECURITY.md` | Rate limiting design, auth model, what "no login wall" means |
| `api/README.md` | Quick backend reference (mirrors the docs above, shorter) |

## What's next

Two gaps left open on purpose: real end-user authentication (conversations are currently scoped
by a per-device id, not an account — see `docs/SECURITY.md`), and R2-backed attachment storage
with server-side text extraction for the self-hosted path. Both slot into the existing `api/`
structure without touching routing, health, or rate limiting.
