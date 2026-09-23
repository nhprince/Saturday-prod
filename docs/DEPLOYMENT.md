# Deploying Saturday on Cloudflare — one Worker, everything included

Saturday deploys as **one Cloudflare Worker**: the same deployment serves the chat
app (`/`), the admin panel (`/admin/`), and the API (`/api/*`), using Workers
Static Assets. One `wrangler.toml`, one Git-connected build, no CORS to configure,
and the cron health sweep keeps working because it's still a real Worker.

> **Cost: $0, and no card required.** Workers, KV, D1, Workers AI, cron triggers and
> static assets are all on Cloudflare's free plan without a payment method. The one
> Cloudflare product that does ask for a card — R2 object storage — is not used by
> Saturday. (`wrangler.toml` has a commented-out R2 block reserved for a future
> attachment feature; leaving it commented costs nothing.)

Total time: about 15 minutes.

## What you'll end up with

```
https://saturday.<your-subdomain>.workers.dev         ← the chat app
https://saturday.<your-subdomain>.workers.dev/admin/  ← the admin panel
https://saturday.<your-subdomain>.workers.dev/api/*   ← the API (same origin)
```

## The moving parts behind one deployment

`api/wrangler.toml` declares the whole thing:

```toml
[assets]
directory = "./public"          # public/index.html (chat) + public/admin/index.html (admin)
binding = "ASSETS"
run_worker_first = ["/api/*"]   # /api/* always executes the Worker
```

Cloudflare answers `/` and `/admin/` straight from its static-asset layer and only
invokes your Worker code for `/api/*`. A useful side effect: **page loads are free
and don't count against your daily Worker request quota** — only API calls do.

---

## 1. Create the storage resources (dashboard, no CLI needed)

In the Cloudflare dashboard:

1. **Workers & Pages → KV → Create namespace** → name it `REGISTRY` → copy the
   **Namespace ID** it shows.
2. **Storage & Databases → D1 SQL Database → Create** → name it `saturday` → copy
   the **Database ID**.

Edit `api/wrangler.toml` and paste both IDs in place of the placeholders:

```toml
[[kv_namespaces]]
binding = "REGISTRY"
id = "the-kv-namespace-id"

[[d1_databases]]
binding = "DB"
database_name = "saturday"
database_id = "the-d1-database-id"
```

Commit and push (or edit directly on GitHub — the web editor is fine).

## 2. Load the database schema

Dashboard → **Storage & Databases** → **D1** → open `saturday` → **Console** tab →
paste the full contents of `api/schema.sql` → **Execute**.

Every statement is `IF NOT EXISTS`, so re-running it after an update is always safe.

## 3. Connect the repo — this is the whole deployment

**Workers & Pages → Create application → Import a repository**, pick your git
provider, select the repository, then configure:

| Setting | Value |
|---|---|
| Name | `saturday` (must match `name` in `api/wrangler.toml`) |
| Root directory | `api` |
| Build command | *(leave empty)* |
| Deploy command | `npx wrangler deploy` (the default) |
| Production branch | `main` |

**Save and Deploy.** That one build uploads the Worker code *and* the two static
HTML files in `api/public/`, wires the KV/D1/AI bindings and the cron trigger, and
gives you the URL above. From now on, **every push to `main` redeploys everything**.

## 4. Set the secrets

Dashboard → your Worker → **Settings → Variables and Secrets → Add** (type
**Secret**):

| Secret | Required? | What it's for |
|---|---|---|
| `ADMIN_TOKEN_SECRET` | Yes | Signs admin sessions — any long random string |
| `ADMIN_PASSWORD` | Yes | The admin panel's login password |
| `NVIDIA_NIM_API_KEY` | Recommended | Free tier at build.nvidia.com |
| `OPENROUTER_API_KEY` | Optional | Free models at openrouter.ai |
| `CLOUDFLARE_API_KEY` / `CLOUDFLARE_ACCOUNT_ID` | Optional | Without them, the Cloudflare AI provider still works — the `[ai]` binding generates against a small built-in model list. With them, it discovers your account's full Workers AI catalogue instead. |

