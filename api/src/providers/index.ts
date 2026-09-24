/* ============================================================
   Saturday — providers
   NVIDIA NIM and OpenRouter speak the OpenAI chat-completions
   dialect, so they share a base. Cloudflare Workers AI does not,
   and gets its own implementation behind the same interface.
   ============================================================ */
import {
  AIModel, AIProvider, AIRequest, AIResponse, AIStreamChunk, Capabilities,
  Env, HealthState, ProviderError, stateFromStatus,
} from '../types';

const VISION_HINTS = /vision|vlm|llava|pixtral|-vl|multimodal|image/i;
const REASONING_HINTS = /reason|think|r1|qwq|o1|deepseek-r|nemotron-ultra|phi-4-reasoning/i;
const TOOL_HINTS = /instruct|tool|function|llama-3|qwen|mistral|nemotron|hermes/i;
const SMALL_HINTS = /1b|2b|3b|4b|7b|8b|9b|mini|small|flash|lite|tiny/i;
const LARGE_HINTS = /70b|72b|100b|123b|180b|235b|405b|480b|671b|large|ultra|max/i;

/** Provider catalogues (especially NVIDIA NIM's) list far more than chat models:
 *  guardrails, translators, embedders, OCR, image/music generators… They pass a
 *  1-token health probe but cannot hold a conversation — so routers would pick
 *  "available" models that can never answer. Filter them out at discovery.
 *  Leading-delimiter matching keeps legit names safe: 'vision-instruct' stays, and
 *  'sparse-moe' survives because '-' + 'sparse' never equals boundary + 'parse'. */
const NON_CHAT_HINTS = /(?:^|[\/\-_.\s])(guard|nemoguard|safety|moderation|moderator|embed(?:ding|der)?s?|rerank|reward|grader|riva|translat\w*|transcribe\w*|whisper|asr|tts|parse|ocr|detect(?:or)?|lyria|music|audio|video|image[-_]?gen|diffusion|clip|ising|calibrat\w*|segment\w*)/i;
export const looksChatty = (id: string) => !NON_CHAT_HINTS.test(id);

function inferCapabilities(id: string, raw: Record<string, unknown> = {}): Capabilities {
  const n = id.toLowerCase();
  const modality = String((raw as any)?.architecture?.input_modalities ?? '');
  return {
    text: true,
    vision: VISION_HINTS.test(n) || modality.includes('image'),
    tools: TOOL_HINTS.test(n),
    reasoning: REASONING_HINTS.test(n),
    json: true,
  };
}
function inferTier(id: string): AIModel['tier'] {
  const n = id.toLowerCase();
  if (LARGE_HINTS.test(n)) return 'large';
  if (SMALL_HINTS.test(n)) return 'small';
  return 'medium';
}
function prettify(id: string): string {
  const tail = id.includes('/') ? id.split('/').pop()! : id;
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bB\b/g, 'B');
}

