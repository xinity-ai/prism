import { describe, expect, test } from 'bun:test';
import { pipelineRun } from '../../src/pipeline.ts';
import { rulesRouter } from '../../src/router/rules.ts';
import { readUrls } from '../../src/plugins/read-urls.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { ChatRequest, Logger, ModelProfile } from '../../src/types.ts';
import type { FetchLike } from '../../src/upstream.ts';

// ----- helpers ---------------------------------------------------------------

type CapturedLog = { level: 'info' | 'warn' | 'error'; payload: Record<string, unknown> };
const capturingLogger = (): Logger & { events: CapturedLog[] } => {
  const events: CapturedLog[] = [];
  const self: Logger & { events: CapturedLog[] } = {
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

const makeReq = (content: string, xinity?: ChatRequest['xinity']): ChatRequest => ({
  model: 'mock',
  messages: [{ role: 'user', content }],
  ...(xinity !== undefined && { xinity }),
});

// Build a fake FetchLike that returns canned content for a URL.
const mockFetch = (body: string, contentType = 'text/plain'): FetchLike =>
  async (_url, _opts) => new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });

// ----- 1. byte-for-byte transparent when no auto -----------------------------

describe('integration — no auto / no router', () => {
  test('without xinity.auto, the router is not consulted even if configured', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('ok'),
    });
    const logger = capturingLogger();
    const router = rulesRouter();

    // Spy: wrap decide so we can detect if it was called.
    let decideCalls = 0;
    const spyRouter = { ...router, decide: async (...args: Parameters<typeof router.decide>) => {
      decideCalls += 1;
      return router.decide(...args);
    } };

    await pipelineRun({
      request: makeReq('email me at alex@xinity.ai'), // PII present but auto absent
      router: spyRouter,
      upstream,
      modelProfile: profile(),
      logger,
      signal: new AbortController().signal,
    });

    expect(decideCalls).toBe(0);
    // Upstream saw the raw content because no plugin activated.
    expect((upstream.completeCalls[0]!.messages[0]!.content as string)).toBe('email me at alex@xinity.ai');
  });
});

// ----- 2. auto + PII → privacy activates -------------------------------------

describe('integration — auto: plugins + PII', () => {
  test('privacy plugin redacts for upstream, restores in response', async () => {
    const upstream = createMockUpstream({
      complete: async (req) => {
        // Echo back whatever PII placeholder appears in the request.
        const text = req.messages[0]!.content as string;
        return fakeResponse(`acknowledged: ${text}`);
      },
    });

    const response = await pipelineRun({
      request: makeReq('contact alex@xinity.ai today', { auto: 'plugins' }),
      router: rulesRouter(),
      upstream,
      modelProfile: profile(),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });

    // Upstream received redacted content.
    const upstreamText = upstream.completeCalls[0]!.messages[0]!.content as string;
    expect(upstreamText).not.toContain('alex@xinity.ai');
    expect(upstreamText).toMatch(/\[XINITY_PII_EMAIL_\d+\]/);

    // Response restored: the original email is back in the assistant message.
    const replyText = response.choices[0]!.message.content as string;
    expect(replyText).toContain('alex@xinity.ai');
    expect(replyText).not.toMatch(/\[XINITY_PII_EMAIL_\d+\]/);
  });

  test('router.decide log event is emitted exactly once', async () => {
    const upstream = createMockUpstream({ complete: async () => fakeResponse('ok') });
    const logger = capturingLogger();
    await pipelineRun({
      request: makeReq('alex@xinity.ai', { auto: 'plugins' }),
      router: rulesRouter(),
      upstream,
      modelProfile: profile(),
      logger,
      signal: new AbortController().signal,
    });
    const decideEvents = logger.events.filter(
      e => (e.payload as { event?: string }).event === 'router.decide',
    );
    expect(decideEvents).toHaveLength(1);
    const payload = decideEvents[0]!.payload as { activatedPlugins: string[] };
    expect(payload.activatedPlugins).toContain('privacy');
  });
});

// ----- 3. auto + URL → readUrls activates, context injected ------------------

describe('integration — auto: plugins + URLs', () => {
  test('readUrls fetches content and prepends a system message', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('ok'),
    });
    const fetchImpl = mockFetch('FETCHED_BODY_FROM_MOCK');

    const router = rulesRouter({
      customize: { readUrls: () => readUrls({ fetchImpl, maxBytes: 1_000_000 }) },
    });

    await pipelineRun({
      request: makeReq('summarize https://example.com/doc', { auto: 'plugins' }),
      router,
      upstream,
      modelProfile: profile(),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });

    const req = upstream.completeCalls[0]!;
    expect(req.messages[0]!.role).toBe('system');
    expect(req.messages[0]!.content as string).toContain('FETCHED_BODY_FROM_MOCK');
    expect(req.messages[1]!.role).toBe('user');
  });
});

// ----- 4. explicit xinity.plugins: [] wins over router -----------------------

describe('integration — explicit transforms override router', () => {
  test('explicit empty plugin list disables router contributions even with auto: plugins', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('ok'),
    });

    await pipelineRun({
      request: makeReq('contact alex@xinity.ai', { auto: 'plugins' }),
      // Caller declares "exactly these plugins" (none) — replace mode wins
      // even though the router would have activated privacy.
      transforms: [],
      router: rulesRouter(),
      upstream,
      modelProfile: profile(),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });

    const text = upstream.completeCalls[0]!.messages[0]!.content as string;
    expect(text).toBe('contact alex@xinity.ai'); // No redaction.
  });
});

