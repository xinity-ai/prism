import { defaultVoter } from '../internal/voting.ts';
import type { ChatRequest, ChatResponse, Technique, TechniqueContext, Voter } from '../types.ts';

export type SelfConsistencyOptions = {
  /** Number of independent samples. Default 5, or 3 if the model profile has thinkingMode=true. */
  k?: number;
  /** Sampling temperature. Default max(0.7, request.temperature). */
  temperature?: number;
  /** Custom voter. Defaults to majority vote on the extracted final answer. */
  voter?: Voter;
};

export function selfConsistency(options: SelfConsistencyOptions = {}): Technique {
  const voter = options.voter ?? defaultVoter();

  return {
    name: 'self-consistency',
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: false,
      addsLatency: 'medium',
      tokenMultiplier: options.k ?? 5,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },

    async apply(ctx: TechniqueContext): Promise<ChatResponse> {
      const k = options.k ?? (ctx.modelProfile.thinkingMode ? 3 : 5);
      if (k <= 1) return ctx.next(ctx.request);

      const sampleTemp = options.temperature ?? Math.max(0.7, ctx.request.temperature ?? 0);
      if (ctx.request.n && ctx.request.n > 1) {
        ctx.logger.warn({ event: 'self-consistency.n-overridden', requested: ctx.request.n, k });
      }
      const sampledReq: ChatRequest = { ...ctx.request, temperature: sampleTemp, n: 1, stream: false };

      const candidates: ChatResponse[] = await Promise.all(
        Array.from({ length: k }, (_, i) => ctx.next(sampledReq).then(r => {
          ctx.progress({ event: 'xinity.sample.complete', index: i, of: k });
          return r;
        })),
      );

      const { winner, distribution } = voter.vote(candidates);
      const winnerKey = Object.entries(distribution).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      ctx.progress({ event: 'xinity.voting', distribution, winner: winnerKey });
      ctx.logger.info({ event: 'self-consistency.vote', k, distribution, winner: winnerKey });
      return winner;
    },
  };
}
