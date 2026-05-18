/**
 * HTTP server use — start a Bun.serve gateway that exposes
 * `POST /v1/chat/completions` and forwards to a configured upstream. Clients
 * request techniques per-call via the `X-Xinity-*` headers.
 *
 * Run with: bun run examples/server.ts
 * Then in another shell:
 *
 *   curl -N -H 'content-type: application/json' \
 *        -H 'x-xinity-techniques: self-consistency:k=3' \
 *        -H 'x-xinity-plugins: privacy' \
 *        -d '{"model":"…","messages":[{"role":"user","content":"hi"}]}' \
 *        http://localhost:4000/v1/chat/completions
 */
import {
  createGateway,
  selfConsistency,
  bestOfN,
  roundTrip,
  privacy,
  readUrls,
  regexVerifier,
} from '../src/index.ts';

const baseUrl = process.env.LLM_BASE_URL!;
const apiKey = process.env.LLM_API_KEY!;
const model = process.env.LLM_MODEL_SPECIFIER!;
if (!baseUrl || !apiKey || !model) {
  console.error('Set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL_SPECIFIER in .env.');
  process.exit(1);
}

const gateway = createGateway({
  upstream: { baseUrl, apiKey, timeoutMs: 90_000 },
  modelProfiles: [
    { match: /qwen3|deepseek-r1|thinking/i, thinkingMode: true, supportsLogprobs: false, contextWindow: 32_000 },
    { match: /.*/, thinkingMode: false, supportsLogprobs: false },
  ],
  registry: {
    techniques: new Map<string, (options?: unknown) => ReturnType<typeof selfConsistency>>([
      ['self-consistency', (o) => selfConsistency((o as Record<string, unknown>) ?? {})],
      ['round-trip', (o) => roundTrip((o as Record<string, unknown>) ?? {})],
      // bestOfN requires a verifier; we wire a "boxed-integer" regex example.
      ['best-of-n', (o) => bestOfN({
        ...(o as { n: number }),
        verifier: regexVerifier({ pattern: /\\boxed\{\s*-?\d+\s*\}/ }),
      })],
    ]),
    transforms: new Map([
      ['privacy', () => privacy()],
      ['read-urls', () => readUrls()],
    ]),
  },
});

const { url } = await gateway.serve({ port: Number(process.env.PORT ?? 4000) });
console.log(`example server listening on ${url}`);
console.log(`upstream: ${baseUrl}`);
console.log(`try:  curl -H 'x-xinity-techniques: self-consistency:k=3' -d '{"model":"${model}","messages":[{"role":"user","content":"What is 6*7?"}]}' ${url}/v1/chat/completions`);
