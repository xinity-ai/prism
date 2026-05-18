import { describe, expect, test } from 'bun:test';
import { planSearch } from '../../src/techniques/plan-search.ts';
import { regexVerifier } from '../../src/verifiers/regex.ts';
import { pipelineRun } from '../../src/pipeline.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { ChatRequest, ModelProfile } from '../../src/types.ts';

const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'p' }] };
const profile: ModelProfile = { match: /.*/, thinkingMode: false, supportsLogprobs: false };

describe('planSearch', () => {
  test('runs observation, plans, then sample-per-plan calls in the right counts', async () => {
    const responses: string[] = [
      '- observation 1\n- observation 2\n- observation 3',  // observations
      'plan-a', 'plan-b', 'plan-c',                         // 3 plans
    ];
    let i = 0;
    const upstream = createMockUpstream({
      complete: async () => fakeResponse(responses[i++] ?? '\\boxed{42}'),
    });
    const result = await pipelineRun({
      request: req,
      techniques: [planSearch({ numPlans: 3, samplesPerPlan: 1 })],
      transforms: [],
      upstream,
      modelProfile: profile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    // 1 observations + 3 plans + 3 solves (via next, which routes to upstream.complete here) = 7.
    expect(upstream.completeCalls).toHaveLength(7);
    expect(result.choices[0]!.message.content).toBe('\\boxed{42}');
  });

  test('uses the verifier when provided', async () => {
    const replies = [
      '- obs\n- obs2',
      'plan-x', 'plan-y',
    ];
    let i = 0;
    const upstream = createMockUpstream({
      complete: async () => {
        const reply = replies[i] ?? (i === 3 ? 'wrong' : '\\boxed{99}');
        i += 1;
        return fakeResponse(reply);
      },
    });
    const result = await pipelineRun({
      request: req,
      techniques: [planSearch({
        numPlans: 2,
        samplesPerPlan: 1,
        verifier: regexVerifier({ pattern: /\\boxed\{99\}/ }),
      })],
      transforms: [],
      upstream,
      modelProfile: profile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(result.choices[0]!.message.content).toBe('\\boxed{99}');
  });
});
