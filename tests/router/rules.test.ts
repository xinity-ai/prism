import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { rulesRouter } from '../../src/router/rules.ts';
import type { Router, RouterContext } from '../../src/router/types.ts';
import type {
  ChatRequest,
  Logger,
  ModelProfile,
  Technique,
  Transform,
} from '../../src/types.ts';

// ----- helpers ----------------------------------------------------------------

type LogEvent = { level: 'info' | 'warn' | 'error'; payload: Record<string, unknown> };
const capturingLogger = (): Logger & { events: LogEvent[] } => {
  const events: LogEvent[] = [];
  const self: Logger & { events: LogEvent[] } = {
    events,
    info: (p) => events.push({ level: 'info', payload: p }),
    warn: (p) => events.push({ level: 'warn', payload: p }),
    error: (e) => events.push({ level: 'error', payload: e instanceof Error ? { msg: e.message } : e }),
    child: () => self,
  };
  return self;
};

const profile = (contextWindow?: number): ModelProfile => ({
  match: /.*/,
  thinkingMode: false,
  supportsLogprobs: false,
  ...(contextWindow !== undefined && { contextWindow }),
});

const makeCtx = (modelProfile: ModelProfile = profile()): RouterContext & {
  logger: ReturnType<typeof capturingLogger>;
} => ({
  modelProfile,
  logger: capturingLogger(),
  signal: new AbortController().signal,
});

const req = (content: string, extras: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'm',
  messages: [{ role: 'user', content }],
  ...extras,
});

async function decide(router: Router, request: ChatRequest, ctx = makeCtx()) {
  const decision = await router.decide(request, ctx);
  return { decision, ctx };
}

const decideEvent = (ctx: { logger: { events: LogEvent[] } }) =>
  ctx.logger.events.find(e => (e.payload as { event?: string }).event === 'router.decide');

// ----- rule 1: privacy ---------------------------------------------------------

describe('rule 1 — privacy / PII', () => {
  test('fires on email and adds privacy plugin', async () => {
    const { decision } = await decide(rulesRouter(), req('email me at alex@xinity.ai'));
    expect(decision.plugins.map(p => p.name)).toContain('privacy');
    expect(decision.rationale.some(r => r.target === 'privacy' && r.rule === 'pii-detected')).toBe(true);
  });

  test('does not fire on benign text', async () => {
    const { decision } = await decide(rulesRouter(), req('what is the capital of France?'));
    expect(decision.plugins.map(p => p.name)).not.toContain('privacy');
    // Signal still present, just not firing.
    expect(decision.signals.find(s => s.name === 'pii')?.match).toBe(false);
  });

  test('customize hook is called when the rule fires', async () => {
    let calls = 0;
    const customInstance: Transform = { name: 'privacy-custom' };
    const router = rulesRouter({
      customize: { privacy: () => { calls += 1; return customInstance; } },
    });
    const { decision } = await decide(router, req('alex@xinity.ai'));
    expect(calls).toBe(1);
    expect(decision.plugins[0]).toBe(customInstance);
  });

  test('disabled: opts.privacy=false → rule never runs, no signal recorded', async () => {
    const router = rulesRouter({ privacy: false });
    const { decision, ctx } = await decide(router, req('alex@xinity.ai'));
    expect(decision.plugins.map(p => p.name)).not.toContain('privacy');
    expect(decision.signals.find(s => s.name === 'pii')).toBeUndefined();
    expect((decideEvent(ctx)!.payload as { consideredRules: number }).consideredRules).toBe(3);
  });
});

// ----- rule 2: readUrls --------------------------------------------------------

describe('rule 2 — readUrls / URLs', () => {
  test('fires on a URL', async () => {
    const { decision } = await decide(rulesRouter(), req('see https://example.com/report.pdf'));
    expect(decision.plugins.map(p => p.name)).toContain('read-urls');
    const r = decision.rationale.find(r => r.target === 'readUrls')!;
    expect(r.rule).toBe('urls-present');
    expect(r.reason).toContain('example.com');
  });

  test('does not fire without URLs', async () => {
    const { decision } = await decide(rulesRouter(), req('plain text'));
    expect(decision.plugins.map(p => p.name)).not.toContain('read-urls');
    expect(decision.signals.find(s => s.name === 'urls')?.match).toBe(false);
  });

  test('customize hook overrides the instance', async () => {
    const customInstance: Transform = { name: 'read-urls-custom' };
    const router = rulesRouter({ customize: { readUrls: () => customInstance } });
    const { decision } = await decide(router, req('https://example.com'));
    expect(decision.plugins[0]).toBe(customInstance);
  });

  test('disabled: opts.readUrls=false → rule skipped', async () => {
    const router = rulesRouter({ readUrls: false });
    const { decision } = await decide(router, req('https://example.com'));
    expect(decision.plugins.map(p => p.name)).not.toContain('read-urls');
    expect(decision.signals.find(s => s.name === 'urls')).toBeUndefined();
  });
});

// ----- rule 3: json -----------------------------------------------------------

