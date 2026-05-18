import type { ChatRequest, UpstreamClient, Verifier } from '../types.ts';

export type JudgeVerifierOptions = {
  /** Upstream client used to call the judge. May be the same as the answer model. */
  upstream: UpstreamClient;
  /** Model name passed to the upstream for judging. */
  model: string;
  /** System prompt for the judge. A sensible default is provided. */
  systemPrompt?: string;
  /**
   * Builds the judge prompt body. Receives the original request and the
   * candidate's text content. Should ask the judge to reply with a number in
   * [0, 1]. The default prompt does this.
   */
  buildPrompt?: (request: ChatRequest, candidate: string) => string;
};

const DEFAULT_SYSTEM =
  'You are a strict answer-quality judge. Reply with a single number between 0 and 1 — nothing else.';

function defaultPrompt(request: ChatRequest, candidate: string): string {
  const question = request.messages
    .filter(m => m.role === 'user' && typeof m.content === 'string')
    .map(m => m.content as string)
    .join('\n\n');
  return [
    `Question:`, question,
    ``,
    `Candidate answer:`, candidate,
    ``,
    `Rate the candidate on a scale of 0 (incorrect or unhelpful) to 1 (correct and complete). Number only:`,
  ].join('\n');
}

export function judgeVerifier(options: JudgeVerifierOptions): Verifier {
  const buildPrompt = options.buildPrompt ?? defaultPrompt;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM;

  return {
    name: 'judge',
    async score(candidate, request, signal) {
      const content = candidate.choices[0]?.message.content;
      if (typeof content !== 'string') return 0;
      const judgeReq: ChatRequest = {
        model: options.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildPrompt(request, content) },
        ],
        temperature: 0,
        maxTokens: 8,
        stream: false,
      };
      const resp = await options.upstream.complete(judgeReq, signal);
      const reply = resp.choices[0]?.message.content;
      if (typeof reply !== 'string') return 0;
      const m = reply.match(/-?\d+(?:\.\d+)?/);
      if (!m) return 0;
      const value = Number.parseFloat(m[0]);
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(1, value));
    },
  };
}
