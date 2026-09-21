# Deploying Saturday for free on Cloudflare

This walks through a complete production deployment — chat app, admin panel, and API —
entirely on Cloudflare's free tier: Pages, Workers, KV, and D1 all have free allocations big
enough to run Saturday for a genuinely public site. Nothing here requires a credit card beyond
what Cloudflare itself asks for account verification.

Total time: about 20 minutes the first time.

## What you'll end up with

```
https://saturday.pages.dev            ← the chat app (or your own domain)
https://saturday.pages.dev/admin/     ← the admin panel
https://saturday-api.<you>.workers.dev ← the API, called by both of the above
```

Two deployment shapes are covered below. Pick one:

- **A — Same-origin (recommended).** Frontend and admin panel deployed together as one
  Cloudflare Pages project, with a `_redirects` rule that proxies `/api/*` to your Worker.
  Visitors never see a different domain, there's no CORS to configure, and nobody has to type
  an API URL into Settings — it just works.
- **B — Separate domains.** The API on its own Workers subdomain, the frontend/admin on Pages.
  A little more setup (CORS, one config line), but useful if you want the API reachable from
  somewhere else too.

Both shapes use the exact same Worker and the exact same frontend files — the only difference
is one file (`_redirects`) and one line of frontend config.

---

## 1. Install Wrangler and sign in

```bash
npm install -g wrangler
wrangler login
```

This opens a browser window to authorize Wrangler against your Cloudflare account (free is
fine — no plan upgrade needed for anything in this guide).

## 2. Deploy the API (Cloudflare Workers)

```bash
cd api
npm install
```

Create the two storage resources the Worker needs:

```bash
npx wrangler kv namespace create REGISTRY
```

Copy the `id` it prints into `wrangler.toml`, replacing `replace-with-your-kv-id`:

```toml
[[kv_namespaces]]
binding = "REGISTRY"
id = "the-id-you-just-got"
```

```bash
npx wrangler d1 create saturday
```

Copy that `database_id` into `wrangler.toml` too:

```toml
[[d1_databases]]
binding = "DB"
database_name = "saturday"
database_id = "the-id-you-just-got"
```

Load the schema:

```bash
npx wrangler d1 execute saturday --file=schema.sql --remote
```

Set your secrets. You only need the ones for providers you actually want — a provider with no
key simply never appears, anywhere, to anyone:

```bash
npx wrangler secret put NVIDIA_NIM_API_KEY      # free tier at build.nvidia.com
npx wrangler secret put OPENROUTER_API_KEY      # free models at openrouter.ai
npx wrangler secret put CLOUDFLARE_API_KEY      # optional if you'd rather use the AI binding below
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put ADMIN_TOKEN_SECRET      # any long random string, e.g. `openssl rand -hex 32`
npx wrangler secret put ADMIN_PASSWORD          # the password the admin panel's login screen checks
```

Cloudflare AI (Workers AI) can skip its own API key entirely — `wrangler.toml` already binds it
natively:

```toml
[ai]
binding = "AI"
```

with that binding present, `CLOUDFLARE_API_KEY`/`CLOUDFLARE_ACCOUNT_ID` are optional.

Now deploy:

```bash
npm run deploy
```

Wrangler prints your Worker's URL — something like `https://saturday-api.your-name.workers.dev`.
Keep that; you'll need it in a moment.

Verify it's alive:

```bash
curl https://saturday-api.your-name.workers.dev/api/health
# {"ok":true,"ts":...}
```

## 3. Set `ALLOWED_ORIGINS`

Open `api/wrangler.toml` and set this to wherever you're about to deploy the frontend (you can
guess the Pages URL before creating the project — it's `https://<project-name>.pages.dev` — or
come back and fix this after step 4):

```toml
[vars]
ALLOWED_ORIGINS = "https://saturday.pages.dev,http://localhost:5173"
```

Redeploy after changing it: `npm run deploy`.

*(Shape A only: if frontend and API end up same-origin via the `_redirects` proxy below, the
browser never makes a cross-origin request at all, so this matters less — but it's still worth
setting correctly for shape B or for anyone calling the API directly.)*

## 4. Prepare the frontend

**Shape A (same-origin, recommended):**

```bash
mkdir -p pages-project
cp frontend/index.html pages-project/index.html
mkdir -p pages-project/admin
cp admin/index.html pages-project/admin/index.html
```

Create `pages-project/_redirects` with one line (swap in your real Worker URL):

