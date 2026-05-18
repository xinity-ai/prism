/**
 * Composing techniques and plugins by hand.
 *
 * Demonstrates the architectural shape: techniques nest via `next` (outermost
 * wraps innermost), plugins transform request/response around the chain. This
 * file shows how to compose them without the HTTP server — useful for batch
 * jobs, evaluation harnesses, and integrations that don't need network I/O.
 *
 * Run with: bun run examples/composition.ts
 */
import { z } from 'zod';
import {
  createHttpUpstreamClient,
  pipelineRun,
  selfConsistency,
  bestOfN,
  json,
  privacy,
  jsonSchemaVerifier,
  silentLogger,
} from '../src/index.ts';
import type { ModelProfile } from '../src/index.ts';

const baseUrl = process.env.LLM_BASE_URL!;
const apiKey = process.env.LLM_API_KEY!;
const model = process.env.LLM_MODEL_SPECIFIER!;
if (!baseUrl || !apiKey || !model) {
  console.error('Set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL_SPECIFIER in .env.');
  process.exit(1);
}

const upstream = createHttpUpstreamClient({ baseUrl, apiKey, timeoutMs: 90_000 });
const profile: ModelProfile = {
  match: /.*/,
  thinkingMode: /qwen3|deepseek-r1|thinking/i.test(model),
  supportsLogprobs: false,
};

// 1) JSON schema we want the answer to satisfy.
const PlaceSchema = z.object({
  city: z.string(),
  country: z.string(),
  population: z.number(),
});

console.log('=== Composition A: Self-Consistency + privacy + json (post-validate) ===');
const a = await pipelineRun({
  request: {
    model,
    messages: [{
      role: 'user',
      content:
        'Customer alex@xinity.ai asked: "Tell me about Vienna". Reply with ONLY a JSON object ' +
        'with keys "city" (string), "country" (string), "population" (number). No prose, no code fences.',
    }],
    maxTokens: 512,
    temperature: 0,
  },
  techniques: [selfConsistency({ k: 3 })],
  transforms: [privacy(), json({ schema: PlaceSchema, retries: 1 })],
  upstream,
  modelProfile: profile,
  logger: silentLogger,
  signal: AbortSignal.timeout(120_000),
});
console.log(a.choices[0]?.message.content);

console.log('\n=== Composition B: Best-of-N where the verifier IS the JSON schema ===');
const b = await pipelineRun({
  request: {
    model,
    messages: [{
      role: 'user',
      content:
        'Reply with ONLY a JSON object describing Salzburg with keys "city", "country", "population". No prose.',
    }],
    maxTokens: 512,
    temperature: 0.4,
  },
  techniques: [bestOfN({ n: 3, verifier: jsonSchemaVerifier({ schema: PlaceSchema }) })],
  transforms: [],
  upstream,
  modelProfile: profile,
  logger: silentLogger,
  signal: AbortSignal.timeout(120_000),
});
console.log(b.choices[0]?.message.content);
