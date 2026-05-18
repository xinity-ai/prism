import { describe, expect, test } from 'bun:test';
import { liveUpstream } from './_env.ts';
import { createGateway } from '../../src/index.ts';
import { silentLogger } from '../../src/logging.ts';

const live = liveUpstream();

describe('integration: live pass-through', () => {
  if (!live) {
    test.skip('skipped — set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_SPECIFIER to run', () => {});
    return;
  }

  test('non-streaming completion returns assistant content', async () => {
    const gateway = createGateway({
      upstream: { baseUrl: live.baseUrl, apiKey: live.apiKey },
      logger: silentLogger,
    });
    const resp = await gateway.fetch(new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: live.model,
        messages: [{ role: 'user', content: 'Reply with the single token: pong' }],
        max_tokens: 16,
        temperature: 0,
      }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { choices: { message: { content: string } }[] };
    expect(typeof body.choices[0]!.message.content).toBe('string');
    expect(body.choices[0]!.message.content.length).toBeGreaterThan(0);
  }, 60_000);

  test('streaming completion yields SSE chunks and [DONE]', async () => {
    const gateway = createGateway({
      upstream: { baseUrl: live.baseUrl, apiKey: live.apiKey },
      logger: silentLogger,
    });
    const resp = await gateway.fetch(new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: live.model,
        messages: [{ role: 'user', content: 'Count 1 to 3, one per line.' }],
        stream: true,
        max_tokens: 32,
        temperature: 0,
      }),
    }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const text = await resp.text();
    expect(text).toContain('data:');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  }, 60_000);
});
