import type {
  ChatRequest, ChatResponse, EquivalenceScorer, Logger, Message, Technique, TechniqueContext, UpstreamClient,
} from '../types.ts';

export type RoundTripOptions = {
  /** Score in [0, 1]. Forward result is accepted at or above this. Default 0.8. */
  threshold?: number;
  /** Max retries when score < threshold. Default 1. */
  maxRetries?: number;
  /** Custom scorer. Default: model-as-judge using ctx.upstream and the same model. */
  scorer?: EquivalenceScorer;
};

export function roundTrip(options: RoundTripOptions = {}): Technique {
  const threshold = options.threshold ?? 0.8;
  const maxRetries = options.maxRetries ?? 1;

  return {
    name: 'round-trip',
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: true,
      addsLatency: 'medium',
      tokenMultiplier: 2,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },

    async apply(ctx: TechniqueContext): Promise<ChatResponse> {
      const originalInput = extractUserInput(ctx.request);
      const scorer = options.scorer ?? modelJudgeScorer(ctx.upstream, ctx.request.model, ctx.logger);

      let lastForward: ChatResponse | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const forward = await ctx.next(ctx.request);
        lastForward = forward;
        const forwardContent = forward.choices[0]?.message.content;
        if (typeof forwardContent !== 'string' || !forwardContent.trim()) {
          // Nothing to round-trip on. Return whatever forward produced.
          return forward;
        }

        const reverseReq = buildReversePrompt(ctx.request, forwardContent);
        const reverse = await ctx.upstream.complete(reverseReq, ctx.signal);
        const reconstructedInput = reverse.choices[0]?.message.content;
        if (typeof reconstructedInput !== 'string') {
          return forward; // reverse failed; trust forward.
        }

        const score = await scorer.score(originalInput, reconstructedInput, ctx.signal);
        ctx.progress({ event: 'xinity.round-trip.score', score, threshold, attempt });
        ctx.logger.info({ event: 'round-trip.score', score, threshold, attempt });

        if (score >= threshold) return forward;
      }
      return lastForward!;
    },
  };
}

function extractUserInput(request: ChatRequest): string {
  // Concatenate user-role text content. System and assistant messages are
  // context, not the question we're trying to round-trip.
  const parts: string[] = [];
  for (const m of request.messages) {
    if (m.role !== 'user' || m.content == null) continue;
    if (typeof m.content === 'string') parts.push(m.content);
    else for (const p of m.content) { if (p.type === 'text') parts.push(p.text); }
  }
  return parts.join('\n\n');
}

function buildReversePrompt(request: ChatRequest, forwardOutput: string): ChatRequest {
  const systemMessages = request.messages.filter(m => m.role === 'system').map(m => ({ ...m }));
  const prompt: Message = {
    role: 'user',
    content:
      'Given the following answer, write the user question that this answer responds to. ' +
      'Reply with only the question — no preamble, no quotes, no commentary.\n\n' +
      `Answer:\n${forwardOutput}`,
  };
  return {
    model: request.model,
    messages: [...systemMessages, prompt],
    temperature: 0,
    maxTokens: 512,
    stream: false,
  };
}

export function modelJudgeScorer(upstream: UpstreamClient, model: string, logger: Logger): EquivalenceScorer {
  return {
    name: 'model-judge',
    async score(a, b, signal) {
      const judgeReq: ChatRequest = {
        model,
        messages: [
          { role: 'system', content: 'You are a strict semantic-similarity judge. Reply with a single number between 0 and 1.' },
          {
            role: 'user',
            content:
              `Rate how closely text B captures the same request/intent as text A. 0 = unrelated, 1 = paraphrase.\n\n` +
              `A:\n${a}\n\nB:\n${b}\n\nNumber:`,
          },
        ],
        temperature: 0,
        maxTokens: 8,
        stream: false,
      };
      const resp = await upstream.complete(judgeReq, signal);
      const content = resp.choices[0]?.message.content;
      if (typeof content !== 'string') return 0;
      const m = content.match(/-?\d+(?:\.\d+)?/);
      if (!m) {
        logger.warn({ event: 'round-trip.judge.unparseable', content });
        return 0;
      }
      const value = Number.parseFloat(m[0]);
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(1, value));
    },
  };
}
