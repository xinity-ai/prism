import { describe, expect, test } from 'bun:test';
import { createHttpUpstreamClient } from '../../src/upstream.ts';
import { GatewayError } from '../../src/types.ts';
import type { ChatRequest } from '../../src/types.ts';

const baseRequest: ChatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('HttpUpstreamClient.complete', () => {
  test('serializes the request to OpenAI wire format and parses the response', async () => {
    let capturedBody: string | null = null;
    let capturedUrl: string | null = null;
    const client = createHttpUpstreamClient({
      baseUrl: 'http://fake/v1/',
      apiKey: 'sk-test',
      fetchImpl: async (input, _init) => {
        const req = input instanceof Request ? input : new Request(input as string);
        capturedUrl = req.url;
        capturedBody = await req.text();
        expect(req.headers.get('authorization')).toBe('Bearer sk-test');
        return jsonResponse({
          id: 'r1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        });
      },
    });
    const resp = await client.complete({ ...baseRequest, temperature: 0.5, topP: 0.9 }, new AbortController().signal);
    expect(capturedUrl as unknown as string).toBe('http://fake/v1/chat/completions');
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.model).toBe('test-model');
    expect(parsed.temperature).toBe(0.5);
    expect(parsed.top_p).toBe(0.9);
    expect(parsed.stream).toBe(false);
    expect(resp.choices[0]!.message.content).toBe('hello');
    expect(resp.xinityMeta.hadLogprobs).toBe(false);
  });

  test('marks xinityMeta.hadLogprobs=true when upstream returns logprobs', async () => {
    const client = createHttpUpstreamClient({
      baseUrl: 'http://fake/v1',
      fetchImpl: (async () => jsonResponse({
        id: 'r1',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'stop',
          logprobs: { content: [{ token: 'hi', logprob: -0.1, bytes: null }] },
        }],
      })),
    });
    const resp = await client.complete(baseRequest, new AbortController().signal);
    expect(resp.xinityMeta.hadLogprobs).toBe(true);
  });

  test('retries on 503 then succeeds', async () => {
    let calls = 0;
    const client = createHttpUpstreamClient({
      baseUrl: 'http://fake/v1',
      retries: 2,
      fetchImpl: (async () => {
        calls += 1;
        if (calls < 2) return new Response('busy', { status: 503 });
        return jsonResponse({
          id: 'r1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        });
      }),
    });
    const resp = await client.complete(baseRequest, new AbortController().signal);
    expect(calls).toBe(2);
    expect(resp.choices[0]!.message.content).toBe('ok');
  });

  test('throws GatewayError with upstream status on non-transient error', async () => {
    const client = createHttpUpstreamClient({
      baseUrl: 'http://fake/v1',
      fetchImpl: (async () => new Response('bad request', { status: 400 })),
    });
    await expect(client.complete(baseRequest, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 400,
      code: 'upstream_error',
    });
  });

  test('propagates abort as GatewayError 499', async () => {
    const controller = new AbortController();
    const client = createHttpUpstreamClient({
      baseUrl: 'http://fake/v1',
      fetchImpl: ((_input: Request | string | URL, init?: RequestInit) => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })),
    });
    const promise = client.complete(baseRequest, controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('HttpUpstreamClient.stream', () => {
  test('parses SSE chunks into ChatChunk and terminates on [DONE]', async () => {
    const sseBody = [
      `data: ${JSON.stringify({ id: 'r1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] })}`,
      ``,
      `data: ${JSON.stringify({ id: 'r1', choices: [{ index: 0, delta: { content: 'lo' } }] })}`,
      ``,
      `data: ${JSON.stringify({ id: 'r1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      ``,
      `data: [DONE]`,
      ``,
    ].join('\n');
    const client = createHttpUpstreamClient({
      baseUrl: 'http://fake/v1',
      fetchImpl: (async () => new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })),
    });
    const chunks: string[] = [];
    let finishReason: string | null | undefined;
    for await (const chunk of client.stream(baseRequest, new AbortController().signal)) {
      const c = chunk.choices[0]!;
      if (c.delta.content) chunks.push(c.delta.content);
      if (c.finishReason) finishReason = c.finishReason;
    }
    expect(chunks.join('')).toBe('Hello');
    expect(finishReason).toBe('stop');
  });
});

describe('HttpUpstreamClient.raw', () => {
  test('returns the Response unchanged for pass-through', async () => {
    const upstreamResponse = new Response('raw bytes', {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-upstream': 'yes' },
    });
    const client = createHttpUpstreamClient({
      baseUrl: 'http://fake/v1',
      fetchImpl: (async () => upstreamResponse),
    });
    const resp = await client.raw(baseRequest, new AbortController().signal);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('x-upstream')).toBe('yes');
    expect(await resp.text()).toBe('raw bytes');
  });
});
