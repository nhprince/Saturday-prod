/* ============================================================
   Saturday — routing
   Prompt → classification → required capabilities → eligible
   models → health filter → strategy → selection → fallback.
   Provider-agnostic: nothing here names a provider.
   ============================================================ */
import { AIMessage, AIModel, Capabilities, RoutingDecision } from '../types';
import { Registry, RoutingRule } from './registry';

export interface RouteRequest {
  selection: string;          // 'smart' | 'free' | a model id
  messages: AIMessage[];
  hasImages?: boolean;
  wantsJson?: boolean;
}

interface Classification {
  signals: string[];
  requires: Partial<Capabilities> & { contextChars: number };
  want: 'small' | 'medium' | 'large';
}

const textOf = (m: AIMessage) =>
  typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(' ');

export function classify(req: RouteRequest): Classification {
  const last = req.messages.filter((m) => m.role === 'user').at(-1);
  const prompt = (last ? textOf(last) : '').toLowerCase();
  const contextChars = req.messages.reduce((n, m) => n + textOf(m).length, 0);
  const signals: string[] = [];

  const vision = !!req.hasImages;
  if (vision) signals.push('image input');

  const code = /```|\b(function|class |def |const |import |refactor|stack ?trace|compile|typescript|javascript|python|rust|sql|regex|unit test|bug)\b/.test(prompt);
  if (code) signals.push('code');

  const math = /\$\$|\\frac|\\sum|\b(integral|derivative|theorem|prove|proof|equation|solve for|matrix|eigen)\b/.test(prompt);
  if (math) signals.push('mathematics');

  const reasoning = /\b(why|analy[sz]e|compare|trade-?offs?|strategy|architect|design a|evaluate|critique|implications|step by step)\b/.test(prompt) || prompt.length > 700;
  if (reasoning) signals.push('reasoning');

  const json = !!req.wantsJson || /\bjson\b|\bschema\b|structured output/.test(prompt);
  if (json) signals.push('structured output');

  if (contextChars > 20000) signals.push('long context');
  const short = prompt.length < 140 && !code && !math && !reasoning && !json && !vision;
  if (short) signals.push('short turn');

  const want: Classification['want'] =
    math || reasoning || (code && contextChars > 2000) ? 'large' : short ? 'small' : 'medium';

  return {
    signals,
    requires: { vision, json, reasoning: reasoning || math, contextChars },
    want,
  };
}

function eligible(models: AIModel[], c: Classification): AIModel[] {
  return models.filter((m) => {
    if (c.requires.vision && !m.capabilities.vision) return false;
    if (c.requires.json && !m.capabilities.json) return false;
    if (c.requires.reasoning && !(m.capabilities.reasoning || m.tier !== 'small')) return false;
    // ~4 characters per token, with headroom for the reply.
    if (m.contextWindow && c.requires.contextChars / 4 > m.contextWindow * 0.7) return false;
    return true;
  });
}

const RANK = { small: 0, medium: 1, large: 2 } as const;

export class RouterService {
  constructor(private registry: Registry) {}

  async route(req: RouteRequest): Promise<{ decision: RoutingDecision; model: AIModel; chain: AIModel[] }> {
    const [usable, rules] = await Promise.all([this.registry.available(), this.registry.routingRules()]);
    const c = classify(req);
    let pool = eligible(usable, c);
    let unverified = false;

    if (!pool.length) {
      // Fresh deployments have no health records yet, so every model is
      // 'unknown' and available() is empty. Rather than refusing outright,
      // fall back to models we simply have not proven yet — between the
      // fallback chain and health.observe(), the first real request becomes
      // the first real health signal instead of a guaranteed 503.
      const all = await this.registry.models();
      pool = eligible(all.filter((m) => m.status === 'unknown'), c);
      unverified = pool.length > 0;
    }

    if (!pool.length) {
      const err = new Error('No compatible model is available');
      (err as any).code = 'no_model';
      throw err;
    }

    // Manual selection wins when the chosen model is still usable.
    if (req.selection !== 'smart' && req.selection !== 'free') {
      const chosen = pool.find((m) => m.id === req.selection);
      if (chosen) {
        return {
          model: chosen,
          chain: this.chainFor(chosen, pool, c),
          decision: {
            mode: 'manual', modelId: chosen.id, provider: chosen.provider,
            signals: c.signals, requires: c.requires,
            reason: 'Chosen by the user' + (unverified ? ' (not yet health-checked)' : ''),
            candidates: pool.slice(0, 8).map((m) => m.id),
          },
        };
      }
    }

    const free = req.selection === 'free';
    const sorted = free
      ? [...pool].sort((a, b) => RANK[a.tier] - RANK[b.tier] || (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9))
      : [...pool].sort((a, b) =>
          Math.abs(RANK[a.tier] - RANK[c.want]) - Math.abs(RANK[b.tier] - RANK[c.want]) ||
          (a.status === 'available' ? 0 : 1) - (b.status === 'available' ? 0 : 1) ||
          (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9));

    // Admin-authored routing rules bias Smart Router only — Free Router stays cost-first.
    const matchedRule = !free ? this.matchRule(rules, c.signals, pool) : null;
    const model = matchedRule ?? sorted[0]!;
    const chainPool = sorted.filter((m) => m.id !== model.id);

    return {
      model,
      chain: matchedRule ? [matchedRule, ...chainPool].filter((m, i, a) => a.indexOf(m) === i).slice(1, 4) : sorted.slice(1, 4),
      decision: {
        mode: free ? 'free' : 'smart',
        modelId: model.id,
        provider: model.provider,
        signals: c.signals,
        requires: c.requires,
        reason: (matchedRule
          ? `Matched routing rule for "${c.signals.find((s) => rules.some((r) => r.match_signal === s)) ?? c.signals[0]}"`
          : free
          ? 'Smallest healthy model that meets the requirements'
          : c.signals.length ? `Matched: ${c.signals.join(', ')}` : 'General request')
          + (unverified ? ' — model not yet health-checked' : ''),
        candidates: sorted.slice(0, 5).map((m) => m.id),
        ...(req.selection !== 'smart' && req.selection !== 'free' ? { fallbackFrom: req.selection } : {}),
      },
    };
  }

  /** First enabled rule (by position) whose signal fired and whose preferred model/tier is still eligible. */
  private matchRule(rules: RoutingRule[], signals: string[], pool: AIModel[]): AIModel | null {
    for (const rule of rules) {
      if (!signals.includes(rule.match_signal)) continue;
      if (rule.prefer_model) {
        const m = pool.find((x) => x.id === rule.prefer_model);
        if (m) return m;
      }
      if (rule.prefer_tier) {
        const m = pool.find((x) => x.tier === rule.prefer_tier);
        if (m) return m;
      }
    }
    return null;
  }

  /** Ordered alternatives for the fallback chain, preferring a different provider. */
  private chainFor(chosen: AIModel, pool: AIModel[], c: Classification): AIModel[] {
    return pool
      .filter((m) => m.id !== chosen.id)
      .sort((a, b) =>
        (a.provider === chosen.provider ? 1 : 0) - (b.provider === chosen.provider ? 1 : 0) ||
        Math.abs(RANK[a.tier] - RANK[c.want]) - Math.abs(RANK[b.tier] - RANK[c.want]))
      .slice(0, 3);
  }
}