// ----- 5. disabled removes from router output --------------------------------

describe('integration — disabled removes router output', () => {
  test('xinity.disabled: [privacy] strips the router-activated plugin', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('ok'),
    });

    await pipelineRun({
      request: makeReq('contact alex@xinity.ai', {
        auto: 'plugins',
        disabled: ['privacy'],
      }),
      router: rulesRouter(),
      upstream,
      modelProfile: profile(),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });

    const text = upstream.completeCalls[0]!.messages[0]!.content as string;
    expect(text).toBe('contact alex@xinity.ai'); // Still raw — disabled wins.
  });
});

// ----- 6. multiple rules fire on one request ---------------------------------

describe('integration — multiple rules fire together', () => {
  test('PII and URL both activate; upstream sees redaction + system message', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('done'),
    });
    const fetchImpl = mockFetch('PAGE_TEXT');
    const router = rulesRouter({
      customize: { readUrls: () => readUrls({ fetchImpl }) },
    });

    await pipelineRun({
      request: makeReq('email alex@xinity.ai about https://example.com', { auto: 'plugins' }),
      router,
      upstream,
      modelProfile: profile(),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });

    const req = upstream.completeCalls[0]!;
    expect(req.messages[0]!.role).toBe('system');
    expect(req.messages[0]!.content as string).toContain('PAGE_TEXT');
    expect(req.messages[1]!.content as string).toMatch(/\[XINITY_PII_EMAIL_\d+\]/);
  });
});

// ----- 7. memory technique on context overflow -------------------------------

describe('integration — memory technique on context overflow', () => {
  test('large input triggers memory chunking when auto: plugins', async () => {
    // Build an upstream that returns "NO#" for every margin extraction
    // (so we just verify memory ran, not its synthesis quality).
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('NO#'),
    });

    const document = 'a'.repeat(10_000); // ~2500 tokens
    // contextWindow=1000 → threshold=700 → document way over.
    await pipelineRun({
      request: makeReq(document, { auto: 'plugins' }),
      router: rulesRouter(),
      upstream,
      modelProfile: profile(1000),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });

    // Memory chunks the doc then re-issues. Multiple upstream calls indicate chunking.
    expect(upstream.completeCalls.length).toBeGreaterThan(1);
  });

  test('memory does NOT fire without auto: plugins (router not consulted)', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('ok'),
    });
    const document = 'a'.repeat(10_000);
    await pipelineRun({
      request: makeReq(document), // no auto
      router: rulesRouter(),
      upstream,
      modelProfile: profile(1000),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });
    // Single upstream call — memory technique didn't run.
    expect(upstream.completeCalls).toHaveLength(1);
  });
});

// ----- 8. router-not-configured: byte-for-byte v0.1 --------------------------

describe('integration — router not configured', () => {
  test('auto: plugins is silently ignored when no router is provided', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('ok'),
    });
    const logger = capturingLogger();

    await pipelineRun({
      request: makeReq('alex@xinity.ai', { auto: 'plugins' }),
      // no router param
      upstream,
      modelProfile: profile(),
      logger,
      signal: new AbortController().signal,
    });

    // No redaction, no router.decide log.
    expect((upstream.completeCalls[0]!.messages[0]!.content as string)).toBe('alex@xinity.ai');
    const decideEvents = logger.events.filter(
      e => (e.payload as { event?: string }).event === 'router.decide',
    );
    expect(decideEvents).toHaveLength(0);
  });
});

// ----- 9. serverDefaults additive with router --------------------------------

describe('integration — serverDefaults + router additive', () => {
  test('serverDefaults plugins + router plugins both fire (dedupe by name)', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('done'),
    });
    const fetchImpl = mockFetch('FROM_SERVER_DEFAULTS');

    // Server default already wires read-urls with the mock fetch.
    // Router would also try to activate read-urls (URL present), but dedupe
    // by name keeps the operator's configured instance.
    await pipelineRun({
      request: makeReq('see https://example.com', { auto: 'plugins' }),
      router: rulesRouter(),
      serverDefaults: {
        transforms: [readUrls({ fetchImpl })],
      },
      upstream,
      modelProfile: profile(),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });

    const req = upstream.completeCalls[0]!;
    // The server's configured readUrls instance won, so its mock fetch was used.
    expect(req.messages[0]!.content as string).toContain('FROM_SERVER_DEFAULTS');
  });

  test('serverDefaults applied without router when auto absent', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('done'),
    });
    const fetchImpl = mockFetch('PRE_FETCHED');

    await pipelineRun({
      request: makeReq('see https://example.com'), // no auto
      serverDefaults: { transforms: [readUrls({ fetchImpl })] },
      upstream,
      modelProfile: profile(),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });

    expect(upstream.completeCalls[0]!.messages[0]!.content as string).toContain('PRE_FETCHED');
  });
});

// ----- 10. v0.1 path identical when caller passes pre-merged transforms ------

describe('integration — v0.1 path (no router, transforms passed directly)', () => {
  test('explicit transforms verbatim, no router params → identical to v0.1', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('ok'),
    });
    const fetchImpl = mockFetch('FETCHED');

    await pipelineRun({
      request: makeReq('see https://example.com'),
      transforms: [readUrls({ fetchImpl })],
      upstream,
      modelProfile: profile(),
      logger: capturingLogger(),
      signal: new AbortController().signal,
    });

    expect(upstream.completeCalls[0]!.messages[0]!.content as string).toContain('FETCHED');
  });
});
