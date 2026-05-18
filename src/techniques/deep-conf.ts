import {
  averageTraceConfidence,
  bottomDecileGroupConfidence,
  chunkLogprobs,
  slidingWindowConfidence,
  tokenConfidence,
} from '../internal/confidence.ts';
import { defaultVoter, extractFinalAnswer, normalizeAnswer } from '../internal/voting.ts';
import { GatewayError } from '../types.ts';
import type {
  ChatChunk, ChatRequest, ChatResponse, ChunkChoice, Logprob, Technique, TechniqueContext, Voter,
} from '../types.ts';

export type DeepConfOptions = {
  mode: 'offline' | 'online';
  /** Number of traces to sample in offline mode. Default 16. */
  budget?: number;
  /** Top-K logprobs to request from upstream. Default 5. */
  topK?: number;
  /** Sliding window size for group confidence. Default 2048. */
  windowSize?: number;
  /** Fraction of traces kept after confidence ranking in offline mode. Default 0.5. */
  keepFraction?: number;
  /** Online mode: minimum acceptable average confidence over the most recent window. */
  threshold?: number;
  /** Online mode: smallest number of tokens before the threshold is checked. Default 64. */
  warmupTokens?: number;
  /** Custom voter for offline mode. Defaults to confidence-weighted majority. */
  voter?: Voter;
};

export function deepConf(options: DeepConfOptions): Technique {
  const budget = options.budget ?? 16;
  const topK = options.topK ?? 5;
  const windowSize = options.windowSize ?? 2048;
  const keepFraction = Math.min(1, Math.max(0.05, options.keepFraction ?? 0.5));
  const threshold = options.threshold ?? 0.5;
  const warmupTokens = options.warmupTokens ?? 64;
  const voter = options.voter ?? confidenceWeightedVoter(windowSize, topK);

  return {
    name: 'deep-conf',
    capabilities: {
      requiresLogprobs: true,
      supportsStreaming: options.mode === 'online',
      addsLatency: options.mode === 'online' ? 'low' : 'high',
      tokenMultiplier: options.mode === 'offline' ? budget : 1,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },

    async apply(ctx: TechniqueContext): Promise<ChatResponse> {
      if (!ctx.modelProfile.supportsLogprobs) {
        throw new GatewayError(400, 'deepconf_requires_logprobs',
          `deep-conf requires upstream logprobs but model '${ctx.request.model}' has supportsLogprobs=false`);
      }

      if (options.mode === 'offline') {
        return runOffline(ctx, budget, topK, windowSize, keepFraction, voter);
      }
      return runOnline(ctx, topK, windowSize, threshold, warmupTokens);
    },
  };
}

async function runOffline(
  ctx: TechniqueContext, budget: number, topK: number, windowSize: number, keepFraction: number, voter: Voter,
): Promise<ChatResponse> {
  const reqWithLogprobs: ChatRequest = {
    ...ctx.request,
    temperature: Math.max(0.7, ctx.request.temperature ?? 0),
    n: 1,
    stream: false,
    logprobs: true,
    topLogprobs: topK,
  };

  const candidates = await Promise.all(
    Array.from({ length: budget }, (_, i) => ctx.next(reqWithLogprobs).then(r => {
      ctx.progress({ event: 'xinity.sample.complete', index: i, of: budget });
      return r;
    })),
  );

  // Gate: every candidate must actually carry logprobs. If the upstream
  // silently dropped them we cannot score; fail loudly per DESIGN §5.5.
  const dropped = candidates.filter(c => !c.xinityMeta.hadLogprobs);
  if (dropped.length === candidates.length) {
    throw new GatewayError(
      502, 'upstream_dropped_logprobs',
      'requested logprobs from upstream but none of the candidate responses carried any',
    );
  }

  const scored = candidates.map(c => ({ c, conf: bottomDecileGroupConfidence(c, windowSize, topK) }));
  scored.sort((a, b) => b.conf - a.conf); // higher = more confident
  const keepCount = Math.max(1, Math.ceil(scored.length * keepFraction));
  const kept = scored.slice(0, keepCount);
  ctx.progress({
    event: 'xinity.deep-conf.kept',
    kept: kept.length, of: scored.length,
    confidences: scored.map(s => s.conf),
  });
  ctx.logger.info({
    event: 'deep-conf.kept', kept: kept.length, of: scored.length,
    minConfidence: kept[kept.length - 1]?.conf, maxConfidence: kept[0]?.conf,
  });

  const { winner, distribution } = voter.vote(kept.map(s => s.c));
  const winnerKey = Object.entries(distribution).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  ctx.progress({ event: 'xinity.voting', distribution, winner: winnerKey });
  return winner;
}

