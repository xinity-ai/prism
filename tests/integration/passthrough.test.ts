import { describe, expect, test } from 'bun:test';
import { createGateway } from '../../src/index.ts';
import { silentLogger } from '../../src/logging.ts';

const UPSTREAM = process.env.XINITY_TEST_UPSTREAM;
const MODEL = process.env.XINITY_TEST_MODEL ?? 'llama3.2:1b';

const integrationTest = UPSTREAM ? test : test.skip;

describe('integration: transparent pass-through against a real upstream', () => {
  if (!UPSTREAM) {
    test.skip('skipped — set XINITY_TEST_UPSTREAM=http://localhost:11434/v1 to run', () => {});
    return;
  }

  integrationTest('non-streaming response body matches direct upstream call byte-for-byte', async () => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'reply with the single word: hello' }],
      max_tokens: 8,
      temperature: 0,
      seed: 0,
    });

    const direct = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const directText = await direct.text();

    const gateway = createGateway({
      upstream: { baseUrl: UPSTREAM! },
      logger: silentLogger,
    });
    const viaGateway = await gateway.fetch(new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }));
    const gatewayText = await viaGateway.text();

    // Real upstreams stamp non-deterministic fields (id, created, system_fingerprint).
    // We assert that the structural shape and content match by normalising those.
    const normalise = (text: string) =>
      text.replace(/"id":"[^"]+"/g, '"id":"X"')
        .replace(/"created":\d+/g, '"created":0')
        .replace(/"system_fingerprint":"[^"]+"/g, '"system_fingerprint":"X"');
    expect(normalise(gatewayText)).toBe(normalise(directText));
  });
});
