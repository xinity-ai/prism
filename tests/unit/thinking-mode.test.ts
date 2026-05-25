import { describe, expect, test } from 'bun:test';
import { createGateway } from '../../src/server.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import {
  ChatCompletionRequestSchema,
  fromWireRequest,
  toWireRequest,
} from '../../src/types.ts';
import type { ModelProfile, Technique } from '../../src/types.ts';

function subsumedTechnique(name: string, hook: () => void): Technique {
  return {
    name,
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: false,
      addsLatency: 'low',
      tokenMultiplier: 1,
      worksWithThinkingMode: false,
      subsumedByThinkingMode: true,
    },
    async apply(ctx) { hook(); return ctx.next(ctx.request); },
  };
}

describe('wire <-> internal: extraBody passthrough', () => {
  test('fromWireRequest captures unknown top-level fields into extraBody', () => {
    const parsed = ChatCompletionRequestSchema.parse({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      top_k: 20,
      chat_template_kwargs: { enable_thinking: true },
      reasoning_effort: 'high',
    });
    const internal = fromWireRequest(parsed);
    expect(internal.extraBody).toEqual({
      top_k: 20,
      chat_template_kwargs: { enable_thinking: true },
      reasoning_effort: 'high',
    });
    // Known fields are NOT mirrored into extraBody.
    expect(internal.extraBody!.model).toBeUndefined();
    expect(internal.extraBody!.messages).toBeUndefined();
  });

  test('toWireRequest spreads extraBody and known fields override on overlap', () => {
    const wire = toWireRequest({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      extraBody: {
        top_k: 20,
        chat_template_kwargs: { enable_thinking: true },
        // Try to clobber a known field — should lose to the typed one.
        temperature: 9.9,
      },
    }) as Record<string, unknown>;
    expect(wire.top_k).toBe(20);
    expect(wire.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(wire.temperature).toBe(0.7);
  });

  test('round-trip is structurally equivalent across all fields', () => {
    // Mix typed OpenAI fields with vendor passthrough so we exercise both paths
    // simultaneously and catch any subtle asymmetry in the conversion.
    const original = {
      model: 'qwen3',
      messages: [{ role: 'user' as const, content: 'hi' }],
      temperature: 0.7,
      top_p: 0.8,
      presence_penalty: 1.5,
      max_tokens: 256,
      top_k: 20,
      chat_template_kwargs: { enable_thinking: true },
      reasoning_effort: 'high',
    };
    const parsed = ChatCompletionRequestSchema.parse(original);
    const internal = fromWireRequest(parsed);
    const wire = toWireRequest(internal);
    expect(wire).toEqual(original);
  });
});

describe('server: xinity.thinking + profile.thinkingParams', () => {
  const qwenProfile: ModelProfile = {
    name: 'qwen3',
    match: /^qwen3/,
    thinkingMode: false,
    supportsLogprobs: false,
    thinkingParams: (on) => on
      ? { chat_template_kwargs: { enable_thinking: true } }
      : { chat_template_kwargs: { enable_thinking: false } },
  };

  test('thinking=true merges profile params into upstream wire payload (raw fast path)', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const upstream = createMockUpstream({
      raw: async (req) => {
        // mock-upstream's `raw` is invoked with the internal ChatRequest;
        // serialize it the same way the real HTTP client would to assert wire shape.
        capturedBody = toWireRequest(req) as Record<string, unknown>;
        return new Response('{"id":"x","choices":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [qwenProfile],
    });

    await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-30b',
        messages: [{ role: 'user', content: 'hi' }],
        xinity: { thinking: true },
      }),
    }));

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test('request-supplied extra_body wins over profile thinkingParams on overlap', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const upstream = createMockUpstream({
      raw: async (req) => {
        capturedBody = toWireRequest(req) as Record<string, unknown>;
        return new Response('{"id":"x","choices":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [qwenProfile],
    });

    await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-30b',
        messages: [{ role: 'user', content: 'hi' }],
        xinity: { thinking: true },
        // Caller explicitly disables thinking via raw vendor field — should win.
        chat_template_kwargs: { enable_thinking: false },
      }),
    }));

    expect(capturedBody!.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('thinking=true skips techniques marked subsumedByThinkingMode', async () => {
    let subsumedRan = false;
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('ok'),
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [{ ...qwenProfile, thinkingMode: false }],
      registry: {
        techniques: new Map([
          ['cot', () => subsumedTechnique('cot', () => { subsumedRan = true; })],
        ]),
      },
      defaults: { techniques: ['cot'] },
    });

    await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-30b',
        messages: [{ role: 'user', content: 'hi' }],
        xinity: { thinking: true },
      }),
    }));

    expect(subsumedRan).toBe(false);
    expect(upstream.completeCalls).toHaveLength(1);
  });

  test('X-Xinity-Thinking header maps to xinity.thinking', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const upstream = createMockUpstream({
      raw: async (req) => {
        capturedBody = toWireRequest(req) as Record<string, unknown>;
        return new Response('{"id":"x","choices":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [qwenProfile],
    });

    await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xinity-thinking': 'true',
      },
      body: JSON.stringify({
        model: 'qwen3-30b',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }));

    expect(capturedBody!.chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});