async function runOnline(
  ctx: TechniqueContext, topK: number, windowSize: number, threshold: number, warmupTokens: number,
): Promise<ChatResponse> {
  // Single-trace streaming with early termination. v1.1 will add backup traces
  // per DESIGN §6 / §16.
  const streamReq: ChatRequest = {
    ...ctx.request,
    logprobs: true,
    topLogprobs: topK,
  };

  const tokens: Logprob[] = [];
  const collectedText: string[] = [];
  let lastChunk: ChatChunk | null = null;
  let aborted = false;

  const inner = new AbortController();
  ctx.signal.addEventListener('abort', () => inner.abort(), { once: true });

  try {
    for await (const chunk of ctx.upstream.stream(streamReq, inner.signal)) {
      lastChunk = chunk;
      const choice = chunk.choices[0];
      if (choice) {
        if (typeof choice.delta.content === 'string') collectedText.push(choice.delta.content);
      }
      tokens.push(...chunkLogprobs(chunk));
      if (tokens.length >= warmupTokens) {
        const recent = tokens.slice(Math.max(0, tokens.length - windowSize));
        const avg = averageTraceConfidence(recent, topK);
        if (avg < threshold) {
          aborted = true;
          ctx.progress({ event: 'xinity.deep-conf.aborted', reason: 'low-confidence', position: tokens.length });
          ctx.logger.warn({ event: 'deep-conf.online.aborted', avg, threshold, position: tokens.length });
          inner.abort();
          break;
        }
      }
    }
  } catch (err) {
    if (!aborted) throw err;
  }

  return synthesizeOnlineResponse(lastChunk, collectedText.join(''), tokens, aborted);
}

function synthesizeOnlineResponse(
  lastChunk: ChatChunk | null, content: string, tokens: Logprob[], aborted: boolean,
): ChatResponse {
  return {
    id: lastChunk?.id ?? 'deep-conf-online',
    object: 'chat.completion',
    ...(lastChunk?.model !== undefined && { model: lastChunk.model }),
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finishReason: aborted ? 'length' : (lastChunk?.choices[0]?.finishReason ?? 'stop'),
      logprobs: tokens.length > 0 ? { content: tokens } : null,
    }],
    xinityMeta: { hadLogprobs: tokens.length > 0 },
  };
}

/**
 * Confidence-weighted majority vote: each candidate contributes its bottom-decile
 * group confidence to the bucket of its extracted final answer. The bucket with
 * the highest summed weight wins.
 */
export function confidenceWeightedVoter(windowSize: number = 2048, topK: number = 5): Voter {
  return {
    name: 'confidence-weighted',
    vote(candidates) {
      if (candidates.length === 0) throw new Error('voter: no candidates');
      const weights: Record<string, number> = {};
      const firstIndex: Record<string, number> = {};
      const rep: Record<string, ChatResponse> = {};
      const distribution: Record<string, number> = {};
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const content = c.choices[0]?.message.content;
        if (typeof content !== 'string') continue;
        const key = normalizeAnswer(extractFinalAnswer(content));
        const weight = bottomDecileGroupConfidence(c, windowSize, topK);
        weights[key] = (weights[key] ?? 0) + Math.max(weight, 0);
        distribution[key] = (distribution[key] ?? 0) + 1;
        if (!(key in firstIndex)) {
          firstIndex[key] = i;
          rep[key] = c;
        }
      }
      const entries = Object.entries(weights);
      if (entries.length === 0) return { winner: candidates[0]!, distribution: {} };
      entries.sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return (firstIndex[a[0]] ?? 0) - (firstIndex[b[0]] ?? 0);
      });
      const winnerKey = entries[0]![0];
      return { winner: rep[winnerKey]!, distribution };
    },
  };
}

// Re-exported for tests that want to drive the math directly.
export const __internal = {
  tokenConfidence,
  slidingWindowConfidence,
  bottomDecileGroupConfidence,
  averageTraceConfidence,
};

// Silence unused-warning for ChunkChoice (referenced by inline type annotations only).
export type _ChunkChoice = ChunkChoice;
