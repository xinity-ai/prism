import { describe, expect, test } from 'bun:test';
import { selfConsistency } from '../../src/techniques/self-consistency.ts';
import { defaultVoter, extractFinalAnswer, normalizeAnswer } from '../../src/internal/voting.ts';
import { silentLogger } from '../../src/logging.ts';
import { pipelineRun } from '../../src/pipeline.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { ChatRequest, ModelProfile } from '../../src/types.ts';

const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'q' }] };
const defaultProfile: ModelProfile = { match: /.*/, thinkingMode: false, supportsLogprobs: false };

describe('extractFinalAnswer', () => {
  test('prefers \\boxed{...} when present', () => {
    expect(extractFinalAnswer('reasoning... \\boxed{42}')).toBe('42');
  });
  test('falls back to last fenced code block', () => {
    expect(extractFinalAnswer('analysis\n```\n7\n```')).toBe('7');
  });
  test('falls back to GSM8K #### marker', () => {
    expect(extractFinalAnswer('long reasoning #### 13')).toBe('13');
  });
  test('falls back to trimmed content', () => {
    expect(extractFinalAnswer('  just 9  ')).toBe('just 9');
  });
});

describe('normalizeAnswer', () => {
  test('lowercases and collapses whitespace and trailing punctuation', () => {
    expect(normalizeAnswer('  Hello,  World!  ')).toBe('hello world');
  });
});

describe('defaultVoter', () => {
  test('majority wins; ties broken by first-seen order', () => {
    const voter = defaultVoter();
    const a = fakeResponse('\\boxed{42}');
    const b = fakeResponse('\\boxed{43}');
    const c = fakeResponse('\\boxed{42}');
    const result = voter.vote([a, b, c]);
    expect(result.winner).toBe(a);
    expect(result.distribution).toEqual({ '42': 2, '43': 1 });
  });
});

describe('selfConsistency', () => {
  test('issues K parallel samples at elevated temperature with n=1', async () => {
    let lastTemp: number | undefined;
    let lastN: number | undefined;
    const upstream = createMockUpstream({
      complete: async (r) => {
        lastTemp = r.temperature;
        lastN = r.n;
        return fakeResponse('\\boxed{42}');
      },
    });
    await pipelineRun({
      request: { ...req, temperature: 0 },
      techniques: [selfConsistency({ k: 3 })],
      transforms: [],
      upstream,
      modelProfile: defaultProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(upstream.completeCalls).toHaveLength(3);
    expect(lastTemp).toBe(0.7);
    expect(lastN).toBe(1);
  });

  test('picks the majority answer', async () => {
    let call = 0;
    const upstream = createMockUpstream({
      complete: async () => {
        call += 1;
        if (call === 1) return fakeResponse('\\boxed{wrong}');
        return fakeResponse('\\boxed{right}');
      },
    });
    const result = await pipelineRun({
      request: req,
      techniques: [selfConsistency({ k: 3 })],
      transforms: [],
      upstream,
      modelProfile: defaultProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(result.choices[0]!.message.content).toBe('\\boxed{right}');
  });

  test('thinking-mode profile defaults k to 3 (not 5)', async () => {
    const upstream = createMockUpstream({ complete: async () => fakeResponse('\\boxed{1}') });
    await pipelineRun({
      request: req,
      techniques: [selfConsistency()],
      transforms: [],
      upstream,
      modelProfile: { match: /.*/, thinkingMode: true, supportsLogprobs: false },
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(upstream.completeCalls).toHaveLength(3);
  });

  test('k<=1 short-circuits to a single upstream call', async () => {
    const upstream = createMockUpstream({ complete: async () => fakeResponse('answer') });
    await pipelineRun({
      request: req,
      techniques: [selfConsistency({ k: 1 })],
      transforms: [],
      upstream,
      modelProfile: defaultProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(upstream.completeCalls).toHaveLength(1);
  });
});
