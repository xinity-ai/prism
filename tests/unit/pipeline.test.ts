import { describe, expect, test } from 'bun:test';
import { pipelineRun } from '../../src/pipeline.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import { GatewayError } from '../../src/types.ts';
import type { ChatRequest, ModelProfile, Technique, Transform } from '../../src/types.ts';

const baseRequest: ChatRequest = { model: 'mock', messages: [{ role: 'user', content: 'hi' }] };
const defaultProfile: ModelProfile = { match: /.*/, thinkingMode: false, supportsLogprobs: false };

function passThroughTechnique(name: string, hook?: () => void): Technique {
  return {
    name,
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: true,
      addsLatency: 'low',
      tokenMultiplier: 1,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },
    async apply(ctx) {
      hook?.();
      return ctx.next(ctx.request);
    },
  };
}

describe('pipelineRun composition order', () => {
  test('techniques compose outermost-first, innermost calls upstream', async () => {
    const callOrder: string[] = [];
    const upstream = createMockUpstream({
      complete: async () => { callOrder.push('upstream'); return fakeResponse('done'); },
    });
    const outer = passThroughTechnique('outer', () => callOrder.push('outer'));
    const inner = passThroughTechnique('inner', () => callOrder.push('inner'));

    await pipelineRun({
      request: baseRequest,
      techniques: [outer, inner],
      transforms: [],
      upstream,
      modelProfile: defaultProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });

    expect(callOrder).toEqual(['outer', 'inner', 'upstream']);
  });

  test('pre-transforms run in registration order, post-transforms in reverse', async () => {
    const order: string[] = [];
    const t1: Transform = {
      name: 't1',
      async pre(req) { order.push('t1.pre'); return req; },
      async post(resp) { order.push('t1.post'); return resp; },
    };
    const t2: Transform = {
      name: 't2',
      async pre(req) { order.push('t2.pre'); return req; },
      async post(resp) { order.push('t2.post'); return resp; },
    };
    const upstream = createMockUpstream({ complete: async () => fakeResponse('ok') });

    await pipelineRun({
      request: baseRequest,
      techniques: [],
      transforms: [t1, t2],
      upstream,
      modelProfile: defaultProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });

    expect(order).toEqual(['t1.pre', 't2.pre', 't2.post', 't1.post']);
  });
});

describe('pipelineRun capability gate', () => {
  test('throws 400 when a technique requires logprobs and the profile does not support them', async () => {
    const needsLogprobs: Technique = {
      name: 'deep-conf',
      capabilities: {
        requiresLogprobs: true,
        supportsStreaming: false,
        addsLatency: 'high',
        tokenMultiplier: 16,
        worksWithThinkingMode: true,
        subsumedByThinkingMode: false,
      },
      async apply(ctx) { return ctx.next(ctx.request); },
    };
    const upstream = createMockUpstream({ complete: async () => fakeResponse('x') });
    await expect(pipelineRun({
      request: baseRequest,
      techniques: [needsLogprobs],
      transforms: [],
      upstream,
      modelProfile: { match: /.*/, thinkingMode: false, supportsLogprobs: false },
      logger: silentLogger,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(GatewayError);
  });

  test('skips technique when subsumed by thinking mode', async () => {
    let called = false;
    const subsumed: Technique = {
      name: 'cot-reflection',
      capabilities: {
        requiresLogprobs: false,
        supportsStreaming: false,
        addsLatency: 'low',
        tokenMultiplier: 1,
        worksWithThinkingMode: false,
        subsumedByThinkingMode: true,
      },
      async apply(ctx) { called = true; return ctx.next(ctx.request); },
    };
    const upstream = createMockUpstream({ complete: async () => fakeResponse('ok') });
    await pipelineRun({
      request: baseRequest,
      techniques: [subsumed],
      transforms: [],
      upstream,
      modelProfile: { match: /.*/, thinkingMode: true, supportsLogprobs: false },
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(called).toBe(false);
  });
});

describe('pipelineRun abort propagation', () => {
  test('aborted signal during pre-transform throws GatewayError 499', async () => {
    const controller = new AbortController();
    const slow: Transform = {
      name: 'slow',
      async pre(req) {
        controller.abort();
        return req;
      },
    };
    const upstream = createMockUpstream({ complete: async () => fakeResponse('x') });
    await expect(pipelineRun({
      request: baseRequest,
      techniques: [],
      transforms: [slow],
      upstream,
      modelProfile: defaultProfile,
      logger: silentLogger,
      signal: controller.signal,
    })).rejects.toMatchObject({ statusCode: 499 });
  });
});