/* ---------------- OpenAI-compatible base ---------------- */
abstract class OpenAICompatible implements AIProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  protected abstract baseUrl: string;
  protected abstract apiKey: string | undefined;
  protected extraHeaders: Record<string, string> = {};

  isConfigured() { return !!this.apiKey; }

  protected headers() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
  }

  /** Providers may filter their catalogue (e.g. OpenRouter keeps only free
      models). Every provider at minimum drops non-chat models by name. */
  protected keep(raw: Record<string, unknown>): boolean {
    return looksChatty(String((raw as any)?.id ?? ''));
  }
  protected isFree(_raw: Record<string, unknown>): boolean { return true; }
  protected contextOf(raw: Record<string, unknown>): number | undefined {
    const n = (raw as any).context_length ?? (raw as any).max_model_len ?? (raw as any).context_window;
    return typeof n === 'number' ? n : undefined;
  }

  async listModels(): Promise<AIModel[]> {
    if (!this.isConfigured()) return [];
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw new ProviderError(stateFromStatus(res.status), `${this.name} model list failed (${res.status})`, res.status);
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    const rows = body.data ?? [];
    return rows.filter((r) => this.keep(r)).map((raw) => {
      const providerModelId = String((raw as any).id);
      return {
        id: `${this.id}:${providerModelId}`,
        providerModelId,
        provider: this.id,
        displayName: prettify(providerModelId),
        family: providerModelId.split('/')[0],
        contextWindow: this.contextOf(raw),
        capabilities: inferCapabilities(providerModelId, raw),
        free: this.isFree(raw),
        tier: inferTier(providerModelId),
        status: 'unknown',
        raw,
      } satisfies AIModel;
    });
  }

  /** Cheapest real signal available: a 1-token completion. */
  async healthCheck(model: AIModel, signal?: AbortSignal) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        signal: signal ?? AbortSignal.timeout(12_000),
        body: JSON.stringify({
          model: model.providerModelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          temperature: 0,
          stream: false,
        }),
      });
      const latencyMs = Date.now() - t0;
      if (res.ok) { await res.body?.cancel(); return { state: 'WORKING' as HealthState, latencyMs }; }
      const text = (await res.text()).slice(0, 240);
      return { state: stateFromStatus(res.status), latencyMs, message: text };
    } catch (e) {
      const err = e as Error;
      return {
        state: (err.name === 'TimeoutError' || err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR') as HealthState,
        latencyMs: Date.now() - t0,
        message: err.message,
      };
    }
  }

  protected payload(req: AIRequest, stream: boolean) {
    return {
      model: req.model.providerModelId,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 2048,
      stream,
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    };
  }

  async generate(req: AIRequest): Promise<AIResponse> {
    // Whole-body timeout: providers buffer full completions (some take 45s+) —
    // 90s covers that without letting a wedged connection hang forever.
    const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.headers(), signal,
      body: JSON.stringify(this.payload(req, false)),
    });
    if (!res.ok) {
      const state = stateFromStatus(res.status);
      throw new ProviderError(state, (await res.text()).slice(0, 300), res.status, state !== 'AUTH_FAILED');
    }
    const body = (await res.json()) as any;
    if (body.error) throw new ProviderError('ERROR', String(body.error.message ?? body.error).slice(0, 300));
    const text = body.choices?.[0]?.message?.content ?? '';
    if (!text) throw new ProviderError('ERROR', 'empty completion');
    return {
      text,
      model: req.model.id,
      provider: this.id,
      finishReason: body.choices?.[0]?.finish_reason,
      usage: { promptTokens: body.usage?.prompt_tokens, completionTokens: body.usage?.completion_tokens },
    };
  }

  async *stream(req: AIRequest): AsyncIterable<AIStreamChunk> {
    // Time-to-first-byte watchdog, cleared once contact is established — a slow
    // but healthy stream is never killed mid-answer (unlike a plain timeout,
    // which would abort a legitimately long stream).
    const ctl = new AbortController();
    const onReqAbort = () => ctl.abort(req.signal?.reason);
    req.signal?.addEventListener('abort', onReqAbort);
    const ttfb = setTimeout(() => ctl.abort(new Error('provider did not start streaming in 30s')), 30_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: this.headers(), signal: ctl.signal,
        body: JSON.stringify(this.payload(req, true)),
      });
    } catch (e) {
      clearTimeout(ttfb);
      req.signal?.removeEventListener('abort', onReqAbort);
      const err = e as Error;
      throw new ProviderError(err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR', err.message);
    }
    if (!res.ok || !res.body) {
      clearTimeout(ttfb);
      req.signal?.removeEventListener('abort', onReqAbort);
      const state = stateFromStatus(res.status);
      throw new ProviderError(state, (await res.text()).slice(0, 300), res.status, state !== 'AUTH_FAILED');
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(ttfb); // first bytes arrived — the watchdog has done its job
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') { yield { delta: '', done: true }; return; }
          try {
            const json = JSON.parse(data);
            // Some providers stream failures as data frames at HTTP 200 — surface them.
            if (json.error) throw new ProviderError('ERROR', String(json.error.message ?? json.error).slice(0, 300));
            const delta = json.choices?.[0]?.delta?.content ?? '';
            const finish = json.choices?.[0]?.finish_reason ?? undefined;
            if (delta) yield { delta, done: false };
            if (finish) yield { delta: '', done: true, finishReason: finish };
          } catch (e) {
            if (e instanceof ProviderError) throw e;
            /* keep-alive or partial frame */
          }
        }
      }
      yield { delta: '', done: true };
    } finally {
      clearTimeout(ttfb);
      req.signal?.removeEventListener('abort', onReqAbort);
    }
  }
}

