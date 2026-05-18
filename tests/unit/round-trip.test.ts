import { describe, expect, test } from 'bun:test';
import { roundTrip } from '../../src/techniques/round-trip.ts';
import { pipelineRun } from '../../src/pipeline.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { ChatRequest, ChatResponse, EquivalenceScorer, ModelProfile } from '../../src/types.ts';

const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'what is 2+2?' }] };
const profile: ModelProfile = { match: /.*/, thinkingMode: false, supportsLogprobs: false };

function scriptedScorer(scores: number[]): EquivalenceScorer {
  let i = 0;
  return { name: 'scripted', async score() { return scores[Math.min(i++, scores.length - 1)] ?? 0; } };
}

describe('roundTrip', () => {
  test('forward call + reverse call; high score returns first forward result', async () => {
    let forwardCalls = 0;
    const upstream = createMockUpstream({
      complete: async () => {
        forwardCalls += 1;
        return fakeResponse(forwardCalls === 1 ? 'the answer is 4' : 'what is 2+2?');
      },
    });
    const result = await pipelineRun({
      request: req,
      techniques: [roundTrip({ scorer: scriptedScorer([0.95]) })],
      transforms: [],
      upstream,
      modelProfile: profile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(result.choices[0]!.message.content).toBe('the answer is 4');
    // 1 forward via next + 1 reverse via upstream.complete = 2 upstream calls total.
    expect(upstream.completeCalls).toHaveLength(2);
  });

  test('retries when score is below threshold', async () => {
    let forwardCalls = 0;
    const upstream = createMockUpstream({
      complete: async () => {
        forwardCalls += 1;
        return fakeResponse(`forward-${forwardCalls}`);
      },
    });
    await pipelineRun({
      request: req,
      techniques: [roundTrip({ scorer: scriptedScorer([0.3, 0.9]), threshold: 0.8, maxRetries: 1 })],
      transforms: [],
      upstream,
      modelProfile: profile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    // Two attempts: each does 1 forward + 1 reverse = 4 upstream calls in total.
    expect(upstream.completeCalls).toHaveLength(4);
  });

  test('returns last forward when retries exhausted', async () => {
    const upstream = createMockUpstream({
      complete: async (_r, call) => fakeResponse(`call-${call}`),
    });
    const result = await pipelineRun({
      request: req,
      techniques: [roundTrip({ scorer: scriptedScorer([0.1, 0.2]), threshold: 0.9, maxRetries: 1 })],
      transforms: [],
      upstream,
      modelProfile: profile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    // Forward calls happen at indices 0 and 2 (reverse calls between them).
    expect(result.choices[0]!.message.content).toBe('call-2');
  });
});
