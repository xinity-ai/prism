import { describe, expect, test } from 'bun:test';
import { createGateway } from '../../src/server.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { Technique } from '../../src/types.ts';

function passThroughTechnique(name: string, hook?: () => void): Technique {
  return {
    name,
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: true,
      addsLatency: 'low',
      tokenMultiplier: 1,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },
    async apply(ctx) {
      hook?.();
      return ctx.next(ctx.request);
    },
  };
}

describe('server health endpoint', () => {
  test('GET /health returns 200', async () => {
    const upstream = createMockUpstream({});
    const gw = createGateway({ upstream, logger: silentLogger });
    const resp = await gw.fetch(new Request('http://x/health'));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: 'ok' });
  });
});

describe('server pass-through fast path', () => {
  test('zero techniques + zero plugins forwards upstream Response unchanged', async () => {
    const upstreamBody = JSON.stringify({
      id: 'pt-1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'verbatim' }, finish_reason: 'stop' }],
    });
    const upstream = createMockUpstream({
      raw: () => new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-marker': 'upstream' },
      }),
    });
    const gw = createGateway({ upstream, logger: silentLogger });

    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    }));

    expect(resp.status).toBe(200);
    expect(resp.headers.get('x-marker')).toBe('upstream');
    expect(await resp.text()).toBe(upstreamBody);
    expect(upstream.rawCalls).toHaveLength(1);
    expect(upstream.completeCalls).toHaveLength(0);
  });
});

describe('server active pipeline', () => {
  test('non-streaming request runs the technique chain and returns OpenAI-shaped JSON', async () => {
    let techniqueRan = false;
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('via pipeline', { id: 'r-1' }),
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      registry: {
        techniques: new Map([['echo', () => passThroughTechnique('echo', () => { techniqueRan = true; })]]),
      },
      defaults: { techniques: ['echo'] },
    });

    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    }));

    expect(resp.status).toBe(200);
    const body = await resp.json() as { id: string; choices: { message: { content: string } }[] };
    expect(body.id).toBe('r-1');
    expect(body.choices[0]!.message.content).toBe('via pipeline');
    expect(techniqueRan).toBe(true);
    expect(upstream.completeCalls).toHaveLength(1);
  });

  test('400 on malformed JSON', async () => {
    const upstream = createMockUpstream({});
    const gw = createGateway({ upstream, logger: silentLogger });
    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }));
    expect(resp.status).toBe(400);
  });

  test('400 on unknown technique referenced by header', async () => {
    const upstream = createMockUpstream({});
    const gw = createGateway({ upstream, logger: silentLogger });
    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xinity-techniques': 'mcts',
      },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe('unknown_technique');
  });

  test('streaming request emits SSE chunks and [DONE]', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('streamed', { id: 's-1' }),
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      registry: {
        techniques: new Map([['echo', () => passThroughTechnique('echo')]]),
      },
      defaults: { techniques: ['echo'] },
    });

    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }));

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const text = await resp.text();
    expect(text).toContain('"streamed"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('server pass-through transparency', () => {
  test('streaming pass-through forwards the upstream SSE body byte-for-byte', async () => {
    const sse = [
      `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"He"}}]}`,
      ``,
      `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"llo"}}]}`,
      ``,
      `data: [DONE]`,
      ``,
    ].join('\n');
    const upstream = createMockUpstream({
      raw: () => new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    });
    const gw = createGateway({ upstream, logger: silentLogger });
    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }));
    expect(await resp.text()).toBe(sse);
  });
});