describe('server: capability enforcement for xinity.thinking', () => {
  test('rejects xinity.thinking when profile has no thinkingParams', async () => {
    const upstream = createMockUpstream({
      raw: async () => new Response('{}', { status: 200 }),
      complete: async () => fakeResponse('x'),
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [{
        name: 'static-thinker',
        match: /^qwen3/,
        thinkingMode: true,
        supportsLogprobs: false,
        // no thinkingParams
      }],
    });

    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-30b',
        messages: [{ role: 'user', content: 'hi' }],
        xinity: { thinking: false },
      }),
    }));

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('thinking_not_supported');
    expect(body.error.message).toContain('static-thinker');
    expect(body.error.message).toContain('thinkingParams');
    // Upstream must NOT have been called — silent fall-through would be the bug.
    expect(upstream.rawCalls).toHaveLength(0);
    expect(upstream.completeCalls).toHaveLength(0);
  });

  test('rejects xinity.thinking when profile explicitly marks it non-toggleable', async () => {
    const upstream = createMockUpstream({
      raw: async () => new Response('{}', { status: 200 }),
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [{
        name: 'frozen-thinker',
        match: /^qwen3/,
        thinkingMode: true,
        supportsLogprobs: false,
        thinkingModeToggleable: false,
        thinkingParams: () => ({ chat_template_kwargs: { enable_thinking: true } }),
      }],
    });

    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-30b',
        messages: [{ role: 'user', content: 'hi' }],
        xinity: { thinking: true },
      }),
    }));

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('thinking_not_supported');
    expect(body.error.message).toContain('frozen-thinker');
    expect(body.error.message).toContain('thinkingModeToggleable');
    expect(upstream.rawCalls).toHaveLength(0);
  });

  test('requests without xinity.thinking are unaffected by missing thinkingParams', async () => {
    // Sanity: the gate only fires when xinity.thinking is explicitly set.
    const upstream = createMockUpstream({
      raw: async () => new Response('{"id":"x","choices":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [{ name: 'plain', match: /.*/, thinkingMode: false, supportsLogprobs: false }],
    });

    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    }));

    expect(resp.status).toBe(200);
    expect(upstream.rawCalls).toHaveLength(1);
  });
});

describe('strict boolean parsing for xinity.thinking', () => {
  function postWith(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const upstream = createMockUpstream({
      raw: async () => new Response('{}', { status: 200 }),
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [{
        name: 'qwen3',
        match: /^qwen3/,
        thinkingMode: false,
        supportsLogprobs: false,
        thinkingParams: (on) => ({ chat_template_kwargs: { enable_thinking: on } }),
      }],
    });
    return gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }));
  }

  test('body: xinity.thinking accepts true/false only — rejects "true" string', async () => {
    const resp = await postWith({
      model: 'qwen3-30b',
      messages: [{ role: 'user', content: 'hi' }],
      xinity: { thinking: 'true' },
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  test('body: xinity.thinking rejects 1 as a coercion attempt', async () => {
    const resp = await postWith({
      model: 'qwen3-30b',
      messages: [{ role: 'user', content: 'hi' }],
      xinity: { thinking: 1 },
    });
    expect(resp.status).toBe(400);
  });

  test('header: X-Xinity-Thinking accepts only "true" and "false", case-sensitive', async () => {
    for (const bad of ['1', '0', 'yes', 'no', 'True', 'FALSE', '']) {
      const resp = await postWith(
        { model: 'qwen3-30b', messages: [{ role: 'user', content: 'hi' }] },
        bad === '' ? {} : { 'x-xinity-thinking': bad },
      );
      // Empty header is treated as "header not set" — that's a 200 (no thinking).
      if (bad === '') {
        expect(resp.status).toBe(200);
      } else {
        expect(resp.status).toBe(400);
        const body = await resp.json() as { error: { code: string; message: string } };
        expect(body.error.code).toBe('invalid_xinity_header');
        expect(body.error.message).toContain('X-Xinity-Thinking');
      }
    }
  });

  test('header: X-Xinity-Thinking: true is accepted', async () => {
    const resp = await postWith(
      { model: 'qwen3-30b', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-xinity-thinking': 'true' },
    );
    expect(resp.status).toBe(200);
  });
});
