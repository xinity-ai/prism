import { describe, expect, test } from 'bun:test';
import {
  detectAll,
  detectContextOverflow,
  detectPii,
  detectUrls,
  extractFeatures,
} from '../../src/internal/detection/index.ts';
import type { ChatRequest } from '../../src/types.ts';

const req = (...contents: Array<string | ChatRequest['messages'][number]>): ChatRequest => ({
  model: 'm',
  messages: contents.map(c => typeof c === 'string' ? { role: 'user' as const, content: c } : c),
});

describe('extractFeatures', () => {
  test('concatenates text from string-content messages', () => {
    const f = extractFeatures(req('hello', 'world'));
    expect(f.text).toBe('hello\nworld');
    expect(f.messageCount).toBe(2);
    expect(f.tokenEstimate).toBe(Math.ceil('hello\nworld'.length / 4));
  });

  test('extracts text parts from array content; ignores images', () => {
    const f = extractFeatures(req({
      role: 'user',
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image_url', image_url: { url: 'data:...' } },
        { type: 'text', text: 'picture' },
      ],
    }));
    expect(f.text).toBe('see this\npicture');
  });

  test('skips null/undefined content', () => {
    const f = extractFeatures({
      model: 'm',
      messages: [
        { role: 'assistant', content: null },
        { role: 'user', content: 'real' },
        { role: 'tool', content: undefined, toolCallId: 'x' },
      ],
    });
    expect(f.text).toBe('real');
    expect(f.messageCount).toBe(3);
  });

  test('empty request → empty text, zero tokens', () => {
    const f = extractFeatures({ model: 'm', messages: [] });
    expect(f.text).toBe('');
    expect(f.tokenEstimate).toBe(0);
  });
});

describe('detectPii', () => {
  test('fires on email', () => {
    const r = req('contact alex@xinity.ai for details');
    const sig = detectPii(r, extractFeatures(r));
    expect(sig.match).toBe(true);
    expect(sig.name).toBe('pii');
    expect(sig.reason).toContain('email');
    expect(sig.details?.count).toBe(1);
  });

  test('aggregates counts across types', () => {
    const r = req('email a@b.com and a@b.com again, card 4111 1111 1111 1111');
    const sig = detectPii(r, extractFeatures(r));
    expect(sig.match).toBe(true);
    // 2 emails + 1 card; same string "a@b.com" still matches twice in regex pass.
    expect((sig.details?.count as number) >= 2).toBe(true);
  });

  test('does not fire on benign text', () => {
    const r = req('what is the capital of France?');
    const sig = detectPii(r, extractFeatures(r));
    expect(sig.match).toBe(false);
    expect(sig.reason).toBe('no PII detected');
  });

  test('honors custom detector override', () => {
    const r = req('whatever');
    const sig = detectPii(r, extractFeatures(r), {
      detector: () => [{ type: 'EMAIL', start: 0, end: 4, value: 'fake' }],
    });
    expect(sig.match).toBe(true);
  });
});

describe('detectUrls', () => {
  test('fires on a single URL', () => {
    const r = req('see https://example.com/report.pdf for context');
    const sig = detectUrls(r, extractFeatures(r));
    expect(sig.match).toBe(true);
    expect(sig.reason).toContain('https://example.com/report.pdf');
    expect(sig.details?.count).toBe(1);
  });

  test('strips trailing punctuation', () => {
    const r = req('go to https://example.com.');
    const sig = detectUrls(r, extractFeatures(r));
    expect(sig.match).toBe(true);
    expect((sig.details?.urls as string[])[0]).toBe('https://example.com');
  });

  test('dedupes repeated URLs', () => {
    const r = req('https://a.test and https://a.test again');
    const sig = detectUrls(r, extractFeatures(r));
    expect(sig.details?.count).toBe(1);
  });

  test('does not fire when no URL present', () => {
    const r = req('plain text here');
    const sig = detectUrls(r, extractFeatures(r));
    expect(sig.match).toBe(false);
  });

  test('reports count when multiple URLs', () => {
    const r = req('https://a.test and https://b.test');
    const sig = detectUrls(r, extractFeatures(r));
    expect(sig.match).toBe(true);
    expect(sig.details?.count).toBe(2);
    expect(sig.reason).toContain('2 URLs');
  });
});

describe('detectContextOverflow', () => {
  test('does not fire without a contextWindow', () => {
    const r = req('x'.repeat(100_000));
    const sig = detectContextOverflow(r, extractFeatures(r));
    expect(sig.match).toBe(false);
    expect(sig.reason).toContain('no contextWindow');
  });

  test('does not fire below the threshold', () => {
    const r = req('short');
    const sig = detectContextOverflow(r, extractFeatures(r), { contextWindow: 8000 });
    expect(sig.match).toBe(false);
  });

  test('fires when token estimate ≥ ratio × contextWindow', () => {
    // 8000 chars ≈ 2000 tokens; threshold = 0.7 × 2000 = 1400 → fires.
    const r = req('a'.repeat(8000));
    const sig = detectContextOverflow(r, extractFeatures(r), { contextWindow: 2000 });
    expect(sig.match).toBe(true);
    expect(sig.details?.contextWindow).toBe(2000);
    expect(sig.details?.ratio).toBe(0.7);
  });

  test('honors custom ratio', () => {
    // 4000 chars ≈ 1000 tokens; ratio 0.1 of 2000 = 200 → fires.
    const r = req('a'.repeat(4000));
    const sig = detectContextOverflow(r, extractFeatures(r), { contextWindow: 2000, ratio: 0.1 });
    expect(sig.match).toBe(true);
  });

  test('does not fire when exactly below threshold with custom ratio', () => {
    // ~1000 tokens, ratio 0.9 × 2000 = 1800 → does not fire.
    const r = req('a'.repeat(4000));
    const sig = detectContextOverflow(r, extractFeatures(r), { contextWindow: 2000, ratio: 0.9 });
    expect(sig.match).toBe(false);
  });
});

describe('detectAll', () => {
  test('returns one signal per detector, in stable order', () => {
    const r = req('hello');
    const signals = detectAll(r);
    expect(signals.map(s => s.name)).toEqual(['pii', 'urls', 'context-overflow']);
  });

  test('mixes matches and non-matches in one pass', () => {
    const r = req('email me at a@b.com and visit https://example.com');
    const signals = detectAll(r);
    const byName = Object.fromEntries(signals.map(s => [s.name, s]));
    expect(byName.pii!.match).toBe(true);
    expect(byName.urls!.match).toBe(true);
    expect(byName['context-overflow']!.match).toBe(false);
  });

  test('reuses pre-computed features without re-extracting', () => {
    const r = req('hello');
    const features = extractFeatures(r);
    const signals = detectAll(r, features);
    expect(signals).toHaveLength(3);
  });

  test('threads options through to individual detectors', () => {
    const r = req('a'.repeat(8000));
    const signals = detectAll(r, undefined, { contextOverflow: { contextWindow: 2000 } });
    expect(signals.find(s => s.name === 'context-overflow')!.match).toBe(true);
  });
});
