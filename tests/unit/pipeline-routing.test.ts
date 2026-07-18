import { describe, expect, test } from 'bun:test';
import { createGateway } from '../../src/server.ts';
import { rulesRouter, defaultRules } from '../../src/router.ts';
import type { Router, RouterContext } from '../../src/router.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import { selfConsistency } from '../../src/techniques/self-consistency.ts';
import { roundTrip } from '../../src/techniques/round-trip.ts';
import type { Logger, Technique } from '../../src/types.ts';

// =============================================================================
// Capturing logger
// =============================================================================

type LogEntry = Record<string, unknown>;

function makeCapturingLogger(): Logger & { events: LogEntry[] } {
  const events: LogEntry[] = [];
  const make = (extra: Record<string, unknown> = {}): Logger => ({
    info(e) { events.push({ level: 'info', ...extra, ...e }); },
    warn(e) { events.push({ level: 'warn', ...extra, ...e }); },
    error(e) {
      if (e instanceof Error) events.push({ level: 'error', ...extra, message: e.message });
      else events.push({ level: 'error', ...extra, ...e });
    },
    child(c) { return make({ ...extra, ...c }); },
  });
  const root = make() as Logger & { events: LogEntry[] };
  root.events = events;
  return root;
}

function eventsByName(logger: { events: LogEntry[] }, name: string): LogEntry[] {
  return logger.events.filter(e => e.event === name);
}

// =============================================================================
// Helpers
// =============================================================================

function passThrough(name: string): Technique {
  return {
    name,
    capabilities: {
      requiresLogprobs: false, supportsStreaming: true, addsLatency: 'low',
      tokenMultiplier: 1, worksWithThinkingMode: true, subsumedByThinkingMode: false,
    },
    async apply(ctx) { return ctx.next(ctx.request); },
  };
}

const okUpstream = () => createMockUpstream({
  complete: async () => fakeResponse('ok', { id: 'r1' }),
});

const postChat = (body: unknown) => new Request('http://x/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// A router that always returns a fixed decision. Records calls for assertions.
function fixedRouter(name: string, techniques: Technique[], reason: string): Router & { calls: number } {
  const r = {
    name,
    calls: 0,
    async decide(_req: unknown, ctx: RouterContext) {
      if (ctx.signal.aborted) throw new Error('aborted');
      this.calls++;
      return { techniques, reason };
    },
  };
  return r;
}

// =============================================================================
// The four-case merge decision table (DESIGN §17.9)
// =============================================================================

describe('technique merge semantics — case 1: explicit + router → bypassed', () => {
  test('uses explicit techniques, logs router.bypassed, never calls router', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const router = fixedRouter('rules', [roundTrip({})], 'rules say round-trip');
    const gw = createGateway({
      upstream,
      logger,
      router,
      registry: { techniques: new Map([['self-consistency', () => selfConsistency({ k: 2 })]]) },
    });

    const resp = await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      xinity: { techniques: ['self-consistency'] },
    }));
    expect(resp.status).toBe(200);

    expect(router.calls).toBe(0);
    expect(eventsByName(logger, 'router.bypassed')).toHaveLength(1);
    expect(eventsByName(logger, 'router.decision')).toHaveLength(0);

    const received = eventsByName(logger, 'request.received')[0]!;
    expect(received.techniques).toEqual(['self-consistency']);
  });
});

describe('technique merge semantics — case 2: explicit + no router → normal path', () => {
  test('uses explicit techniques, emits no router log events', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const gw = createGateway({
      upstream,
      logger,
      registry: { techniques: new Map([['self-consistency', () => selfConsistency({ k: 2 })]]) },
    });

    const resp = await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      xinity: { techniques: ['self-consistency'] },
    }));
    expect(resp.status).toBe(200);

    expect(eventsByName(logger, 'router.bypassed')).toHaveLength(0);
    expect(eventsByName(logger, 'router.decision')).toHaveLength(0);
    expect(eventsByName(logger, 'router.fallback')).toHaveLength(0);

    const received = eventsByName(logger, 'request.received')[0]!;
    expect(received.techniques).toEqual(['self-consistency']);
  });
});

