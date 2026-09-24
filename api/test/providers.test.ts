import { describe, it, expect, vi, afterEach } from 'vitest';
import { NvidiaNimProvider, OpenRouterProvider } from '../src/providers';
import { fakeEnv } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const modelList = (rows: Array<Record<string, unknown>>) => ({ data: rows });

function stubCatalog(rows: Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(modelList(rows)), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
}

describe('catalogue filtering (discovery-time)', () => {
  it('drops models that cannot hold a chat conversation', async () => {
    stubCatalog([
      { id: 'meta/llama-3.1-8b-instruct' },
      { id: 'meta/llama-3.2-11b-vision-instruct' },          // vision chat — stays
      { id: 'deepseek-ai/deepseek-r1-distill-qwen-32b' },    // reasoning — stays
      { id: 'nvidia/llama-3.1-nemoguard-8b-content-safety' },
      { id: 'meta/llama-guard-4-12b' },
      { id: 'nvidia/riva-translate-4b-instruct-v1.1' },
      { id: 'google/lyria-3-pro-preview' },                  // music generator
      { id: 'nvidia/ai-synthetic-video-detector' },
      { id: 'openai/whisper-large-v3' },                     // transcription
      { id: 'nvidia/nemotron-parse-2.0' },
      { id: 'google/embeddinggemma-300m' },
    ]);
    const p = new NvidiaNimProvider(fakeEnv({ NVIDIA_NIM_API_KEY: 'x' }));
    const ids = (await p.listModels()).map((m) => m.providerModelId).sort();
    expect(ids).toEqual([
      'deepseek-ai/deepseek-r1-distill-qwen-32b',
      'meta/llama-3.1-8b-instruct',
      'meta/llama-3.2-11b-vision-instruct',
    ]);
  });

  it('OpenRouter keeps free models but drops priced and non-text-output ones', async () => {
    stubCatalog([
      { id: 'vendor/good-small:free', pricing: { prompt: '0', completion: '0' } },
      { id: 'vendor/pricey', pricing: { prompt: '0.001', completion: '0.002' } },
      { id: 'google/lyria-3-clip-preview', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['audio'] } },
      { id: 'vendor/safety-guard:free', pricing: { prompt: '0', completion: '0' } },
    ]);
    const p = new OpenRouterProvider(fakeEnv({ OPENROUTER_API_KEY: 'x' }));
    const ids = (await p.listModels()).map((m) => m.providerModelId);
    expect(ids).toEqual(['vendor/good-small:free']);
  });
});

describe('empty completions are failures, not successes', () => {
  it('generate() throws instead of returning an empty string', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })));
    const p = new NvidiaNimProvider(fakeEnv({ NVIDIA_NIM_API_KEY: 'x' }));
    await expect(
      p.generate({ model: { id: 'nvidia-nim:x', providerModelId: 'x' } as any, messages: [] }),
    ).rejects.toThrow('empty completion');
  });

  it('generate() surfaces a JSON error body even at HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'rate limited upstream' } }),
      { status: 200, headers: { 'content-type': 'application/json' } })));
    const p = new NvidiaNimProvider(fakeEnv({ NVIDIA_NIM_API_KEY: 'x' }));
    await expect(
      p.generate({ model: { id: 'nvidia-nim:x', providerModelId: 'x' } as any, messages: [] }),
    ).rejects.toThrow('rate limited upstream');
  });

  it('stream() throws when an SSE data frame carries an error', async () => {
    const sse = `data: {"error": {"message": "model is warming up"}}\n\ndata: [DONE]\n\n`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })));
    const p = new NvidiaNimProvider(fakeEnv({ NVIDIA_NIM_API_KEY: 'x' }));
    const drain = async () => {
      for await (const _chunk of p.stream({ model: { id: 'nvidia-nim:x', providerModelId: 'x' } as any, messages: [] })) { /* drain */ }
    };
    await expect(drain()).rejects.toThrow('model is warming up');
  });
});
