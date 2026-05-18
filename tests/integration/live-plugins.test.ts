import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { liveUpstream } from './_env.ts';
import {
  createHttpUpstreamClient,
  pipelineRun,
  silentLogger,
  privacy,
  readUrls,
  json,
} from '../../src/index.ts';
import type { ChatRequest, ModelProfile } from '../../src/types.ts';

const live = liveUpstream();
const liveProfile: ModelProfile = { match: /.*/, thinkingMode: false, supportsLogprobs: false };

describe('integration: live plugins', () => {
  if (!live) {
    test.skip('skipped — set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_SPECIFIER to run', () => {});
    return;
  }
  const upstream = createHttpUpstreamClient({ baseUrl: live.baseUrl, apiKey: live.apiKey, timeoutMs: 90_000 });

  test('privacy: PII never reaches upstream; placeholders survive round-trip', async () => {
    const request: ChatRequest = {
      model: live.model,
      messages: [{
        role: 'user',
        content:
          'A customer record contains email alex@xinity.ai and IBAN AT611904300234573201. ' +
          'Summarize what fields are present. Reference each field by its bracketed identifier exactly as it appears.',
      }],
      maxTokens: 256,
      temperature: 0,
    };

    let leakedPii = false;
    let placeholdersSeenUpstream = 0;
    const spied = {
      complete: (req: ChatRequest, signal: AbortSignal) => {
        for (const m of req.messages) {
          const text = typeof m.content === 'string' ? m.content : '';
          if (text.includes('alex@xinity.ai') || text.includes('AT611904300234573201')) leakedPii = true;
          if (text.includes('[XINITY_PII_EMAIL_0]')) placeholdersSeenUpstream += 1;
        }
        return upstream.complete(req, signal);
      },
      stream: upstream.stream.bind(upstream),
      raw: upstream.raw.bind(upstream),
    };

    const result = await pipelineRun({
      request,
      techniques: [],
      transforms: [privacy()],
      upstream: spied,
      modelProfile: liveProfile,
      logger: silentLogger,
      signal: AbortSignal.timeout(60_000),
    });

    // Primary guarantee: raw PII never crossed the boundary.
    expect(leakedPii).toBe(false);
    // Secondary: the upstream did see a placeholder (otherwise the redaction
    // path may not have run at all).
    expect(placeholdersSeenUpstream).toBeGreaterThan(0);
    // The response is either prose mentioning the placeholder (which restoration
    // converts back to the original) or the model refused — both are fine. We
    // only assert that no placeholder leaks out unrestored.
    const content = result.choices[0]!.message.content as string;
    expect(content).not.toContain('[XINITY_PII_');
  }, 90_000);

  test('json: enforces a Zod schema via the two-pass reformat path', async () => {
    const schema = z.object({ city: z.string(), population: z.number() });
    const request: ChatRequest = {
      model: live.model,
      messages: [{
        role: 'user',
        content: 'Tell me about Vienna, Austria. Mention its population.',
      }],
      maxTokens: 512,
      temperature: 0,
    };
    const result = await pipelineRun({
      request,
      techniques: [],
      transforms: [json({ schema, retries: 2 })],
      upstream,
      modelProfile: liveProfile,
      logger: silentLogger,
      signal: AbortSignal.timeout(90_000),
    });
    const content = result.choices[0]!.message.content as string;
    const parsed = schema.safeParse(JSON.parse(content));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.city.toLowerCase()).toContain('vien');
    }
  }, 120_000);

  test('read-urls: fetches a URL and the model uses it in its answer', async () => {
    // example.com is stable, tiny, and has a recognisable phrase. We assert
    // the model echoes that phrase, proving the fetched content reached it.
    const request: ChatRequest = {
      model: live.model,
      messages: [{
        role: 'user',
        content:
          'Fetch https://example.com and quote the first sentence of the page text verbatim. ' +
          'Wrap your quoted sentence in double quotes.',
      }],
      maxTokens: 256,
      temperature: 0,
    };
    const result = await pipelineRun({
      request,
      techniques: [],
      transforms: [readUrls({ maxBytes: 50_000 })],
      upstream,
      modelProfile: liveProfile,
      logger: silentLogger,
      signal: AbortSignal.timeout(90_000),
    });
    const content = (result.choices[0]!.message.content as string).toLowerCase();
    // The model should quote some recognisable phrase from example.com — either
    // the H1 ("example domain") or the body ("documentation examples", "illustrative").
    expect(/example domain|documentation examples|illustrative examples/.test(content)).toBe(true);
  }, 120_000);
});