```
/api/*  https://saturday-api.your-name.workers.dev/api/:splat  200
```

The `200` status code is what makes Cloudflare Pages treat this as a transparent proxy rather
than a redirect — the visitor's browser only ever sees your Pages domain.

Nothing else to configure. Because the API is now same-origin, the frontend's default
`window.SATURDAY_CONFIG.apiBase = ''` combined with the admin panel simply won't reach it —
so for Shape A, open `pages-project/index.html`, find the config block near the very top of
the `<script>` tag, and set it to the same-origin sentinel:

```js
window.SATURDAY_CONFIG = {
  apiBase: 'same-origin',
};
```

That one edit is the only thing you customize before deploying. Every visitor gets it
automatically — nobody has to configure anything themselves.

**Shape B (separate domains):**

```bash
mkdir -p pages-project
cp frontend/index.html pages-project/index.html
mkdir -p pages-project/admin
cp admin/index.html pages-project/admin/index.html
```

Edit the same config block, but with your Worker's real URL instead of the sentinel:

```js
window.SATURDAY_CONFIG = {
  apiBase: 'https://saturday-api.your-name.workers.dev',
};
```

No `_redirects` file needed for this shape — just make sure `ALLOWED_ORIGINS` (step 3) includes
your Pages domain.

## 5. Deploy the frontend (Cloudflare Pages)

Via the dashboard: **Workers & Pages → Create → Pages → Upload assets**, and upload the
`pages-project` folder. Or via Wrangler:

```bash
npx wrangler pages deploy pages-project --project-name=saturday
```

Wrangler prints your Pages URL. Open it — the chat app should load immediately, and if you set
up Shape A or B correctly, Settings → AI & models → "Connection" should show a green dot.

Open `https://<your-pages-url>/admin/` and sign in with the `ADMIN_PASSWORD` you set in step 2.
From Settings inside the admin panel, consider rotating that password to one stored in the
database instead of the Worker secret — see `docs/ADMIN.md`.

## 6. (Optional) Put it on your own domain

In the Pages project settings, **Custom domains → Add a domain**, and follow Cloudflare's DNS
instructions. If you're on Shape B, remember to add the new domain to `ALLOWED_ORIGINS` and
redeploy the Worker.

## 7. Turn on the cron health sweep

Already configured in `wrangler.toml` (`crons = ["*/30 * * * *"]`) — nothing to do. Cloudflare
runs it automatically once the Worker is deployed; check **Workers & Pages → your Worker →
Triggers** to confirm it's listed.

---

## Free-tier limits worth knowing

| Resource | Free allowance | What Saturday uses it for |
|---|---|---|
| Workers requests | 100,000/day | Every API call |
| KV reads/writes | 100,000 reads, 1,000 writes per day | Health cache, rate-limit counters, catalogue cache |
| D1 rows read/written | 5M reads, 100K writes per day | Conversations, users, admin config |
| Pages | Unlimited requests, 500 builds/month | The static frontend and admin panel |

The rate limits in `docs/SECURITY.md` (defaults: 12 chat messages/minute per visitor, provider
caps like 30/minute for NVIDIA NIM) are set conservatively enough that a genuinely popular free
deployment stays inside these ceilings; tune them from the admin panel's **Rate limits** screen
if you have headroom to spare.

## Updating later

Pulled a change to `api/`? Re-run `npm run deploy` from `api/`. Schema changes are additive and
idempotent — re-running `wrangler d1 execute saturday --file=schema.sql --remote` after an
update is always safe. Frontend or admin panel changed? Just re-upload the file(s) to Pages;
there's no build step.

## Troubleshooting

- **"Couldn't reach that URL" on admin login** — check `ALLOWED_ORIGINS` includes the admin
  panel's actual origin, and that you typed the Worker URL with `https://` and no trailing slash.
- **Models never show as available** — open Settings → AI & models → Model health → *Run health
  check*; if a specific provider stays "unavailable", its Worker secret is likely missing or
  wrong. Check `GET /api/providers` for `configured: false`.
- **Admin panel says "admin_not_configured"** — `ADMIN_TOKEN_SECRET` and/or `ADMIN_PASSWORD`
  weren't set as Worker secrets. Re-run the `wrangler secret put` commands from step 2.
- **CORS errors in the browser console (Shape B)** — the origin making the request isn't in
  `ALLOWED_ORIGINS`. Redeploy the Worker after fixing it.