/* ---------------- NVIDIA NIM ---------------- */
export class NvidiaNimProvider extends OpenAICompatible {
  readonly id = 'nvidia-nim';
  readonly name = 'NVIDIA NIM';
  protected baseUrl = 'https://integrate.api.nvidia.com/v1';
  protected apiKey: string | undefined;
  constructor(env: Env) { super(); this.apiKey = env.NVIDIA_NIM_API_KEY; }
  // The NIM catalogue lists every published model; health checking decides
  // which ones this account can actually call.
  protected override isFree() { return true; }
}

/* ---------------- OpenRouter ---------------- */
export class OpenRouterProvider extends OpenAICompatible {
  readonly id = 'openrouter';
  readonly name = 'OpenRouter';
  protected baseUrl = 'https://openrouter.ai/api/v1';
  protected apiKey: string | undefined;
  constructor(env: Env) {
    super();
    this.apiKey = env.OPENROUTER_API_KEY;
    this.extraHeaders = { 'HTTP-Referer': 'https://saturday.pages.dev', 'X-Title': 'Saturday' };
  }
  /** Only free text-out chat models: priced at zero, chat-capable by name, and
      — where the catalogue declares modalities — actually emitting text. */
  protected override keep(raw: Record<string, unknown>) {
    if (!super.keep(raw)) return false;
    if (!this.isFree(raw)) return false;
    const out = (raw as any)?.architecture?.output_modalities;
    if (Array.isArray(out) && out.length && !out.includes('text')) return false;
    return true;
  }
  protected override isFree(raw: Record<string, unknown>) {
    const p = (raw as any).pricing ?? {};
    return Number(p.prompt ?? 1) === 0 && Number(p.completion ?? 1) === 0;
  }
}

/* ---------------- custom (admin-added) providers ---------------- */
/** Any OpenAI-compatible endpoint, added from the admin panel with its own
 *  base URL and key — no code change or redeploy needed. Reuses every piece
 *  of OpenAICompatible: discovery, health checks, generation, streaming. */
export class CustomProvider extends OpenAICompatible {
  readonly id: string;
  readonly name: string;
  protected baseUrl: string;
  protected apiKey: string | undefined;
  private freeOnly: boolean;

  constructor(row: { id: string; name: string; base_url: string; api_key: string; free_only?: number }) {
    super();
    this.id = row.id;
    this.name = row.name;
    this.baseUrl = row.base_url.replace(/\/+$/, '');
    this.apiKey = row.api_key;
    this.freeOnly = !!row.free_only;
  }

  protected override keep(raw: Record<string, unknown>) {
    return super.keep(raw) && (this.freeOnly ? this.isFree(raw) : true);
  }
  protected override isFree(raw: Record<string, unknown>) {
    // Not every custom endpoint publishes pricing; treat unknown pricing as free
    // rather than silently hiding the model, since the admin opted in explicitly.
    const p = (raw as any).pricing;
    if (!p) return true;
    return Number(p.prompt ?? 0) === 0 && Number(p.completion ?? 0) === 0;
  }
}

/* ---------------- Cloudflare Workers AI ---------------- */
/** Well-known Workers AI text models, used only when the REST catalogue isn't
 *  available (a binding-only deployment without CLOUDFLARE_API_KEY). The health
 *  system probes each one, so a stale entry simply never shows as available. */
const WORKERS_AI_FALLBACK = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.2-1b-instruct',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  '@cf/mistral/mistral-7b-instruct-v0.1',
  '@cf/qwen/qwen1.5-14b-chat-awq',
];

export class CloudflareProvider implements AIProvider {
  readonly id = 'cloudflare';
  readonly name = 'Cloudflare AI';
  constructor(private env: Env) {}

