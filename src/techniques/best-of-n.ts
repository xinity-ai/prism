import type { ChatRequest, ChatResponse, Technique, TechniqueContext, Verifier } from '../types.ts';

export type BestOfNOptions = {
  /** Number of independent samples. */
  n: number;
  /** Verifier that scores each candidate. Higher is better. */
  verifier: Verifier;
  /** Sampling temperature. Default max(0.7, request.temperature). */
  temperature?: number;
};

export function bestOfN(options: BestOfNOptions): Technique {
  if (options.n < 1) throw new Error('bestOfN: n must be >= 1');

  return {
    name: 'best-of-n',
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: false,
      addsLatency: 'high',
      tokenMultiplier: options.n,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },

    async apply(ctx: TechniqueContext): Promise<ChatResponse> {
      const n = options.n;
      if (n === 1) return ctx.next(ctx.request);

      const sampleTemp = options.temperature ?? Math.max(0.7, ctx.request.temperature ?? 0);
      const sampledReq: ChatRequest = { ...ctx.request, temperature: sampleTemp, n: 1, stream: false };

      const candidates = await Promise.all(
        Array.from({ length: n }, (_, i) => ctx.next(sampledReq).then(r => {
          ctx.progress({ event: 'xinity.sample.complete', index: i, of: n });
          return r;
        })),
      );

      const scored = await Promise.all(
        candidates.map(async (c) => ({ c, score: await options.verifier.score(c, ctx.request, ctx.signal) })),
      );
      scored.sort((a, b) => b.score - a.score);
      ctx.progress({ event: 'xinity.scores', scores: scored.map(s => s.score) });
      ctx.logger.info({ event: 'best-of-n.scores', verifier: options.verifier.name, scores: scored.map(s => s.score) });

      return scored[0]!.c;
    },
  };
}
