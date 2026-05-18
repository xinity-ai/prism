import { describe, expect, test } from 'bun:test';
import { deepConf, confidenceWeightedVoter, __internal } from '../../src/techniques/deep-conf.ts';
import { pipelineRun } from '../../src/pipeline.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream } from '../../src/internal/mock-upstream.ts';
import { GatewayError, type ChatChunk, type ChatRequest, type ChatResponse, type Logprob, type ModelProfile } from '../../src/types.ts';

const lpProfile: ModelProfile = { match: /.*/, thinkingMode: false, supportsLogprobs: true };
const baseReq: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'q' }] };

function fakeLogprobToken(token: string, logprob: number, top: number[] = []): Logprob {
  return {
    token,
    logprob,
    bytes: null,
    topLogprobs: top.length > 0 ? top.map((lp, i) => ({ token: `${token}-alt${i}`, logprob: lp, bytes: null })) : [],
  };
}

function fakeWithLogprobs(content: string, perTokenLogprobs: number[]): ChatResponse {
  const logprobTokens: Logprob[] = perTokenLogprobs.map((lp, i) => fakeLogprobToken(`t${i}`, lp, [lp, lp - 1, lp - 2]));
  return {
    id: 'r-' + content,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finishReason: 'stop',
      logprobs: { content: logprobTokens },
    }],
    xinityMeta: { hadLogprobs: true },
  };
}

/** Peaked top-k: top-1 near 0, tail very negative. Realistic "confident" shape. */
function fakeWithLogprobsPeaked(content: string, numTokens: number = 5): ChatResponse {
  const tokens: Logprob[] = Array.from({ length: numTokens }, (_, i) =>
    fakeLogprobToken(`t${i}`, -0.05, [-0.05, -4.0, -6.0]));
  return {
    id: 'r-peaked-' + content,
    choices: [{ index: 0, message: { role: 'assistant', content }, finishReason: 'stop', logprobs: { content: tokens } }],
    xinityMeta: { hadLogprobs: true },
  };
}

/** Spread top-k: top-k cluster together. Realistic "uncertain" shape. */
function fakeWithLogprobsSpread(content: string, numTokens: number = 5): ChatResponse {
  const tokens: Logprob[] = Array.from({ length: numTokens }, (_, i) =>
    fakeLogprobToken(`t${i}`, -1.0, [-1.0, -1.2, -1.5]));
  return {
    id: 'r-spread-' + content,
    choices: [{ index: 0, message: { role: 'assistant', content }, finishReason: 'stop', logprobs: { content: tokens } }],
    xinityMeta: { hadLogprobs: true },
  };
}

describe('confidence math', () => {
  test('tokenConfidence is higher for peaked distributions than spread ones', () => {
    // Peaked (confident): top-1 near 0 logprob, tail very negative.
    const peaked = fakeLogprobToken('x', -0.05, [-0.05, -4.0, -6.0]);
    // Spread (uncertain): top-k cluster together at moderately negative logprobs.
    const spread = fakeLogprobToken('y', -1.0, [-1.0, -1.2, -1.5]);
    expect(__internal.tokenConfidence(peaked)).toBeGreaterThan(__internal.tokenConfidence(spread));
  });
  test('bottomDecileGroupConfidence falls back to a single window when trace shorter than window', () => {
    const resp = fakeWithLogprobs('x', [-0.1, -0.2, -0.3]);
    const score = __internal.bottomDecileGroupConfidence(resp, 100, 3);
    expect(score).toBeGreaterThan(0);
  });
});

describe('confidenceWeightedVoter', () => {
  test('answer backed by peaked traces beats a spread minority', () => {
    // Peaked traces: top-1 logprob near 0, tail very negative → high C.
    // We pass the top-1 logprobs; the per-token helper fills topLogprobs as offsets.
    const peakedA = fakeWithLogprobsPeaked('\\boxed{42}');
    const peakedB = fakeWithLogprobsPeaked('\\boxed{42}');
    const spread = fakeWithLogprobsSpread('\\boxed{0}');
    const voter = confidenceWeightedVoter(100, 3);
    const result = voter.vote([spread, peakedA, peakedB]);
    expect(result.winner).toBe(peakedA);
  });
});