describe('technique merge semantics — case 3: no explicit + router → router decides', () => {
  test('router.decide() called; result used; router.decision logged', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const router = fixedRouter('rules', [roundTrip({})], 'rules say round-trip');
    const gw = createGateway({ upstream, logger, router });

    const resp = await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(resp.status).toBe(200);

    expect(router.calls).toBe(1);
    const dec = eventsByName(logger, 'router.decision');
    expect(dec).toHaveLength(1);
    expect(dec[0]!.techniques).toEqual(['round-trip']);
    expect(dec[0]!.router).toBe('rules');
    expect(dec[0]!.reason).toBe('rules say round-trip');
    expect(dec[0]!.confidence).toBeNull();
    expect(typeof dec[0]!.duration_ms).toBe('number');

    expect(eventsByName(logger, 'router.bypassed')).toHaveLength(0);
    expect(eventsByName(logger, 'router.fallback')).toHaveLength(0);

    const received = eventsByName(logger, 'request.received')[0]!;
    expect(received.techniques).toEqual(['round-trip']);
  });

  test('router decision sees effortBudget from request', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    let observedEffort: number | undefined;
    const probe: Router = {
      name: 'probe',
      async decide(_req, ctx) {
        observedEffort = ctx.effortBudget;
        return { techniques: [], reason: 'probe' };
      },
    };
    const gw = createGateway({ upstream, logger, router: probe });
    await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      xinity: { effortBudget: 0.85 },
    }));
    expect(observedEffort).toBe(0.85);
  });
});

describe('technique merge semantics — case 4: no explicit + no router → server defaults', () => {
  test('uses defaults.techniques; logs router.fallback', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const gw = createGateway({
      upstream,
      logger,
      defaults: { techniques: ['self-consistency'] },
      registry: { techniques: new Map([['self-consistency', () => selfConsistency({ k: 2 })]]) },
    });

    const resp = await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(resp.status).toBe(200);

    const fb = eventsByName(logger, 'router.fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0]!.source).toBe('server.defaults');
    expect(fb[0]!.techniques).toEqual(['self-consistency']);

    expect(eventsByName(logger, 'router.decision')).toHaveLength(0);
    expect(eventsByName(logger, 'router.bypassed')).toHaveLength(0);
  });

  test('empty defaults: still logs router.fallback with empty techniques (pass-through)', async () => {
    // Pass-through fast path: zero techniques + zero plugins → upstream.raw
    const upstream = createMockUpstream({
      raw: async () => new Response('{"id":"raw"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const logger = makeCapturingLogger();
    const gw = createGateway({ upstream, logger });
    const resp = await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(resp.status).toBe(200);
    const fb = eventsByName(logger, 'router.fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0]!.techniques).toEqual([]);
  });
});

// =============================================================================
// Explicit-empty arrays count as explicit (per case 1 semantics)
// =============================================================================

describe('explicit empty techniques array bypasses the router', () => {
  test('xinity.techniques=[] is explicit; router not called', async () => {
    const upstream = createMockUpstream({
      raw: async () => new Response('{"id":"raw"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const logger = makeCapturingLogger();
    const router = fixedRouter('rules', [roundTrip({})], 'rules say round-trip');
    const gw = createGateway({ upstream, logger, router });
    const resp = await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      xinity: { techniques: [] },
    }));
    expect(resp.status).toBe(200);
    expect(router.calls).toBe(0);
    expect(eventsByName(logger, 'router.bypassed')).toHaveLength(1);
  });
});

// =============================================================================
// End-to-end with rulesRouter + defaultRules
// =============================================================================

describe('rulesRouter(defaultRules) end-to-end', () => {
  test('summarize prompt with router triggers round-trip + self-consistency', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const gw = createGateway({
      upstream,
      logger,
      router: rulesRouter([...defaultRules]),
      modelProfiles: [{ match: /.*/, thinkingMode: false, supportsLogprobs: false, contextWindow: 32_000 }],
    });
    const resp = await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'Summarize this article in three sentences.' }],
      xinity: { effortBudget: 0.7 },
    }));
    expect(resp.status).toBe(200);

    const dec = eventsByName(logger, 'router.decision')[0]!;
    expect(dec.techniques).toEqual(expect.arrayContaining(['round-trip', 'self-consistency']));
    expect(String(dec.reason)).toContain('round-trip-for-translation-or-summary');
    expect(String(dec.reason)).toContain('self-consistency-default');
  });
});

