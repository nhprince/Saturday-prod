# The admin panel

`api/public/admin/index.html` — a second single-file app, served at `/admin/` by the same
Worker: a real dashboard over the API's admin endpoints.
Open it, sign in with your `ADMIN_PASSWORD` (or a rotated panel password — see **System**
below), and every screen below is live.

## Overview

System health (KV/D1 reachability), how many providers are configured and enabled, how many
models are available vs. degraded, and the current maintenance-mode state. Three one-click
actions: refresh the model catalogue, health-check everything, toggle maintenance mode.

## Providers

The three built-in providers (NVIDIA NIM, Cloudflare AI, OpenRouter) — enable/disable each, set
a priority, see at a glance whether its Worker secret is actually configured. Disabling a
provider here immediately marks all of its models unavailable everywhere (the picker, the
router, the API) — no redeploy, no cache to wait out.

## Custom providers

Add any OpenAI-compatible chat-completions endpoint — Together AI, Groq, Fireworks, a
self-hosted vLLM box, anything — with just a name, base URL, and API key. It's discovered,
normalized, health-checked, and made available to the router exactly like a built-in provider,
because under the hood it *is* one (see `docs/BACKEND.md`). A "free models only" toggle filters
its catalogue to whatever it prices at zero, where it publishes pricing. Editing an existing
one lets you rotate the key without re-entering the name or URL; deleting one removes its
models immediately. The key is never shown back to you in full — only masked
(`sk-t••••7890`) — and it's never sent anywhere except that endpoint itself.

## Models

Every discovered model, across every provider, with live status, latency, and last-checked
time. Filter by status. Force a re-check on one model or all of them. Disable a specific model
without touching its provider (useful when a provider's catalogue includes something flaky).

## Routing

Rules that bias Smart Router: "when the request needs `code`, prefer this exact model" or "when
it needs `reasoning`, prefer the `large` tier." The first enabled rule (by position) whose
signal matches and whose target is still available wins; nothing matches, and Smart Router just
uses its default size-matching logic. Free Router always ignores these and stays cost-first.

## Rate limits

Two panels, matching the two-layer system described in `docs/SECURITY.md`: per-visitor limits
(messages per minute/day, max message length, general API requests per minute) and a global
per-provider limit — a number, per provider, that every visitor's combined traffic shares. This
is the dial that keeps a suddenly-popular free deployment from getting a provider key
suspended; the defaults are conservative, and every custom provider you add gets a sensible
fallback limit automatically until you set one explicitly.

## Branding & content

Every visitor-facing piece of copy and imagery, in one place:

- **Brand** — name, tagline, favicon (an emoji or an image URL), logo mark (paste raw
  `<svg>…</svg>` markup or an image URL; leave blank for the built-in icon)
- **Welcome screen** — heading, subheading, and the suggestion chips (add/remove freely)
- **Composer** — the placeholder text
- **Announcement** — an optional dismissible banner with your own message

Saved instantly, applied on every visitor's next page load — nothing to redeploy, no build
step, no cache to bust.

## Custom content

A generic key/value store for anything not covered by Branding & content — an FAQ blob, a
changelog, whatever your own integration wants to read back from `GET /api/cms?key=your-key`.

## Users

Every device that has started a conversation against the API (created automatically on that
first exchange — there's no signup flow to manage). Change role or status inline, inspect
someone's recent conversations, delete a user (cascades to their conversations and messages).

## Conversations

Search across every user's conversations by title, inspect a full transcript (including which
model answered each message), delete one. This is moderation tooling, not a support inbox —
there's no reply-to-user feature by design.

## Feature flags

Simple key + enabled + rollout-percentage rows, readable at `GET /api/flags`. Saturday's own
frontend doesn't currently gate anything behind these, but your own integrations or a forked
frontend can.

## Audit log

Every admin mutation — who, what, when, and a JSON snapshot of the change — most recent first,
filterable by action.

## System

**Maintenance mode**: pause the entire product (everything except this panel and `/api/health`
starts returning 503 with your message) — for the five minutes you're doing something
disruptive, not a permanent state.

**Admin password**: the panel checks the `ADMIN_PASSWORD` Worker secret by default. Set a new
password here (requires the current one) to rotate it into a PBKDF2 hash stored in the
database instead — from then on, that's the credential that matters, and the Worker secret is
no longer checked. Useful for changing credentials without a redeploy, or for handing off
administration without sharing the original secret.

## What ties it all together

Nothing in this panel is a mock. Every screen loads from a real endpoint on first render, every
control writes to a real endpoint on change, and `docs/API_REFERENCE.md` lists the exact routes
each screen uses if you want to call them yourself.
