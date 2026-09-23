/* ============================================================
   Saturday — browser client
   The only thing the frontend imports. It knows about Saturday's
   API and nothing about any provider, which is the point: swapping
   NVIDIA NIM for something else changes no frontend code.

   Usage:

     const sat = new SaturdayClient('https://saturday.you.workers.dev', 'user-id');
     const { id } = await sat.createConversation('My chat');
     const text = await sat.chat([{ role: 'user', content: 'Hello' }], 'smart', {
       onRouting: (r) => console.log('answered by', r.modelId),
       onDelta: (delta, whole) => render(whole),
     });
     await sat.addMessages(id, [
       { role: 'user', content: 'Hello' },
       { role: 'assistant', content: text },
     ]);
   ============================================================ */

export interface Model {
  id: string; provider: string; displayName: string;
  contextWindow?: number;
  capabilities: { text: boolean; vision: boolean; tools: boolean; reasoning?: boolean; json?: boolean };
  status: 'available' | 'degraded' | 'unavailable' | 'unknown';
  latencyMs?: number; lastCheckedAt?: string; free: boolean;
  tier: 'small' | 'medium' | 'large';
}

export interface Routing {
  mode: 'manual' | 'free' | 'smart';
  modelId: string; provider: string;
  signals: string[]; reason: string; candidates: string[];
  fallbackFrom?: string;
}

export interface StreamHandlers {
  onRouting?(r: Routing): void;            // fires before the first token, and again on fallback
  onDelta?(delta: string, whole: string): void;
  onDone?(info: { modelId: string; latencyMs: number }): void;
  onError?(e: { code: string; message: string }): void;
}

export class SaturdayClient {
  constructor(private base: string, private userId = 'local') {}

  private headers(extra: Record<string, string> = {}) {
    return { 'content-type': 'application/json', 'x-saturday-user': this.userId, ...extra };
  }

  async providers() {
    const r = await fetch(`${this.base}/api/providers`, { headers: this.headers() });
    const data = (await r.json()) as { providers: Array<{ id: string; name: string; configured: boolean }> };
    return data.providers;
  }

  async models(availableOnly = true): Promise<Model[]> {
    const r = await fetch(`${this.base}/api/models${availableOnly ? '/available' : ''}`, { headers: this.headers() });
    const data = (await r.json()) as { models: Model[] };
    return data.models;
  }

  async health() {
    const r = await fetch(`${this.base}/api/models/health`, { headers: this.headers() });
    const data = (await r.json()) as { health: unknown };
    return data.health;
  }

  /** Streams a reply. `model` is 'smart', 'free', or a model id. */
  async chat(
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: unknown }>,
    model: string,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await fetch(`${this.base}/api/chat/stream`, {
      method: 'POST', headers: this.headers(), signal,
      body: JSON.stringify({ messages, model }),
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({ error: 'upstream_error' }))) as { error?: string; message?: string };
      handlers.onError?.({ code: body.error ?? 'upstream_error', message: body.message ?? 'Request failed' });
      return '';
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '', whole = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const dataLine = frame.match(/^data: (.+)$/m)?.[1];
        if (!event || !dataLine) continue;
        const data = JSON.parse(dataLine);
        if (event === 'routing') handlers.onRouting?.(data);
        else if (event === 'delta') { whole += data.delta; handlers.onDelta?.(data.delta, whole); }
        else if (event === 'done') handlers.onDone?.(data);
        else if (event === 'error') handlers.onError?.(data);
      }
    }
    return whole;
  }

  /* ---- conversations ---- */
  listConversations() { return fetch(`${this.base}/api/conversations`, { headers: this.headers() }).then((r) => r.json()); }
  getConversation(id: string) { return fetch(`${this.base}/api/conversations/${id}`, { headers: this.headers() }).then((r) => r.json()); }
  createConversation(title?: string) {
    return fetch(`${this.base}/api/conversations`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ title }) }).then((r) => r.json());
  }
  updateConversation(id: string, patch: Record<string, unknown>) {
    return fetch(`${this.base}/api/conversations/${id}`, { method: 'PATCH', headers: this.headers(), body: JSON.stringify(patch) }).then((r) => r.json());
  }
  /** Append messages to a conversation. `id` on a message makes the write an
      upsert, so retries and regenerated answers converge instead of duplicating. */
  addMessages(id: string, messages: Array<{ id?: string; role: 'user' | 'assistant'; content: string; routing?: unknown; createdAt?: number }>) {
    return fetch(`${this.base}/api/conversations/${id}/messages`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ messages }) }).then((r) => r.json());
  }
  deleteConversation(id: string) {
    return fetch(`${this.base}/api/conversations/${id}`, { method: 'DELETE', headers: this.headers() }).then((r) => r.json());
  }
  search(q: string) {
    return fetch(`${this.base}/api/search?q=${encodeURIComponent(q)}`, { headers: this.headers() }).then((r) => r.json());
  }
}
