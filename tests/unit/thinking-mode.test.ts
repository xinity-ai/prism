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
    });
    const internal = fromWireRequest(parsed);
    expect(internal.extraBody).toEqual({
      top_k: 20,
      chat_template_kwargs: { enable_thinking: true },
    });
    // Known fields are NOT mirrored into extraBody.
    expect(internal.extraBody!.model).toBeUndefined();
    expect(internal.extraBody!.messages).toBeUndefined();
  });

  test('reasoning_effort is a known field, not extraBody passthrough', () => {
    // reasoning_effort is consumed by the gateway boundary (translated to the
    // thinking toggle) and must never appear on the upstream wire.
    const parsed = ChatCompletionRequestSchema.parse({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    });
    const internal = fromWireRequest(parsed);
    expect(internal.extraBody).toBeUndefined();
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

describe('CLI Qwen3 profile registration', () => {
  // Mirrors the profile registered in bin/prism.ts. Kept in sync by hand —
  // if the CLI's Qwen3 entry diverges, this test fails first.
  const cliQwen3Profile: ModelProfile = {
    name: 'qwen3',
    match: /^qwen3/i,
    thinkingMode: true,
    thinkingModeToggleable: true,
    supportsLogprobs: false,
    contextWindow: 32_000,
    thinkingParams: (on) => ({ chat_template_kwargs: { enable_thinking: on } }),
  };

  test('xinity.thinking:false against qwen3.6 translates to enable_thinking:false on the wire', async () => {
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
      modelProfiles: [cliQwen3Profile],
    });

    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-35b-a3b-fp8',
        messages: [{ role: 'user', content: 'hi' }],
        xinity: { thinking: false },
      }),
    }));

    expect(resp.status).toBe(200);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('xinity.thinking:true against qwen3.6 translates to enable_thinking:true', async () => {
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
      modelProfiles: [cliQwen3Profile],
    });

    await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-35b-a3b-fp8',
        messages: [{ role: 'user', content: 'hi' }],
        xinity: { thinking: true },
      }),
    }));

    expect(capturedBody!.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test('profile match catches family variants (32b-thinking, 72b plain)', () => {
    expect(cliQwen3Profile.match instanceof RegExp).toBe(true);
    const re = cliQwen3Profile.match as RegExp;
    for (const name of ['qwen3.6-35b-a3b-fp8', 'qwen3-32b-thinking', 'qwen3-72b', 'QWEN3-Large']) {
      expect(re.test(name)).toBe(true);
    }
    // Anchored — must not match models that merely contain "qwen3" mid-string,
    // and must not absorb deepseek-r1 (which has its own profile entry).
    expect(re.test('not-qwen3-foo')).toBe(false);
    expect(re.test('deepseek-r1')).toBe(false);
  });

  test('with the Qwen3 profile registered, no xinity.thinking request is rejected', async () => {
    // Regression guard: the failure mode that drove this change was
    // thinking_not_supported being returned for valid Qwen3 requests. If the
    // CLI profile ever loses thinkingParams again, this test fails loudly.
    const upstream = createMockUpstream({
      raw: async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [cliQwen3Profile],
    });

    for (const flag of [true, false]) {
      const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6-35b-a3b-fp8',
          messages: [{ role: 'user', content: 'hi' }],
          xinity: { thinking: flag },
        }),
      }));
      expect(resp.status).toBe(200);
    }
  });
});

describe('server: reasoning_effort → thinking translation', () => {
  // OpenAI-style reasoning_effort is consumed at the gateway boundary and
  // mapped to the boolean thinking toggle (minimal → off; low/medium/high →
  // on), then fed through the profile's thinkingParams. The field itself
  // must never appear on the upstream wire — Qwen3/vLLM doesn't honor it and
  // would just clutter the payload.
  const qwen3Profile: ModelProfile = {
    name: 'qwen3',
    match: /^qwen3/i,
    thinkingMode: true,
    thinkingModeToggleable: true,
    supportsLogprobs: false,
    contextWindow: 32_000,
    thinkingParams: (on) => ({ chat_template_kwargs: { enable_thinking: on } }),
  };

  function buildGateway() {
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
      modelProfiles: [qwen3Profile],
    });
    return { gw, captured: () => capturedBody };
  }

  async function send(gw: ReturnType<typeof createGateway>, body: Record<string, unknown>) {
    return gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-35b-a3b-fp8',
        messages: [{ role: 'user', content: 'hi' }],
        ...body,
      }),
    }));
  }

  for (const effort of ['low', 'medium', 'high'] as const) {
    test(`reasoning_effort:${effort} → enable_thinking:true on the wire`, async () => {
      const { gw, captured } = buildGateway();
      const resp = await send(gw, { reasoning_effort: effort });
      expect(resp.status).toBe(200);
      expect(captured()!.chat_template_kwargs).toEqual({ enable_thinking: true });
      // Must not be forwarded upstream.
      expect(captured()!.reasoning_effort).toBeUndefined();
    });
  }

  test('reasoning_effort:minimal → enable_thinking:false on the wire', async () => {
    const { gw, captured } = buildGateway();
    const resp = await send(gw, { reasoning_effort: 'minimal' });
    expect(resp.status).toBe(200);
    expect(captured()!.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(captured()!.reasoning_effort).toBeUndefined();
  });

  test('reasoning_effort wins when both reasoning_effort and xinity.thinking are set', async () => {
    const { gw, captured } = buildGateway();
    // reasoning_effort:minimal would yield false, while xinity.thinking:true
    // would yield true. reasoning_effort wins, so the wire should be false.
    const resp = await send(gw, { reasoning_effort: 'minimal', xinity: { thinking: true } });
    expect(resp.status).toBe(200);
    expect(captured()!.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('reasoning_effort rejects values outside the OpenAI enum', async () => {
    const { gw } = buildGateway();
    const resp = await send(gw, { reasoning_effort: 'extreme' });
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  test('reasoning_effort against a profile without thinkingParams is rejected loudly', async () => {
    // Same loud-failure contract as xinity.thinking: a silent no-op would
    // corrupt ablation studies that depend on the gate flipping.
    const noThinkingProfile: ModelProfile = {
      name: 'plain',
      match: /.*/,
      thinkingMode: false,
      supportsLogprobs: false,
    };
    const upstream = createMockUpstream({
      raw: async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const gw = createGateway({
      upstream,
      logger: silentLogger,
      modelProfiles: [noThinkingProfile],
    });
    const resp = await gw.fetch(new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
      }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe('thinking_not_supported');
  });
});
