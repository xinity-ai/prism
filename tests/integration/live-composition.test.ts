import { describe, expect, test } from 'bun:test';
import { liveUpstream } from './_env.ts';
import {
  createGateway,
  silentLogger,
  selfConsistency,
  privacy,
} from '../../src/index.ts';

const live = liveUpstream();

describe('integration: live composition via the HTTP server', () => {
  if (!live) {
    test.skip('skipped — set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_SPECIFIER to run', () => {});
    return;
  }

  test('header-driven config: self-consistency + privacy applied via X-Xinity-* headers', async () => {
    const gateway = createGateway({
      upstream: { baseUrl: live.baseUrl, apiKey: live.apiKey, timeoutMs: 90_000 },
      logger: silentLogger,
      registry: {
        techniques: new Map([['self-consistency', (options?: unknown) => selfConsistency(options as Record<string, unknown> ?? {})]]),
        transforms: new Map([['privacy', () => privacy()]]),
      },
    });

    const resp = await gateway.fetch(new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xinity-techniques': 'self-consistency:k=3',
        'x-xinity-plugins': 'privacy',
      },
      body: JSON.stringify({
        model: live.model,
        messages: [{
          role: 'user',
          content:
            'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? ' +
            'Reply with only the number inside \\boxed{}.',
        }],
        max_tokens: 1024,
        temperature: 0,
      }),
    }));

    expect(resp.status).toBe(200);
    const body = await resp.json() as { choices: { message: { content: string } }[] };
    const content = body.choices[0]!.message.content;
    expect(content).toContain('9');
  }, 180_000);

  test('streaming with an active non-streaming technique emits progress events then final chunk', async () => {
    const gateway = createGateway({
      upstream: { baseUrl: live.baseUrl, apiKey: live.apiKey, timeoutMs: 90_000 },
      logger: silentLogger,
      registry: {
        techniques: new Map([['self-consistency', (options?: unknown) => selfConsistency(options as Record<string, unknown> ?? {})]]),
      },
    });

    const resp = await gateway.fetch(new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xinity-techniques': 'self-consistency:k=2',
      },
      body: JSON.stringify({
        model: live.model,
        messages: [{ role: 'user', content: 'What is 1+1? Single number.' }],
        max_tokens: 64,
        temperature: 0,
        stream: true,
      }),
    }));

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const text = await resp.text();
    expect(text).toContain('event: xinity.sample.complete');
    expect(text).toContain('event: xinity.voting');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  }, 180_000);
});
