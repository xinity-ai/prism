import { describe, expect, test } from 'bun:test';
import { createGateway } from '../../src/server.ts';
import { privacy } from '../../src/plugins/privacy.ts';
import { readUrls } from '../../src/plugins/read-urls.ts';
import { json } from '../../src/plugins/json.ts';
import { z } from 'zod';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { FetchLike } from '../../src/upstream.ts';
import type { Logger, Transform } from '../../src/types.ts';

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

const eventsByName = (l: { events: LogEntry[] }, name: string) =>
  l.events.filter(e => e.event === name);

const okUpstream = () => createMockUpstream({
  complete: async () => fakeResponse('ok', { id: 'r1' }),
});

const postChat = (body: unknown) => new Request('http://x/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// Helper: factories that return the plugins, with a no-op fetch for read-urls
// so the test never makes a real HTTP call when the plugin activates.
const noopFetch: FetchLike = async () =>
  new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain' } });

const transformFactories = {
  privacy: () => privacy(),
  'read-urls': () => readUrls({ fetchImpl: noopFetch, maxUrls: 5 }),
  json: () => json({ schema: z.object({ ok: z.boolean() }) }),
};

// =============================================================================
// Auto-activation predicates wired to the three core plugins
// =============================================================================

describe('shouldActivate predicates — direct unit checks', () => {
  test('privacy.shouldActivate true when PII present', () => {
    const p = privacy();
    expect(p.shouldActivate!({
      model: 'm',
      messages: [{ role: 'user', content: 'contact me at alex@example.com' }],
    }, { match: /.*/, thinkingMode: false, supportsLogprobs: false })).toBe(true);
  });

  test('privacy.shouldActivate false without PII', () => {
    const p = privacy();
    expect(p.shouldActivate!({
      model: 'm',
      messages: [{ role: 'user', content: 'hello there' }],
    }, { match: /.*/, thinkingMode: false, supportsLogprobs: false })).toBe(false);
  });

  test('read-urls.shouldActivate true with a URL', () => {
    const r = readUrls({});
    expect(r.shouldActivate!({
      model: 'm',
      messages: [{ role: 'user', content: 'see https://example.com' }],
    }, { match: /.*/, thinkingMode: false, supportsLogprobs: false })).toBe(true);
  });

  test('read-urls.shouldActivate false without URL', () => {
    const r = readUrls({});
    expect(r.shouldActivate!({
      model: 'm',
      messages: [{ role: 'user', content: 'no links here' }],
    }, { match: /.*/, thinkingMode: false, supportsLogprobs: false })).toBe(false);
  });

  test('json.shouldActivate true when responseFormat present', () => {
    const j = json({ schema: z.object({ ok: z.boolean() }) });
    expect(j.shouldActivate!({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      responseFormat: { type: 'json_object' },
    }, { match: /.*/, thinkingMode: false, supportsLogprobs: false })).toBe(true);
  });

  test('json.shouldActivate true even without responseFormat (schema enforces always-JSON)', () => {
    const j = json({ schema: z.object({ ok: z.boolean() }) });
    expect(j.shouldActivate!({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
    }, { match: /.*/, thinkingMode: false, supportsLogprobs: false })).toBe(true);
  });
});

// =============================================================================
// Pipeline integration — autoActivatePlugins gates default plugins
// =============================================================================

describe('autoActivatePlugins flag', () => {
  test('off (default): all default plugins included regardless of predicate', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const gw = createGateway({
      upstream,
      logger,
      defaults: { plugins: ['privacy', 'read-urls'] },
      registry: { transforms: new Map<string, (o?: unknown) => Transform>(Object.entries(transformFactories)) },
    });

    await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'no PII or URLs here' }],
    }));

    expect(eventsByName(logger, 'plugin.auto-activated')).toHaveLength(0);
    expect(eventsByName(logger, 'plugin.auto-skipped')).toHaveLength(0);

    const received = eventsByName(logger, 'request.received')[0]!;
    expect(received.plugins).toEqual(['privacy', 'read-urls']);
  });

  test('on: default plugins gated by shouldActivate', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const gw = createGateway({
      upstream,
      logger,
      autoActivatePlugins: true,
      defaults: { plugins: ['privacy', 'read-urls'] },
      registry: { transforms: new Map<string, (o?: unknown) => Transform>(Object.entries(transformFactories)) },
    });

    await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'see https://example.com for context' }],
    }));

    // privacy → no PII → auto-skipped
    // read-urls → URL present → auto-activated
    const activated = eventsByName(logger, 'plugin.auto-activated');
    const skipped = eventsByName(logger, 'plugin.auto-skipped');
    expect(activated.map(e => e.plugin)).toEqual(['read-urls']);
    expect(skipped.map(e => e.plugin)).toEqual(['privacy']);

    const received = eventsByName(logger, 'request.received')[0]!;
    expect(received.plugins).toEqual(['read-urls']);
  });

  test('on + both predicates fire: both plugins included', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const gw = createGateway({
      upstream,
      logger,
      autoActivatePlugins: true,
      defaults: { plugins: ['privacy', 'read-urls'] },
      registry: { transforms: new Map<string, (o?: unknown) => Transform>(Object.entries(transformFactories)) },
    });

    await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'email alex@example.com about https://example.com' }],
    }));

    const activated = eventsByName(logger, 'plugin.auto-activated').map(e => e.plugin);
    expect(activated).toEqual(expect.arrayContaining(['privacy', 'read-urls']));
    expect(eventsByName(logger, 'plugin.auto-skipped')).toHaveLength(0);
  });

  test('explicit per-request plugins bypass auto-activation (explicit beats automation)', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const gw = createGateway({
      upstream,
      logger,
      autoActivatePlugins: true,
      defaults: { plugins: ['privacy'] },
      registry: { transforms: new Map<string, (o?: unknown) => Transform>(Object.entries(transformFactories)) },
    });

    await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'no PII or URLs here' }],
      xinity: { plugins: ['read-urls'] }, // explicit, no PII → would have been skipped by auto
    }));

    // Auto-activation is bypassed because the request is explicit.
    expect(eventsByName(logger, 'plugin.auto-activated')).toHaveLength(0);
    expect(eventsByName(logger, 'plugin.auto-skipped')).toHaveLength(0);

    const received = eventsByName(logger, 'request.received')[0]!;
    expect(received.plugins).toEqual(['read-urls']);
  });

  test('plugin without shouldActivate is always included under auto-activation', async () => {
    const upstream = okUpstream();
    const logger = makeCapturingLogger();
    const bare: Transform = {
      name: 'bare',
      async pre(req) { return req; },
    };
    const gw = createGateway({
      upstream,
      logger,
      autoActivatePlugins: true,
      defaults: { plugins: ['bare'] },
      registry: { transforms: new Map([['bare', () => bare]]) },
    });

    await gw.fetch(postChat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    // No predicate → no skip/activate events; plugin is always included.
    expect(eventsByName(logger, 'plugin.auto-activated')).toHaveLength(0);
    expect(eventsByName(logger, 'plugin.auto-skipped')).toHaveLength(0);
    const received = eventsByName(logger, 'request.received')[0]!;
    expect(received.plugins).toEqual(['bare']);
  });
});