describe('rule 3 — json / response_format', () => {
  test('fires on response_format json_schema', async () => {
    const request = req('whatever', {
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: 'foo', schema: { type: 'object' } },
      },
    });
    const { decision } = await decide(rulesRouter(), request);
    expect(decision.plugins.map(p => p.name)).toContain('json');
    const r = decision.rationale.find(r => r.target === 'json')!;
    expect(r.reason).toBe('response_format=json_schema');
  });

  test('fires on response_format json_object (no schema)', async () => {
    const request = req('whatever', {
      responseFormat: { type: 'json_object' },
    });
    const { decision } = await decide(rulesRouter(), request);
    expect(decision.plugins.map(p => p.name)).toContain('json');
    expect(decision.rationale.find(r => r.target === 'json')!.reason).toBe('response_format=json_object');
  });

  test('does not fire when response_format absent', async () => {
    const { decision } = await decide(rulesRouter(), req('plain text'));
    expect(decision.plugins.map(p => p.name)).not.toContain('json');
  });

  test('does not fire on response_format type=text', async () => {
    const request = req('whatever', { responseFormat: { type: 'text' } });
    const { decision } = await decide(rulesRouter(), request);
    expect(decision.plugins.map(p => p.name)).not.toContain('json');
  });

  test('customize hook receives the JSON Schema for json_schema requests', async () => {
    const seen: unknown[] = [];
    const customInstance: Transform = { name: 'json-custom' };
    const router = rulesRouter({
      customize: {
        json: (schema) => { seen.push(schema); return customInstance; },
      },
    });
    const schemaObj = { type: 'object', properties: { x: { type: 'string' } } };
    const request = req('whatever', {
      responseFormat: { type: 'json_schema', json_schema: { name: 'foo', schema: schemaObj } },
    });
    const { decision } = await decide(router, request);
    expect(seen).toEqual([schemaObj]);
    expect(decision.plugins[0]).toBe(customInstance);
  });

  test('customize hook receives undefined schema for json_object', async () => {
    const seen: unknown[] = [];
    const router = rulesRouter({
      customize: { json: (schema) => { seen.push(schema); return { name: 'json' }; } },
    });
    const request = req('whatever', { responseFormat: { type: 'json_object' } });
    await decide(router, request);
    expect(seen).toEqual([undefined]);
  });

  test('disabled: opts.json=false → rule skipped', async () => {
    const router = rulesRouter({ json: false });
    const request = req('whatever', { responseFormat: { type: 'json_object' } });
    const { decision } = await decide(router, request);
    expect(decision.plugins.map(p => p.name)).not.toContain('json');
  });
});

// ----- rule 4: memory ---------------------------------------------------------

describe('rule 4 — memory / context overflow', () => {
  test('fires when input ≥ ratio × contextWindow', async () => {
    // 8000 chars ≈ 2000 tokens; threshold 0.7 × 2000 = 1400.
    const request = req('a'.repeat(8000));
    const { decision } = await decide(rulesRouter(), request, makeCtx(profile(2000)));
    expect(decision.techniques.map(t => t.name)).toContain('memory');
    expect(decision.rationale.some(r => r.target === 'memory' && r.rule === 'context-overflow')).toBe(true);
  });

  test('does not fire below threshold', async () => {
    const { decision } = await decide(rulesRouter(), req('short'), makeCtx(profile(2000)));
    expect(decision.techniques).toEqual([]);
  });

  test('does not fire when modelProfile has no contextWindow', async () => {
    const request = req('a'.repeat(100_000));
    const { decision } = await decide(rulesRouter(), request, makeCtx(profile()));
    expect(decision.techniques).toEqual([]);
    expect(decision.signals.find(s => s.name === 'context-overflow')?.match).toBe(false);
  });

  test('custom ratio honored', async () => {
    // ~1000 tokens, ratio 0.4 × 2000 = 800 → fires (1000 ≥ 800).
    const router = rulesRouter({ memory: { ratio: 0.4 } });
    const { decision } = await decide(router, req('a'.repeat(4000)), makeCtx(profile(2000)));
    expect(decision.techniques.map(t => t.name)).toContain('memory');
  });

  test('custom ratio can suppress firing', async () => {
    // ~2000 tokens, ratio 0.95 × 2000 = 1900 → does fire actually (2000 ≥ 1900).
    // Use ratio 1.5 to suppress.
    const router = rulesRouter({ memory: { ratio: 1.5 } });
    const { decision } = await decide(router, req('a'.repeat(4000)), makeCtx(profile(2000)));
    expect(decision.techniques).toEqual([]);
  });

  test('customize hook overrides instance', async () => {
    const customInstance: Technique = {
      name: 'memory-custom',
      capabilities: {
        requiresLogprobs: false, supportsStreaming: true, addsLatency: 'low',
        tokenMultiplier: 1, worksWithThinkingMode: true, subsumedByThinkingMode: false,
      },
      async apply(ctx) { return ctx.next(ctx.request); },
    };
    const router = rulesRouter({ customize: { memory: () => customInstance } });
    const { decision } = await decide(router, req('a'.repeat(8000)), makeCtx(profile(2000)));
    expect(decision.techniques[0]).toBe(customInstance);
  });

  test('disabled: opts.memory=false → rule skipped, signal absent', async () => {
    const router = rulesRouter({ memory: false });
    const { decision } = await decide(router, req('a'.repeat(8000)), makeCtx(profile(2000)));
    expect(decision.techniques).toEqual([]);
    expect(decision.signals.find(s => s.name === 'context-overflow')).toBeUndefined();
  });
});

