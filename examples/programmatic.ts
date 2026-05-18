/**
 * Programmatic use — no HTTP server. You construct an UpstreamClient and call
 * `pipelineRun` directly with the techniques and plugins you want.
 *
 * Run with: bun run examples/programmatic.ts
 * Requires .env with LLM_API_KEY, LLM_BASE_URL, LLM_MODEL_SPECIFIER.
 */
import {
  createHttpUpstreamClient,
  pipelineRun,
  selfConsistency,
  privacy,
  createJsonLogger,
} from '../src/index.ts';
import type { ModelProfile } from '../src/index.ts';

const baseUrl = process.env.LLM_BASE_URL!;
const apiKey = process.env.LLM_API_KEY!;
const model = process.env.LLM_MODEL_SPECIFIER!;
if (!baseUrl || !apiKey || !model) {
  console.error('Set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL_SPECIFIER (Bun loads them from .env).');
  process.exit(1);
}

const upstream = createHttpUpstreamClient({ baseUrl, apiKey, timeoutMs: 60_000 });
const logger = createJsonLogger({ example: 'programmatic' });

const profile: ModelProfile = {
  match: /.*/,
  thinkingMode: /qwen3|deepseek-r1|thinking/i.test(model),
  supportsLogprobs: false,
};

const response = await pipelineRun({
  request: {
    model,
    messages: [{
      role: 'user',
      content:
        'A user account belongs to alex@xinity.ai. ' +
        'A train leaves Vienna at 14:00 going 90 km/h and another leaves Salzburg at 14:30 going 110 km/h ' +
        'toward Vienna over a 295 km route. When and where do they meet? Show your work, then put the final ' +
        'time in \\boxed{}.',
    }],
    maxTokens: 2048,
  },
  techniques: [selfConsistency({ k: 3 })],
  transforms: [privacy()],
  upstream,
  modelProfile: profile,
  logger,
  signal: AbortSignal.timeout(90_000),
});

console.log('--- final answer ---');
console.log(response.choices[0]?.message.content);