A provider with no key and no binding simply never appears — anywhere — by design.

## 5. Verify

- `https://saturday.<sub>.workers.dev/api/health` → `{"ok":true,"ts":…}`
- `https://saturday.<sub>.workers.dev/` → the chat app loads; **Settings → AI &
  models → Connection** shows a green dot; providers appear (whichever you keyed).
- Send a chat with **Smart Router** — it should stream, and the badge under the
  reply shows which model actually answered.
- `…/admin/` → sign in with your `ADMIN_PASSWORD`. The **API base URL** field is
  pre-filled with the site's own origin when you open the panel from the deployed
  site. Once in, run **Models → Health-check all** to populate statuses, and
  consider rotating the password from **System** (stores a PBKDF2 hash in KV; the
  Worker secret stops mattering from then on).

> **Fresh deployments warm up while they serve.** Until the first health probes
> land, every model shows as "unknown". Saturday still routes those early
> requests between unverified models (the badge says "not yet health-checked")
> and each attempt feeds the health system, so the first successful reply itself
> marks a model good. Health-check sweeps are budgeted (12 probes per 15 minutes
> by default — raise `HEALTH_PROBE_BUDGET` in `wrangler.toml` if you want a large
> catalogue verified faster), so full coverage of a big catalogue takes a while.
> Nothing to fix — just know that available-model counts grow as probes land.

## Optional: your own domain

Because everything is one Worker, a custom domain is a single **Worker custom
domain** (Workers & Pages → your Worker → Settings → Domains & Routes). Add
`chat.example.com` there and both the site and `/api/*` ride along — no second
mapping, no CORS change.

## Free-tier limits worth knowing

| Resource | Free allowance | What Saturday uses it for |
|---|---|---|
| Worker requests (`/api/*` only) | 100,000/day | Chat, model lists, the admin panel's calls |
| Static asset requests (`/`, `/admin/`) | free & unlimited | Serving the two HTML apps |
| KV reads / writes | 100,000 / 1,000 per day | Catalogue cache, health records, rate-limit counters |
| D1 rows read / written | 5M / 100K per day | Conversations, users, admin config, audit |
| Workers AI | daily free allocation | The Cloudflare provider's models |

The rate limits in `docs/SECURITY.md` (12 chat messages/min/visitor, provider caps
like 30/min) are tuned so a genuinely popular free deployment stays inside these
ceilings; tune them from **Admin → Rate limits** if you have headroom. The tightest
dial is the 1,000 KV-writes/day counter — at very high traffic that's the first
ceiling you'll meet, and the fix is Cloudflare's $5 paid plan, not a code change.

## Updating later

Push to `main`. Schema changes stay additive and idempotent — after pulling an
update that changes `schema.sql`, re-run it in the D1 console. The chat app and
admin panel are just two files under `api/public/`; editing them on GitHub and
committing is a full redeploy of everything.

## Troubleshooting

- **`/` returns JSON `{"error":"not_found"}`** — the assets didn't upload: check
  that `[assets] directory = "./public"` exists in `api/wrangler.toml` and that the
  build's **root directory** is `api` (so `./public` resolves to `api/public`).
- **`Could not resolve '…'` or binding errors on first deploy** — the KV/D1 IDs in
  `wrangler.toml` are still placeholders or mistyped (Step 1).
- **Models never show as available** — Admin → Models → *Run health check*; if a
  provider stays "unavailable", its Worker secret is likely missing or wrong.
  `GET /api/providers` shows `configured: false` for those.
- **Admin panel says `admin_not_configured`** — `ADMIN_TOKEN_SECRET` and/or
  `ADMIN_PASSWORD` weren't set as Worker secrets (Step 4).
- **The admin login says "Couldn't reach that URL"** — you typed the URL of the
  *page* instead of the site origin; use exactly `https://saturday.<sub>.workers.dev`
  (no trailing slash).