describe('deepConf offline', () => {
  test('samples budget, weights by confidence, returns the winning trace', async () => {
    let call = 0;
    const upstream = createMockUpstream({
      complete: async () => {
        call += 1;
        // First 3 calls produce a peaked (confident) trace agreeing on \\boxed{42};
        // last 2 produce spread (uncertain) traces with the wrong answer.
        if (call <= 3) return fakeWithLogprobsPeaked('\\boxed{42}');
        return fakeWithLogprobsSpread('\\boxed{99}');
      },
    });
    const result = await pipelineRun({
      request: baseReq,
      techniques: [deepConf({ mode: 'offline', budget: 5, windowSize: 10, topK: 3, keepFraction: 1 })],
      transforms: [],
      upstream,
      modelProfile: lpProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(result.choices[0]!.message.content).toBe('\\boxed{42}');
  });

  test('fails fast with 400 when model profile says supportsLogprobs=false', async () => {
    const upstream = createMockUpstream({ complete: async () => fakeWithLogprobs('x', [-0.1]) });
    await expect(pipelineRun({
      request: baseReq,
      techniques: [deepConf({ mode: 'offline', budget: 2 })],
      transforms: [],
      upstream,
      modelProfile: { match: /.*/, thinkingMode: false, supportsLogprobs: false },
      logger: silentLogger,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(GatewayError);
  });

  test('fails with 502 when upstream silently drops logprobs', async () => {
    const upstream = createMockUpstream({
      complete: async () => ({
        id: 'no-lp',
        choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finishReason: 'stop', logprobs: null }],
        xinityMeta: { hadLogprobs: false },
      }),
    });
    await expect(pipelineRun({
      request: baseReq,
      techniques: [deepConf({ mode: 'offline', budget: 2 })],
      transforms: [],
      upstream,
      modelProfile: lpProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('deepConf online', () => {
  test('streams a single trace and accumulates content', async () => {
    // Peaked tokens throughout → high C → no early abort.
    const peakedTop = [-0.05, -4.0, -6.0];
    const chunks: ChatChunk[] = [
      {
        id: 'c1', choices: [{
          index: 0,
          delta: { role: 'assistant', content: 'Hel' },
          finishReason: null,
          logprobs: { content: [fakeLogprobToken('Hel', -0.05, peakedTop)] },
        }],
        xinityMeta: { hadLogprobs: true },
      },
      {
        id: 'c1', choices: [{
          index: 0,
          delta: { content: 'lo' },
          finishReason: 'stop',
          logprobs: { content: [fakeLogprobToken('lo', -0.05, peakedTop)] },
        }],
        xinityMeta: { hadLogprobs: true },
      },
    ];
    const upstream = createMockUpstream({
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      }),
    });
    const result = await pipelineRun({
      request: baseReq,
      techniques: [deepConf({ mode: 'online', threshold: 0.0, warmupTokens: 1, topK: 3 })],
      transforms: [],
      upstream,
      modelProfile: lpProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(result.choices[0]!.message.content).toBe('Hello');
  });

  test('aborts and returns partial content when average confidence drops below threshold', async () => {
    // Start peaked (high C), then collapse to spread (low C) so avg drops below threshold.
    const peakedTop = [-0.05, -4.0, -6.0]; // C = 3.35
    const spreadTop = [-1.0, -1.2, -1.5];  // C = 1.23
    const chunks: ChatChunk[] = [
      {
        id: 'c2', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi ' }, finishReason: null,
          logprobs: { content: [fakeLogprobToken('Hi', -0.05, peakedTop)] } }],
      },
      {
        id: 'c2', choices: [{ index: 0, delta: { content: 'lo' }, finishReason: null,
          logprobs: { content: [fakeLogprobToken('lo', -1.0, spreadTop)] } }],
      },
      {
        id: 'c2', choices: [{ index: 0, delta: { content: 'wer' }, finishReason: null,
          logprobs: { content: [fakeLogprobToken('wer', -1.0, spreadTop)] } }],
      },
    ];
    const upstream = createMockUpstream({
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      }),
    });
    const result = await pipelineRun({
      // Threshold between peaked (3.35) and spread (1.23) C values; warmup short
      // enough that the threshold check fires after the second/third token.
      request: baseReq,
      techniques: [deepConf({ mode: 'online', threshold: 2.0, warmupTokens: 2, topK: 3 })],
      transforms: [],
      upstream,
      modelProfile: lpProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(result.choices[0]!.finishReason).toBe('length');
    // Should have at least the warmup tokens worth of content.
    expect(typeof result.choices[0]!.message.content).toBe('string');
  });
});
