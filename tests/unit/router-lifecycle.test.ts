import { describe, expect, test } from 'bun:test';
import { createGateway } from '../../src/server.ts';
import type { Router } from '../../src/router.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { Logger } from '../../src/types.ts';

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
  raw: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
});

const postChat = (body: unknown) => new Request('http://x/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function lifecycleRouter(): Router & { initCalls: number; closeCalls: number; decideCalls: number } {
  const r = {
    name: 'lifecycle',
    initCalls: 0,
    closeCalls: 0,
    decideCalls: 0,
    async init() {
      r.initCalls++;
      await new Promise(res => setTimeout(res, 5));
    },
    async close() {
      r.closeCalls++;
    },
    async decide() {
      r.decideCalls++;
      return { techniques: [], reason: 'noop' };
    },
  };
  return r;
}

describe('router lifecycle', () => {
  test('init() runs lazily on first request', async () => {
    const router = lifecycleRouter();
    const gw = createGateway({ upstream: okUpstream(), logger: makeCapturingLogger(), router });
    expect(router.initCalls).toBe(0); // not yet
    await gw.fetch(postChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    expect(router.initCalls).toBe(1);
  });

  test('init() is shared across concurrent requests (memoized)', async () => {
    const router = lifecycleRouter();
    const gw = createGateway({ upstream: okUpstream(), logger: makeCapturingLogger(), router });
    await Promise.all([
      gw.fetch(postChat({ model: 'm', messages: [{ role: 'user', content: 'a' }] })),
      gw.fetch(postChat({ model: 'm', messages: [{ role: 'user', content: 'b' }] })),
      gw.fetch(postChat({ model: 'm', messages: [{ role: 'user', content: 'c' }] })),
    ]);
    expect(router.initCalls).toBe(1);
    expect(router.decideCalls).toBe(3);
  });

  test('router.init log event emitted with duration_ms', async () => {
    const router = lifecycleRouter();
    const logger = makeCapturingLogger();
    const gw = createGateway({ upstream: okUpstream(), logger, router });
    await gw.fetch(postChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    const init = eventsByName(logger, 'router.init');
    expect(init).toHaveLength(1);
    expect(init[0]!.router).toBe('lifecycle');
    expect(typeof init[0]!.duration_ms).toBe('number');
  });

  test('Gateway.close() calls router.close() and logs router.close', async () => {
    const router = lifecycleRouter();
    const logger = makeCapturingLogger();
    const gw = createGateway({ upstream: okUpstream(), logger, router });
    await gw.fetch(postChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    await gw.close();
    expect(router.closeCalls).toBe(1);
    expect(eventsByName(logger, 'router.close')).toHaveLength(1);
  });

  test('Gateway.close() is idempotent — multiple calls do not re-close router', async () => {
    const router = lifecycleRouter();
    const gw = createGateway({ upstream: okUpstream(), logger: makeCapturingLogger(), router });
    await gw.fetch(postChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    await gw.close();
    await gw.close();
    await gw.close();
    expect(router.closeCalls).toBe(1);
  });

  test('router without init/close still works (no lifecycle calls)', async () => {
    const minimal: Router = {
      name: 'minimal',
      async decide() { return { techniques: [], reason: 'minimal' }; },
    };
    const logger = makeCapturingLogger();
    const gw = createGateway({ upstream: okUpstream(), logger, router: minimal });
    await gw.fetch(postChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    expect(eventsByName(logger, 'router.init')).toHaveLength(0);
    await gw.close();
    expect(eventsByName(logger, 'router.close')).toHaveLength(0);
  });
});
