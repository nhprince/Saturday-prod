# The frontend

`api/public/index.html` — one file: inline CSS, inline HTML, inline JavaScript. No build step,
no bundler, no npm install. The deployed Worker serves it at `/` as a static asset; opened
standalone (e.g. as a Claude.ai artifact) it still runs.

## Two runtimes, one file

The app tries two model sources, and can use either or both at once:

1. **The Claude Artifact runtime.** If `window.claude.use('sample')` resolves (true when the
   page is running as a Claude.ai artifact), three models appear automatically — Saturday Quick,
   Saturday Core, Saturday Deep — mapped to small/default/complex tiers. No configuration, no
   cost beyond the person's own Claude usage.
2. **A self-hosted Saturday API.** If `window.SATURDAY_CONFIG.apiBase` (or a visitor's own
   Settings override) points at a deployed backend, NVIDIA NIM, Cloudflare AI, OpenRouter, and
   any admin-added custom providers are discovered from there and streamed through it —
   including image input, encoded as data URLs.

Both can be active simultaneously; the model picker just shows whatever's actually available
from either source, grouped by provider.

## Routing

**Free Router** picks the cheapest (smallest-tier) healthy model that can do the job. **Smart
Router** classifies the request locally — code, mathematics, reasoning, image input, structured
output, long context, or a short casual message — and picks the model whose tier best matches.
Both fall back automatically through the next eligible model if one fails, and the badge under
each reply shows exactly what was decided and why (tap it for the full trace: signals detected,
candidates considered, whether it fell back).

This client-side classifier mirrors the server-side one in `api/src/services/router.ts` almost
exactly, so behavior is consistent whether a message goes through the Claude runtime or the
self-hosted API.

## Rendering

A hand-written renderer (no external Markdown library) handles headings, lists, tables, block
quotes, links, images, inline code, fenced code blocks with lightweight syntax highlighting, and
a serviceable LaTeX-to-HTML converter for `$inline$` and `$$display$$` math (fractions, roots,
sums/integrals, Greek letters, common symbols). Everything is escaped before any of these
patterns are applied, so raw HTML in a message never executes.

## The composer

Auto-expanding textarea, drag-and-drop and paste-to-attach for images and text/code files,
voice input via the Web Speech API with a live waveform (skipped gracefully if the browser
doesn't support it), and a model/router picker that becomes a bottom sheet on mobile.

## Branding — reading from the CMS

If a Saturday API is configured, the app fetches `GET /api/cms/site` once on boot and applies
whatever the admin has set: site name, tagline, favicon, logo mark, the welcome screen's heading
and subheading and suggestion chips, the composer's placeholder text, and an optional dismissible
announcement banner. Every one of these has a built-in default matching what you see with no
backend configured at all, so there's no flash of empty content — only a brief swap from default
to custom copy once the fetch resolves. See `Brand` in the file's script for the full mapping,
and `docs/ADMIN.md` for how these are edited.

## Settings

- **Appearance** — light/dark/system, compact density
- **Chat** — Enter-to-send, timestamps, the routing badge
- **Voice** — recognition language, send-after-dictation
- **AI & models** — self-hosted backend URL (overrides the site default just for this visitor),
  default router, automatic fallback, provider list, per-model health with a manual re-check
- **Privacy** — local history on/off, a "delete everything on this device" button
- **Account** — a local display name, usage counts

History is stored in the browser either way. When a Saturday API is configured and history
saving is on, conversations are *also* mirrored to the backend (scoped to this device's id) —
that's what the admin panel's Users and Conversations screens show. Turning history off, or
deleting everything, stops and removes the mirrored copy too.

## What's deliberately not here

There's no server-side rendering, no build pipeline, and no framework — on purpose. The whole
point is that this file is the artifact: paste it into a Claude conversation and it's a working
product; drop it on any static host and it's the same product, unlocking more when it's told
about a backend. Anything that would require a build step (bundling a component framework, for
instance) was left out so that promise stays true.