  isConfigured() { return !!(this.env.AI || (this.env.CLOUDFLARE_API_KEY && this.env.CLOUDFLARE_ACCOUNT_ID)); }

  private toModel(providerModelId: string, raw: Record<string, unknown>, contextWindow?: number): AIModel {
    return {
      id: `cloudflare:${providerModelId}`,
      providerModelId,
      provider: this.id,
      displayName: prettify(providerModelId),
      family: providerModelId.split('/')[2],
      contextWindow,
      capabilities: inferCapabilities(providerModelId, raw),
      free: true,
      tier: inferTier(providerModelId),
      status: 'unknown',
      raw,
    };
  }

  async listModels(): Promise<AIModel[]> {
    if (!this.env.CLOUDFLARE_API_KEY || !this.env.CLOUDFLARE_ACCOUNT_ID) {
      // Binding-only deploy: there is no catalogue API to list, so expose a small
      // static set instead of nothing — health checks decide what actually runs.
      if (!this.env.AI) return [];
      return WORKERS_AI_FALLBACK.map((id) => this.toModel(id, { staticCatalogue: true }));
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?per_page=200&task=Text%20Generation`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.env.CLOUDFLARE_API_KEY}` } });
    if (!res.ok) throw new ProviderError(stateFromStatus(res.status), `Workers AI catalogue failed (${res.status})`, res.status);
    const body = (await res.json()) as { result?: Record<string, unknown>[] };
    return (body.result ?? []).map((raw) => {
      const providerModelId = String((raw as any).name);
      const props = ((raw as any).properties ?? []) as Array<{ property_id: string; value: string }>;
      const ctx = Number(props.find((p) => p.property_id === 'context_window')?.value);
      return this.toModel(providerModelId, raw, Number.isFinite(ctx) ? ctx : undefined);
    });
  }

  async healthCheck(model: AIModel) {
    const t0 = Date.now();
    try {
      await this.run(model, [{ role: 'user', content: 'ping' }], { max_tokens: 1 });
      return { state: 'WORKING' as HealthState, latencyMs: Date.now() - t0 };
    } catch (e) {
      const err = e as ProviderError;
      return { state: err.state ?? ('ERROR' as HealthState), latencyMs: Date.now() - t0, message: err.message };
    }
  }

  private async run(model: AIModel, messages: unknown, opts: Record<string, unknown> = {}) {
    if (this.env.AI) return this.env.AI.run(model.providerModelId as any, { messages, ...opts } as any);
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model.providerModelId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.env.CLOUDFLARE_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages, ...opts }),
    });
    if (!res.ok) throw new ProviderError(stateFromStatus(res.status), (await res.text()).slice(0, 300), res.status);
    return ((await res.json()) as any).result;
  }

  async generate(req: AIRequest): Promise<AIResponse> {
    const out = await this.run(req.model, req.messages, { max_tokens: req.maxTokens ?? 2048, temperature: req.temperature ?? 0.7 });
    return { text: (out as any)?.response ?? '', model: req.model.id, provider: this.id };
  }

  async *stream(req: AIRequest): AsyncIterable<AIStreamChunk> {
    // The binding returns a ReadableStream of OpenAI-style SSE frames.
    const out = await this.run(req.model, req.messages, {
      max_tokens: req.maxTokens ?? 2048, temperature: req.temperature ?? 0.7, stream: true,
    });
    const body: ReadableStream | undefined = out instanceof ReadableStream ? out : (out as any)?.body;
    if (!body) { const r = await this.generate(req); yield { delta: r.text, done: false }; yield { delta: '', done: true }; return; }
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') { yield { delta: '', done: true }; return; }
        try {
          const json = JSON.parse(data);
          const delta = json.response ?? json.choices?.[0]?.delta?.content ?? '';
          if (delta) yield { delta, done: false };
        } catch { /* partial frame */ }
      }
    }
    yield { delta: '', done: true };
  }
}

/** Every configured provider, in priority order. Adding one is a single line. */
export function buildProviders(env: Env): AIProvider[] {
  return [new NvidiaNimProvider(env), new CloudflareProvider(env), new OpenRouterProvider(env)]
    .filter((p) => p.isConfigured());
}
