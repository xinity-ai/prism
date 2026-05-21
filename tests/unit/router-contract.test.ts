import { describe, expect, test } from 'bun:test';
import {
  assertRouterConformance,
  defaultRules,
  rulesRouter,
} from '../../src/router.ts';
import type { Router, RouterContext } from '../../src/router.ts';
import { silentLogger } from '../../src/logging.ts';
import type { ChatRequest, ModelProfile, VerifierRegistry } from '../../src/types.ts';

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

const sampleReq: ChatRequest = {
  model: 'm',
  messages: [{ role: 'user', content: 'Summarize this article please.' }],
};

describe('Router conformance contract', () => {
  test('rulesRouter(defaultRules) satisfies contract', async () => {
    const r = rulesRouter([...defaultRules]);
    await assertRouterConformance(r, makeCtx, sampleReq);
  });

  test('empty rulesRouter satisfies contract (returns empty decision)', async () => {
    const r = rulesRouter([]);
    await assertRouterConformance(r, makeCtx, sampleReq);
    const decision = await r.decide(sampleReq, makeCtx());
    expect(decision.techniques).toEqual([]);
    expect(decision.reason).toBe('no rules matched');
  });

  test('contract rejects router that ignores AbortSignal', async () => {
    const naughty: Router = {
      name: 'naughty',
      async decide() {
        return { techniques: [], reason: 'ignores signal' };
      },
    };
    let threw = false;
    try {
      await assertRouterConformance(naughty, makeCtx, sampleReq);
    } catch (e) {
      threw = true;
      expect(String(e)).toContain('signal');
    }
    expect(threw).toBe(true);
  });

  test('contract rejects router that mutates the request', async () => {
    const mutator: Router = {
      name: 'mutator',
      async decide(request, context) {
        if (context.signal.aborted) throw new Error('aborted');
        // Mutation — illegal.
        (request as { model: string }).model = 'mutated';
        return { techniques: [], reason: 'mutated request' };
      },
    };
    let threw = false;
    try {
      await assertRouterConformance(mutator, makeCtx, { ...sampleReq });
    } catch (e) {
      threw = true;
      expect(String(e)).toContain('mutated');
    }
    expect(threw).toBe(true);
  });

  test('rulesRouter decide is deterministic for the same input', async () => {
    const r = rulesRouter([...defaultRules]);
    const a = await r.decide(sampleReq, makeCtx());
    const b = await r.decide(sampleReq, makeCtx());
    expect(a.reason).toBe(b.reason);
    expect(a.techniques.map(t => t.name)).toEqual(b.techniques.map(t => t.name));
  });

  test('rulesRouter aborts mid-evaluation when signal fires', async () => {
    const ctl = new AbortController();
    const r = rulesRouter([...defaultRules]);
    ctl.abort();
    const ctx: RouterContext = { ...makeCtx(), signal: ctl.signal };
    await expect(r.decide(sampleReq, ctx)).rejects.toThrow();
  });

  test('rulesRouter has no init/close (no warmup needed)', () => {
    const r = rulesRouter([...defaultRules]);
    expect(r.init).toBeUndefined();
    expect(r.close).toBeUndefined();
  });
});
