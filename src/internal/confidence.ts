import type { ChatChunk, ChatResponse, Logprob } from '../types.ts';

/**
 * Token confidence: C_t = -(1/k) Σ logP(j) for the top-k logprobs at this position.
 *
 * Higher C_t indicates a more peaked top-k distribution (the chosen token and a
 * few alternatives dominate the mass). Lower C_t means the distribution is
 * spread thin, signalling uncertainty. This matches the convention used in the
 * DeepConf paper and the optillm reference implementation.
 */
export function tokenConfidence(token: Logprob, k: number = 5): number {
  const tops = token.topLogprobs && token.topLogprobs.length > 0
    ? token.topLogprobs.slice(0, k)
    : [{ token: token.token, logprob: token.logprob, bytes: null }];
  if (tops.length === 0) return 0;
  let sum = 0;
  for (const t of tops) sum += t.logprob;
  return -sum / tops.length;
}

/**
 * Sliding-window group confidence. Returns one C_group per window-aligned
 * position; if the trace is shorter than the window, returns a single value
 * over whatever tokens are present.
 */
export function slidingWindowConfidence(tokens: Logprob[], windowSize: number = 2048, topK: number = 5): number[] {
  if (tokens.length === 0) return [];
  const tokenConfs = tokens.map(t => tokenConfidence(t, topK));
  if (tokenConfs.length <= windowSize) {
    const mean = tokenConfs.reduce((s, c) => s + c, 0) / tokenConfs.length;
    return [mean];
  }
  const groups: number[] = [];
  for (let start = 0; start + windowSize <= tokenConfs.length; start += windowSize) {
    let sum = 0;
    for (let i = start; i < start + windowSize; i++) sum += tokenConfs[i]!;
    groups.push(sum / windowSize);
  }
  return groups;
}

/**
 * Trace-level confidence used by DeepConf to rank candidates: the mean of the
 * bottom-10% of group confidences. This penalises traces with even a short
 * stretch of low-confidence tokens; consistent confidence wins.
 */
export function bottomDecileGroupConfidence(response: ChatResponse, windowSize: number = 2048, topK: number = 5): number {
  const choice = response.choices[0];
  if (!choice || !choice.logprobs || !choice.logprobs.content) return 0;
  const groups = slidingWindowConfidence(choice.logprobs.content, windowSize, topK);
  if (groups.length === 0) return 0;
  const sorted = [...groups].sort((a, b) => a - b);
  const cutoff = Math.max(1, Math.floor(sorted.length / 10));
  let sum = 0;
  for (let i = 0; i < cutoff; i++) sum += sorted[i]!;
  return sum / cutoff;
}

/** Average per-token confidence. Used as a cheap online termination signal. */
export function averageTraceConfidence(tokens: Logprob[], topK: number = 5): number {
  if (tokens.length === 0) return 0;
  let sum = 0;
  for (const t of tokens) sum += tokenConfidence(t, topK);
  return sum / tokens.length;
}

/** Pull the logprobs out of a streaming chunk if present. */
export function chunkLogprobs(chunk: ChatChunk): Logprob[] {
  const out: Logprob[] = [];
  for (const c of chunk.choices) {
    if (c.logprobs?.content) out.push(...c.logprobs.content);
  }
  return out;
}
