/**
 * Live integration tests need an OpenAI-compatible upstream. Bun loads `.env`
 * automatically; any of the three vars below may be unset in CI, in which case
 * the helper signals "skip" so the test files can decide what to do.
 */
export type LiveUpstream = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function liveUpstream(): LiveUpstream | null {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL_SPECIFIER;
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}
