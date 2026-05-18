import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { liveUpstream } from './_env.ts';
import {
  createHttpUpstreamClient,
  pipelineRun,
  silentLogger,
  selfConsistency,
  roundTrip,
  bestOfN,
  planSearch,
  memory,
  regexVerifier,
  jsonSchemaVerifier,
} from '../../src/index.ts';
import type { ChatRequest, ModelProfile } from '../../src/types.ts';

const live = liveUpstream();

// Qwen3-A3B is a thinking-mode reasoning model on the Xinity dev endpoint; mark
// the profile so SC drops k to 3 and so any future thinking-mode-subsumed
// techniques skip themselves.
const liveProfile: ModelProfile = {
  match: /.*/,
  thinkingMode: /qwen3|deepseek-r1|thinking/i.test(live?.model ?? ''),
  supportsLogprobs: false,
};

const TIMEOUT = 120_000;

describe('integration: live techniques', () => {
  if (!live) {
    test.skip('skipped — set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_SPECIFIER to run', () => {});
    return;
  }
  const upstream = createHttpUpstreamClient({ baseUrl: live.baseUrl, apiKey: live.apiKey, timeoutMs: 90_000 });

  const mathReq: ChatRequest = {
    model: live.model,
    messages: [{
      role: 'user',
      content:
        'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? ' +
        'Reply with only the number inside \\boxed{}.',
    }],
    maxTokens: 1024,
  };

  test('self-consistency converges on the right answer', async () => {
    const result = await pipelineRun({
      request: mathReq,
      techniques: [selfConsistency({ k: 3 })],
      transforms: [],
      upstream,
      modelProfile: liveProfile,
      logger: silentLogger,
      signal: AbortSignal.timeout(TIMEOUT - 5_000),
    });
    const content = (result.choices[0]!.message.content as string).toLowerCase();
    expect(/\b9\b|nine/.test(content)).toBe(true);
  }, TIMEOUT);

  test('round-trip with low threshold returns the forward result', async () => {
    const result = await pipelineRun({
      request: {
        model: live.model,
        messages: [{ role: 'user', content: 'In one sentence, what is photosynthesis?' }],
        maxTokens: 256,
      },
      techniques: [roundTrip({ threshold: 0.1, maxRetries: 0 })],
      transforms: [],
      upstream,
      modelProfile: liveProfile,
      logger: silentLogger,
      signal: AbortSignal.timeout(TIMEOUT - 5_000),
    });
    expect(typeof result.choices[0]!.message.content).toBe('string');
    expect((result.choices[0]!.message.content as string).length).toBeGreaterThan(20);
  }, TIMEOUT);

  test('best-of-n with regex verifier selects an answer that satisfies the pattern', async () => {
    const result = await pipelineRun({
      request: {
        model: live.model,
        messages: [{
          role: 'user',
          content: 'What is 12 * 7? Reply with only the number inside \\boxed{}.',
        }],
        maxTokens: 512,
      },
      techniques: [bestOfN({ n: 3, verifier: regexVerifier({ pattern: /\\boxed\{\s*84\s*\}/ }) })],
      transforms: [],
      upstream,
      modelProfile: liveProfile,
      logger: silentLogger,
      signal: AbortSignal.timeout(TIMEOUT - 5_000),
    });
    expect(result.choices[0]!.message.content).toMatch(/\\boxed\{\s*84\s*\}/);
  }, TIMEOUT);

  test('best-of-n with json-schema verifier returns schema-valid JSON', async () => {
    const userSchema = z.object({ name: z.string(), age: z.number() });
    const result = await pipelineRun({
      request: {
        model: live.model,
        messages: [{
          role: 'user',
          content:
            'Return ONLY a JSON object describing a fictional person with keys "name" (string) and "age" (number). ' +
            'No prose, no code fences.',
        }],
        maxTokens: 256,
      },
      techniques: [bestOfN({ n: 2, verifier: jsonSchemaVerifier({ schema: userSchema }) })],
      transforms: [],
      upstream,
      modelProfile: liveProfile,
      logger: silentLogger,
      signal: AbortSignal.timeout(TIMEOUT - 5_000),
    });
    const content = result.choices[0]!.message.content as string;
    // The best candidate should parse and match; tolerate minor surrounding whitespace.
    const trimmed = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = userSchema.safeParse(JSON.parse(trimmed));
    expect(parsed.success).toBe(true);
  }, TIMEOUT);

  test('plan-search produces a coherent answer (smoke test)', async () => {
    const result = await pipelineRun({
      request: {
        model: live.model,
        messages: [{
          role: 'user',
          content: 'List three concrete safety considerations for deploying an LLM behind a public API. One bullet each.',
        }],
        maxTokens: 1024,
      },
      techniques: [planSearch({ numPlans: 2, samplesPerPlan: 1, numObservations: 3 })],
      transforms: [],
      upstream,
      modelProfile: liveProfile,
      logger: silentLogger,
      signal: AbortSignal.timeout(TIMEOUT - 5_000),
    });
    const content = result.choices[0]!.message.content as string;
    expect(content.length).toBeGreaterThan(40);
  }, TIMEOUT * 2);

  test('memory passes short docs through unchanged', async () => {
    const result = await pipelineRun({
      request: {
        model: live.model,
        messages: [
          { role: 'user', content: 'The sky is blue because of Rayleigh scattering.' },
          { role: 'user', content: 'Why is the sky blue?' },
        ],
        maxTokens: 128,
      },
      techniques: [memory()],
      transforms: [],
      upstream,
      modelProfile: { ...liveProfile, contextWindow: 32_000 },
      logger: silentLogger,
      signal: AbortSignal.timeout(TIMEOUT - 5_000),
    });
    expect((result.choices[0]!.message.content as string).toLowerCase()).toContain('rayleigh');
  }, TIMEOUT);
});
