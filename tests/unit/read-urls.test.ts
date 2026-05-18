import { describe, expect, test } from 'bun:test';
import { readUrls, __internal } from '../../src/plugins/read-urls.ts';
import { htmlToText } from '../../src/internal/html-to-text.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream } from '../../src/internal/mock-upstream.ts';
import type { ChatRequest, TransformState } from '../../src/types.ts';

const state = (): TransformState => ({
  store: new Map(),
  logger: silentLogger,
  signal: new AbortController().signal,
  upstream: createMockUpstream({}),
  modelProfile: { match: /.*/, thinkingMode: false, supportsLogprobs: false },
});

describe('htmlToText', () => {
  test('strips tags and decodes entities', () => {
    const html = '<html><body><h1>Title</h1><p>Hello &amp; <b>world</b>.</p><script>alert(1)</script></body></html>';
    expect(htmlToText(html)).toBe('Title\nHello & world.');
  });
  test('drops script/style blocks entirely', () => {
    expect(htmlToText('a<style>.x{color:red}</style>b')).toBe('ab');
  });
  test('inserts newlines for block-level tags', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });
  test('decodes numeric character references', () => {
    expect(htmlToText('caf&#233; &#x263A;')).toBe('café ☺');
  });
});

describe('URL extraction', () => {
  test('finds http and https URLs and dedupes', () => {
    const urls = __internal.extractUrls([
      { role: 'user', content: 'see https://example.com and http://x.test/path?q=1' },
      { role: 'user', content: 'also https://example.com' },
    ]);
    expect(urls).toEqual(['https://example.com', 'http://x.test/path?q=1']);
  });

  test('trims trailing punctuation', () => {
    expect(__internal.trimTrailingPunct('https://example.com.')).toBe('https://example.com');
    expect(__internal.trimTrailingPunct('https://x.test)')).toBe('https://x.test');
  });
});

describe('readUrls.pre', () => {
  test('no URLs → request unchanged', async () => {
    const plug = readUrls({ fetchImpl: (async () => new Response('x')) });
    const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const out = await plug.pre!(req, state());
    expect(out.messages).toBe(req.messages);
  });

  test('fetches HTML and prepends a system context message', async () => {
    const html = '<html><body><h1>Title</h1><p>Body text.</p></body></html>';
    const plug = readUrls({
      fetchImpl: (async (input: Request | string | URL) => {
        expect(String(input)).toBe('https://example.com/page');
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }),
    });
    const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'summarize https://example.com/page' }] };
    const out = await plug.pre!(req, state());
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]!.role).toBe('system');
    const sys = out.messages[0]!.content as string;
    expect(sys).toContain('https://example.com/page');
    expect(sys).toContain('Title');
    expect(sys).toContain('Body text');
  });

  test('skips unsupported content-types and logs an error', async () => {
    const plug = readUrls({
      fetchImpl: (async () => new Response('PDF-binary-bytes', {
        status: 200, headers: { 'content-type': 'application/pdf' },
      })),
    });
    const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'see https://x.test/file.pdf' }] };
    const out = await plug.pre!(req, state());
    // Nothing prepended when no URL succeeded.
    expect(out.messages).toHaveLength(1);
  });

  test('respects maxUrls cap', async () => {
    let calls = 0;
    const plug = readUrls({
      maxUrls: 2,
      fetchImpl: (async () => { calls += 1; return new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } }); }),
    });
    const req: ChatRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'https://a.test https://b.test https://c.test' }],
    };
    await plug.pre!(req, state());
    expect(calls).toBe(2);
  });

  test('caps body size at maxBytes', async () => {
    const big = '<p>' + 'x'.repeat(50_000) + '</p>';
    const plug = readUrls({
      maxBytes: 1024,
      fetchImpl: (async () => new Response(big, { headers: { 'content-type': 'text/html' } })),
    });
    const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'https://x.test' }] };
    const out = await plug.pre!(req, state());
    const sys = out.messages[0]!.content as string;
    // Stripped HTML of capped body should not contain the full 50k-char run.
    expect(sys.length).toBeLessThan(big.length);
  });
});