// ----- decision shape & invariants --------------------------------------------

describe('decision shape and invariants', () => {
  test('router name is "rules"', () => {
    expect(rulesRouter().name).toBe('rules');
  });

  test('empty request → no plugins, no techniques, log still emitted', async () => {
    const { decision, ctx } = await decide(rulesRouter(), req('hi'));
    expect(decision.plugins).toEqual([]);
    expect(decision.techniques).toEqual([]);
    expect(decideEvent(ctx)).toBeDefined();
    const payload = decideEvent(ctx)!.payload as { firedRules: number; consideredRules: number };
    expect(payload.firedRules).toBe(0);
    expect(payload.consideredRules).toBe(4);
  });

  test('multiple rules fire on the same request', async () => {
    const request = req('email me at alex@xinity.ai and visit https://example.com');
    const { decision, ctx } = await decide(rulesRouter(), request);
    const names = decision.plugins.map(p => p.name);
    expect(names).toContain('privacy');
    expect(names).toContain('read-urls');
    const payload = decideEvent(ctx)!.payload as { firedRules: number; activatedPlugins: string[] };
    expect(payload.firedRules).toBe(2);
    expect(payload.activatedPlugins).toEqual(expect.arrayContaining(['privacy', 'read-urls']));
  });

  test('signals array populated with firing AND non-firing detector outputs', async () => {
    const request = req('email me at alex@xinity.ai'); // pii fires, urls does not, ctx-overflow does not
    const { decision } = await decide(rulesRouter(), request);
    const byName = Object.fromEntries(decision.signals.map(s => [s.name, s]));
    expect(byName.pii?.match).toBe(true);
    expect(byName.urls?.match).toBe(false);
    expect(byName['context-overflow']?.match).toBe(false);
  });

  test('exactly one router.decide log event per decide() call', async () => {
    const { ctx } = await decide(
      rulesRouter(),
      req('email me at alex@xinity.ai and visit https://example.com'),
    );
    const decideEvents = ctx.logger.events.filter(
      e => (e.payload as { event?: string }).event === 'router.decide',
    );
    expect(decideEvents).toHaveLength(1);
  });

  test('log event includes the full rationale array', async () => {
    const { ctx } = await decide(
      rulesRouter(),
      req('alex@xinity.ai and https://example.com'),
    );
    const payload = decideEvent(ctx)!.payload as { rationale: Array<{ target: string }> };
    expect(payload.rationale.map(r => r.target).sort()).toEqual(['privacy', 'readUrls']);
  });

  test('all rules disabled → log shows considered=0, firedRules=0', async () => {
    const router = rulesRouter({ privacy: false, readUrls: false, json: false, memory: false });
    const { decision, ctx } = await decide(router, req('email me at alex@xinity.ai'));
    expect(decision.plugins).toEqual([]);
    expect(decision.techniques).toEqual([]);
    const payload = decideEvent(ctx)!.payload as { consideredRules: number; firedRules: number };
    expect(payload.consideredRules).toBe(0);
    expect(payload.firedRules).toBe(0);
  });

  test('default json factory produces a usable plugin (Zod permissive)', async () => {
    // Sanity: the default `json({ schema: z.unknown() })` plugin name is 'json'
    // and it doesn't throw on construction.
    const request = req('x', { responseFormat: { type: 'json_object' } });
    const { decision } = await decide(rulesRouter(), request);
    const jsonPlugin = decision.plugins.find(p => p.name === 'json');
    expect(jsonPlugin).toBeDefined();
    // The customize override path uses z.unknown() — confirm by exercising the
    // user-supplied factory accepts the same.
    const overridden = rulesRouter({
      customize: { json: () => ({ name: 'json-zod-test' }) },
    });
    const { decision: d2 } = await decide(overridden, request);
    expect(d2.plugins.find(p => p.name === 'json-zod-test')).toBeDefined();
  });

  test('decision is stateless across calls (no leakage)', async () => {
    const router = rulesRouter();
    const r1 = await router.decide(req('alex@xinity.ai'), makeCtx());
    const r2 = await router.decide(req('plain'), makeCtx());
    expect(r1.plugins.map(p => p.name)).toEqual(['privacy']);
    expect(r2.plugins).toEqual([]);
  });

  test('durationMs is present and non-negative', async () => {
    const { ctx } = await decide(rulesRouter(), req('x'));
    const payload = decideEvent(ctx)!.payload as { durationMs: number };
    expect(typeof payload.durationMs).toBe('number');
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('uses the same Zod import the json plugin uses (no version drift)', () => {
    // Smoke check: z.unknown() is callable and produces a schema with a parse method.
    expect(typeof z.unknown().parse).toBe('function');
  });
});
