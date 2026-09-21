# Security & rate limiting

Saturday's chat endpoint has no login wall by design — that's the product. This document
covers what protects it (and you, as the operator of a free provider key) as a result, and what
the admin/auth model does and doesn't guarantee.

## Why rate limiting has two layers

A single per-visitor limit isn't enough on a public site: it stops any *one* person from
draining your NVIDIA NIM quota, but it does nothing to stop *ten thousand different people*
each sending a few messages from collectively blowing through it. So there are two independent
layers, checked in order on every chat request:

1. **Per-visitor (by IP).** `chatPerMinutePerIP` (default 12) and `chatPerDayPerIP` (default
   200) — a fixed-window counter in KV, keyed by IP. Exceeding it returns `429` immediately,
   before any provider is ever contacted, with a `retry-after` header and a friendly message.

2. **Global, per provider.** `providerPerMinute[providerId]` (defaults: 30 for NVIDIA NIM, 60
   for Cloudflare AI, 20 for OpenRouter, 20 for anything else) — one shared counter *per
   provider*, incremented by every request from every visitor combined. This is the layer that
   actually protects the upstream key: no matter how much traffic the site gets, requests to a
   given provider can never exceed this number per minute, site-wide.

Layer 2 is checked inside the fallback loop in `api/chat.ts`, immediately before each candidate
model is tried — so if NVIDIA NIM's bucket is full, the request transparently falls through to
the next eligible model (say, an OpenRouter one) rather than failing outright, and only returns
a `rate_limited` error if *every* eligible model is currently capped.

Deliberately **not** wired into the health-tracking system: a rate-limit hit doesn't mean a
model is broken, so it doesn't get treated like one. If it did, the health system's exponential
backoff would compound a brief traffic spike into an hour-long cooldown for a perfectly healthy
model — the rate limiter's own 60-second window is already the correct, self-resetting
mechanism for this. (This was caught and fixed during development — see the git history / the
comment in `api/src/api/chat.ts` if you're curious why it's built this way.)

Both layers, plus a general per-IP limit covering every other route and a max-message-length
cap, are configurable from **Admin → Rate limits** with no redeploy.

## Other abuse protections

- **Message length cap** (`maxMessageChars`, default 8,000) — rejected with `413` before
  reaching any provider.
- **Login rate limiting** — `/api/admin/login` has its own, tighter limit independent of
  everything else, to resist password guessing.
- **CORS** — `ALLOWED_ORIGINS` in `wrangler.toml` is an allowlist; requests from anywhere else
  are rejected at the browser level.
- **Maintenance mode** — a manual circuit breaker: flip it on from the admin panel and every
  route except the panel itself and `/api/health` returns 503 immediately.

## What "no authentication wall" means in practice

Regular visitors are identified by a random id the frontend generates and stores in
`localStorage` (sent as `x-saturday-user`), not by an account. This is enough to scope
conversation history per-device and to give the admin panel something to list under **Users**,
but it is **not** an authentication system — anyone can generate a new id by clearing their
storage, and the header itself isn't verified against anything. Don't rely on it for anything
that needs a real identity guarantee. If you need that, put real authentication in front of the
frontend (or fork it) — the API's conversation routes will happily scope to whatever value you
send in `x-saturday-user`.

## The admin panel's authentication model

- **Passwords** are never stored in plaintext. The `ADMIN_PASSWORD` Worker secret is the
  default; rotating a password from the panel stores a PBKDF2-SHA256 hash (120,000 iterations,
  random salt) in KV, which then takes priority over the secret.
- **Sessions** are stateless bearer tokens: a JSON payload (`role`, issued-at, expires-at)
  signed with HMAC-SHA256 using `ADMIN_TOKEN_SECRET`. Verifying a token is a pure signature
  check — no database lookup, no session store, so any Worker instance anywhere can verify it
  independently. Tokens last 12 hours.
- **A `401` from the bearer-token check** always carries `{ error: "unauthorized" }` specifically
  — that's the signal the admin panel's client uses to force a logout. Any *other* 401 (like a
  wrong current password when rotating credentials) is a normal, recoverable error and does
  **not** log the admin out. This distinction matters and was a real bug during development:
  conflating the two meant mistyping your current password would silently boot you out of the
  entire panel instead of just showing an error.
- **Every mutation is audited.** `audit_log` records the actor, the action, the target, and a
  JSON snapshot of what changed, for every admin write.

## Reporting a concern

This is a self-hosted project — there's no vendor to report issues to. If you find a security
problem, fix it in your own deployment and, if you got this project from somewhere with an
issue tracker, consider contributing the fix back.
