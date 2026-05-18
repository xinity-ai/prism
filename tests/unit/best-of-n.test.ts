import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { bestOfN } from '../../src/techniques/best-of-n.ts';
import { regexVerifier } from '../../src/verifiers/regex.ts';
import { jsonSchemaVerifier } from '../../src/verifiers/json-schema.ts';
import { judgeVerifier } from '../../src/verifiers/judge.ts';
import { unitTestVerifier } from '../../src/verifiers/unit-test.ts';
import { pipelineRun } from '../../src/pipeline.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { ChatRequest, ModelProfile } from '../../src/types.ts';

const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'q' }] };
const profile: ModelProfile = { match: /.*/, thinkingMode: false, supportsLogprobs: false };

describe('regexVerifier', () => {
  test('scores 1 on match, 0 on miss', async () => {
    const v = regexVerifier({ pattern: /\\boxed\{42\}/ });
    expect(await v.score(fakeResponse('\\boxed{42}'), req, new AbortController().signal)).toBe(1);
    expect(await v.score(fakeResponse('nope'), req, new AbortController().signal)).toBe(0);
  });
});

describe('jsonSchemaVerifier', () => {
  test('scores 1 when content matches schema', async () => {
    const v = jsonSchemaVerifier({ schema: z.object({ x: z.number() }) });
    expect(await v.score(fakeResponse('{"x":1}'), req, new AbortController().signal)).toBe(1);
    expect(await v.score(fakeResponse('{"x":"no"}'), req, new AbortController().signal)).toBe(0);
  });
  test('extracts JSON from a fenced block', async () => {
    const v = jsonSchemaVerifier({ schema: z.object({ x: z.number() }) });
    expect(await v.score(fakeResponse('```json\n{"x":1}\n```'), req, new AbortController().signal)).toBe(1);
  });
});

describe('judgeVerifier', () => {
  test('calls upstream and parses numeric reply', async () => {
    const upstream = createMockUpstream({ complete: async () => fakeResponse('0.83') });
    const v = judgeVerifier({ upstream, model: 'judge-m' });
    expect(await v.score(fakeResponse('candidate'), req, new AbortController().signal)).toBeCloseTo(0.83);
  });
  test('clamps to [0, 1]', async () => {
    const upstream = createMockUpstream({ complete: async () => fakeResponse('1.5') });
    const v = judgeVerifier({ upstream, model: 'judge-m' });
    expect(await v.score(fakeResponse('candidate'), req, new AbortController().signal)).toBe(1);
  });
  test('returns 0 on unparseable reply', async () => {
    const upstream = createMockUpstream({ complete: async () => fakeResponse('nope') });
    const v = judgeVerifier({ upstream, model: 'judge-m' });
    expect(await v.score(fakeResponse('candidate'), req, new AbortController().signal)).toBe(0);
  });
});

describe('unitTestVerifier', () => {
  test('without a runner, scores 0', async () => {
    const v = unitTestVerifier({ language: 'python', tests: 'assert add(1,1)==2' });
    expect(await v.score(fakeResponse('def add(a,b): return a+b'), req, new AbortController().signal)).toBe(0);
  });
  test('with a runner, scores passed/total', async () => {
    const v = unitTestVerifier({
      language: 'python', tests: 'x', runner: async () => ({ passed: 3, total: 4 }),
    });
    expect(await v.score(fakeResponse('```python\nx\n```'), req, new AbortController().signal)).toBe(0.75);
  });
});

describe('bestOfN', () => {
  test('returns the highest-scoring candidate', async () => {
    let call = 0;
    const upstream = createMockUpstream({
      complete: async () => {
        call += 1;
        return fakeResponse(call === 2 ? '\\boxed{42}' : 'nope');
      },
    });
    const result = await pipelineRun({
      request: req,
      techniques: [bestOfN({ n: 3, verifier: regexVerifier({ pattern: /\\boxed\{42\}/ }) })],
      transforms: [],
      upstream,
      modelProfile: profile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(result.choices[0]!.message.content).toBe('\\boxed{42}');
  });

  test('n=1 short-circuits to a single upstream call', async () => {
    const upstream = createMockUpstream({ complete: async () => fakeResponse('only') });
    await pipelineRun({
      request: req,
      techniques: [bestOfN({ n: 1, verifier: regexVerifier({ pattern: /.*/ }) })],
      transforms: [],
      upstream,
      modelProfile: profile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(upstream.completeCalls).toHaveLength(1);
  });
});
