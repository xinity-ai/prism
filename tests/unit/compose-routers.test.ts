import { describe, expect, test } from 'bun:test';
import { composeRouters, rulesRouter } from '../../src/router.ts';
import type { Router, RouterContext } from '../../src/router.ts';
import { silentLogger } from '../../src/logging.ts';
import { selfConsistency } from '../../src/techniques/self-consistency.ts';
import { roundTrip } from '../../src/techniques/round-trip.ts';
import type { ChatRequest, ModelProfile, Technique, VerifierRegistry } from '../../src/types.ts';

const profile: ModelProfile = {
  match: /.*/,
  thinkingMode: false,
  supportsLogprobs: false,
  contextWindow: 32_000,
};

const emptyVerifiers: VerifierRegistry = {
  get: () => undefined,
  has: () => false,
  names: () => [],
};

const makeCtx = (): RouterContext => ({
  modelProfile: profile,
  effortBudget: 0.5,
  signal: new AbortController().signal,
  logger: silentLogger,
  verifiers: emptyVerifiers,
});

const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

// Helper: a static router that returns a fixed decision and tracks init/close calls.
const staticRouter = (
  name: string,
  techniques: Technique[],
  reason: string,
  confidence?: number,
): Router & { initCalls: number; closeCalls: number; decideCalls: number } => {
  const r = {
    name,
    initCalls: 0,
    closeCalls: 0,
    decideCalls: 0,
    async decide(_req: ChatRequest, ctx: RouterContext) {
      if (ctx.signal.aborted) throw new Error('aborted');
      this.decideCalls++;
      return confidence === undefined
        ? { techniques, reason }
        : { techniques, reason, confidence };
    },
    async init() {
      this.initCalls++;
    },
    async close() {
      this.closeCalls++;
    },
  };
  return r;
};

describe('composeRouters', () => {
  test('empty composition returns empty decision', async () => {
    const composed = composeRouters([]);
    const d = await composed.decide(req, makeCtx());
    expect(d.techniques).toEqual([]);
    expect(d.reason).toBe('no routers configured');
    expect(d.confidence).toBeUndefined();
    expect(composed.name).toBe('composed(empty)');
  });

  test('single-router composition mirrors the child', async () => {
    const child = staticRouter('a', [roundTrip({})], 'child reason');
    const composed = composeRouters([child]);
    const d = await composed.decide(req, makeCtx());
    expect(d.techniques.map(t => t.name)).toEqual(['round-trip']);
    expect(d.reason).toBe('[a] child reason');
    expect(composed.name).toBe('composed(a)');
  });

  test('technique order matches router order', async () => {
    const a = staticRouter('a', [roundTrip({})], 'a');
    const b = staticRouter('b', [selfConsistency({ k: 3 })], 'b');
    const composed = composeRouters([a, b]);
    const d = await composed.decide(req, makeCtx());
    expect(d.techniques.map(t => t.name)).toEqual(['round-trip', 'self-consistency']);
  });

  test('reason strings are joined and prefixed by router name', async () => {
    const a = staticRouter('a', [], 'matched X');
    const b = staticRouter('b', [], 'matched Y');
    const composed = composeRouters([a, b]);
    const d = await composed.decide(req, makeCtx());
    expect(d.reason).toBe('[a] matched X; [b] matched Y');
  });

  test('init() propagates to all children', async () => {
    const a = staticRouter('a', [], 'a');
    const b = staticRouter('b', [], 'b');
    const composed = composeRouters([a, b]);
    await composed.init!();
    expect(a.initCalls).toBe(1);
    expect(b.initCalls).toBe(1);
  });

  test('close() propagates to all children', async () => {
    const a = staticRouter('a', [], 'a');
    const b = staticRouter('b', [], 'b');
    const composed = composeRouters([a, b]);
    await composed.close!();
    expect(a.closeCalls).toBe(1);
    expect(b.closeCalls).toBe(1);
  });

  test('init/close omitted when no child defines them', () => {
    const lean: Router = {
      name: 'lean',
      async decide() {
        return { techniques: [], reason: '' };
      },
    };
    const composed = composeRouters([lean]);
    expect(composed.init).toBeUndefined();
    expect(composed.close).toBeUndefined();
  });

  test('confidence is the minimum across children that report one', async () => {
    const a = staticRouter('a', [], 'a', 0.9);
    const b = staticRouter('b', [], 'b', 0.4);
    const c = staticRouter('c', [], 'c'); // no confidence
    const composed = composeRouters([a, b, c]);
    const d = await composed.decide(req, makeCtx());
    expect(d.confidence).toBe(0.4);
  });

  test('confidence undefined when no child reports one', async () => {
    const a = staticRouter('a', [], 'a');
    const b = staticRouter('b', [], 'b');
    const composed = composeRouters([a, b]);
    const d = await composed.decide(req, makeCtx());
    expect(d.confidence).toBeUndefined();
  });

  test('composition with rulesRouter behaves end-to-end', async () => {
    const a = staticRouter('override', [roundTrip({})], 'override fires');
    const b = rulesRouter([]); // empty rules
    const composed = composeRouters([a, b]);
    const d = await composed.decide(req, makeCtx());
    expect(d.techniques.map(t => t.name)).toEqual(['round-trip']);
    expect(d.reason).toContain('[override] override fires');
    expect(d.reason).toContain('[rules] no rules matched');
  });

  test('aborted signal short-circuits before children run', async () => {
    const a = staticRouter('a', [], 'a');
    const composed = composeRouters([a]);
    const ctl = new AbortController();
    ctl.abort();
    const ctx: RouterContext = { ...makeCtx(), signal: ctl.signal };
    await expect(composed.decide(req, ctx)).rejects.toThrow();
    expect(a.decideCalls).toBe(0);
  });
});
