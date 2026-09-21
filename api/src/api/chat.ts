/* ============================================================
   Saturday — POST /api/chat and /api/chat/stream
   The stream announces its routing decision before the first
   token, and again if it falls back, so the interface never
   shows a model that did not actually answer.

   This endpoint has no login wall, so the provider-level rate
   limit below is the thing standing between "public site" and
   "NVIDIA suspends the key": every visitor's requests to a given
   provider draw from ONE shared bucket, checked before the model
   is ever called.
   ============================================================ */
import { AIMessage, Env, ProviderError } from '../types';
import { Registry } from '../services/registry';
import { RouterService } from '../services/router';
import { RateLimiter } from '../services/ratelimit';

interface ChatBody {
  messages: AIMessage[];
  model?: string;              // 'smart' | 'free' | model id
  conversationId?: string;
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

const sse = (event: string, data: unknown) =>
  new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function textLength(messages: AIMessage[]): number {
  return messages.reduce((n, m) => n + (typeof m.content === 'string'
    ? m.content.length
    : m.content.reduce((s, p) => s + (p.text?.length ?? 0), 0)), 0);
}

export async function handleChatStream(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as ChatBody;
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return Response.json({ error: 'messages is required' }, { status: 400 });
  }

  const registry = new Registry(env);
  const router = new RouterService(registry);
  const health = registry.healthService();
  const limiter = new RateLimiter(env);

  const maxChars = await limiter.maxMessageChars();
  if (textLength(body.messages) > maxChars) {
    return Response.json({ error: 'message_too_long', message: `Messages exceed the ${maxChars}-character limit for this deployment.` }, { status: 413 });
  }

  const hasImages = body.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

  let routed;
  try {
    routed = await router.route({ selection: body.model ?? 'smart', messages: body.messages, hasImages, wantsJson: body.json });
  } catch (e) {
    return Response.json(
      { error: 'no_model', message: 'No compatible model is available right now.' },
      { status: 503 });
  }

  const { decision, chain } = routed;
  const attempts = [routed.model, ...chain];
  const stream = new ReadableStream({
    async start(controller) {
      const abort = new AbortController();
      req.signal?.addEventListener('abort', () => abort.abort());

      for (let i = 0; i < attempts.length; i++) {
        const model = attempts[i]!;
        const provider = registry.providerFor(model);
        if (!provider) continue;

        // Global, cross-visitor throttle — protects the upstream key regardless of how many
        // different people are using the site at once. This is NOT recorded as a health
        // failure: the rate limiter's own 60-second window already recovers on its own, and
        // feeding it into the health system's exponential backoff would compound a brief
        // traffic spike into an hour-long cooldown for a model that was never actually broken.
        const gate = await limiter.providerAllowed(model.provider);
        if (!gate.ok) {
          const last = i === attempts.length - 1;
          if (last) {
            controller.enqueue(sse('error', {
              code: 'rate_limited',
              message: 'Saturday is receiving a lot of requests right now. Please try again in a moment.',
              retryAfter: gate.retryAfter,
            }));
            controller.close();
            return;
          }
          continue; // try the next model in the fallback chain instead
        }

        const routing = { ...decision, modelId: model.id, provider: model.provider, ...(i ? { fallbackFrom: attempts[i - 1]!.id, reason: `Fell back after ${attempts[i - 1]!.id} failed` } : {}) };
        controller.enqueue(sse('routing', routing));

        const t0 = Date.now();
        let produced = 0;
        try {
          for await (const chunk of provider.stream({
            model, messages: body.messages, signal: abort.signal,
            json: body.json, temperature: body.temperature, maxTokens: body.maxTokens,
          })) {
            if (chunk.delta) { produced += chunk.delta.length; controller.enqueue(sse('delta', { delta: chunk.delta })); }
            if (chunk.done) break;
          }
          await health.observe(model.id, true, Date.now() - t0);
          controller.enqueue(sse('done', { modelId: model.id, latencyMs: Date.now() - t0, chars: produced }));
          controller.close();
          return;
        } catch (e) {
          const err = e as ProviderError;
          await health.observe(model.id, false, Date.now() - t0, err.state ?? 'ERROR', err.message);
          if (abort.signal.aborted) { controller.close(); return; }
          // Tokens already delivered: do not restart on another model mid-answer.
          if (produced > 0) {
            controller.enqueue(sse('error', { code: 'interrupted', message: 'The response was cut short.', modelId: model.id }));
            controller.close();
            return;
          }
          const last = i === attempts.length - 1;
          if (last) {
            controller.enqueue(sse('error', {
              code: err.state === 'AUTH_FAILED' ? 'auth_failed' : err.state === 'RATE_LIMITED' ? 'rate_limited' : 'upstream_error',
              message: 'Every eligible model failed for this request.',
            }));
            controller.close();
            return;
          }
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/** Non-streaming variant, same routing, same fallback policy, same rate-limit gate. */
export async function handleChat(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as ChatBody;
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return Response.json({ error: 'messages is required' }, { status: 400 });
  }

  const registry = new Registry(env);
  const router = new RouterService(registry);
  const health = registry.healthService();
  const limiter = new RateLimiter(env);

  const maxChars = await limiter.maxMessageChars();
  if (textLength(body.messages) > maxChars) {
    return Response.json({ error: 'message_too_long', message: `Messages exceed the ${maxChars}-character limit for this deployment.` }, { status: 413 });
  }

  const hasImages = body.messages?.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

  let routed;
  try {
    routed = await router.route({ selection: body.model ?? 'smart', messages: body.messages, hasImages, wantsJson: body.json });
  } catch {
    return Response.json({ error: 'no_model' }, { status: 503 });
  }

  for (const model of [routed.model, ...routed.chain]) {
    const provider = registry.providerFor(model);
    if (!provider) continue;

    const gate = await limiter.providerAllowed(model.provider);
    if (!gate.ok) continue; // not a health failure — the rate window recovers on its own

    const t0 = Date.now();
    try {
      const res = await provider.generate({
        model, messages: body.messages, json: body.json,
        temperature: body.temperature, maxTokens: body.maxTokens,
      });
      await health.observe(model.id, true, Date.now() - t0);
      return Response.json({ ...res, routing: { ...routed.decision, modelId: model.id } });
    } catch (e) {
      const err = e as ProviderError;
      await health.observe(model.id, false, Date.now() - t0, err.state ?? 'ERROR', err.message);
    }
  }
  return Response.json({ error: 'upstream_error', message: 'Every eligible model failed, or the site is at capacity — please try again shortly.' }, { status: 502 });
}
