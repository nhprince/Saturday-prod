/* ============================================================
   Saturday — shared domain types
   ============================================================ */

export interface Env {
  REGISTRY: KVNamespace;
  DB: D1Database;
  AI?: Ai;

  NVIDIA_NIM_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  CLOUDFLARE_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ADMIN_TOKEN_SECRET?: string;
  ADMIN_PASSWORD?: string;

  ALLOWED_ORIGINS: string;
  HEALTH_TTL_SECONDS: string;
  HEALTH_PROBE_BUDGET: string;
}

export type HealthState =
  | 'WORKING' | 'DEGRADED' | 'RATE_LIMITED' | 'AUTH_FAILED'
  | 'NOT_FOUND' | 'UNSUPPORTED' | 'TIMEOUT' | 'ERROR' | 'UNKNOWN';

export type ModelStatus = 'available' | 'degraded' | 'unavailable' | 'unknown';

export interface Capabilities {
  text: boolean;
  vision: boolean;
  tools: boolean;
  reasoning?: boolean;
  json?: boolean;
}

export interface AIModel {
  id: string;                 // provider-qualified, e.g. "nvidia-nim:meta/llama-3.1-8b-instruct"
  providerModelId: string;    // the id the provider itself expects
  provider: string;
  displayName: string;
  family?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: Capabilities;
  free: boolean;
  tier: 'small' | 'medium' | 'large';
  status: ModelStatus;
  latencyMs?: number;
  lastCheckedAt?: string;
  raw?: unknown;              // provider-specific metadata, preserved
}

export interface ModelHealth {
  modelId: string;
  state: HealthState;
  status: ModelStatus;
  latencyMs?: number;
  checkedAt: number;
  failures: number;
  cooldownUntil: number;
  message?: string;
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

export interface AIRequest {
  model: AIModel;
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
}

export interface AIResponse {
  text: string;
  model: string;
  provider: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  finishReason?: string;
}

export interface AIStreamChunk {
  delta: string;
  done: boolean;
  finishReason?: string;
}

export interface RoutingDecision {
  mode: 'manual' | 'free' | 'smart';
  modelId: string;
  provider: string;
  signals: string[];
  requires: Partial<Capabilities> & { contextChars?: number };
  reason: string;
  candidates: string[];
  fallbackFrom?: string;
}

/** Every provider implements exactly this. Adding one never touches the router. */
export interface AIProvider {
  readonly id: string;
  readonly name: string;
  /** False when the required secrets are absent — the provider is then never offered. */
  isConfigured(): boolean;
  listModels(): Promise<AIModel[]>;
  /** A cheap validation where the provider supports one; a 1-token completion otherwise. */
  healthCheck(model: AIModel, signal?: AbortSignal): Promise<{ state: HealthState; latencyMs: number; message?: string }>;
  generate(req: AIRequest): Promise<AIResponse>;
  stream(req: AIRequest): AsyncIterable<AIStreamChunk>;
}

export class ProviderError extends Error {
  constructor(
    public state: HealthState,
    message: string,
    public status?: number,
    public retryable = false,
  ) { super(message); this.name = 'ProviderError'; }
}

/** Maps an HTTP status onto a health state so every provider classifies alike. */
export function stateFromStatus(status: number): HealthState {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 422 || status === 400) return 'UNSUPPORTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'ERROR';
  return 'ERROR';
}
export const isRetryable = (s: HealthState) =>
  s === 'RATE_LIMITED' || s === 'TIMEOUT' || s === 'ERROR' || s === 'DEGRADED';
