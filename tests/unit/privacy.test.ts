import { describe, expect, test } from 'bun:test';
import { privacy } from '../../src/plugins/privacy.ts';
import { defaultDetector } from '../../src/internal/pii-detector.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { ChatRequest, TransformState } from '../../src/types.ts';

const state = (): TransformState => ({
  store: new Map(),
  logger: silentLogger,
  signal: new AbortController().signal,
  upstream: createMockUpstream({}),
  modelProfile: { match: /.*/, thinkingMode: false, supportsLogprobs: false },
});

const baseReq = (content: string): ChatRequest => ({
  model: 'm',
  messages: [{ role: 'user', content }],
});

describe('privacy plugin — detection & redaction', () => {
  test('redacts email addresses', () => {
    const found = defaultDetector('contact me at alex@xinity.ai and az@example.com');
    expect(found.map(m => m.type)).toEqual(['EMAIL', 'EMAIL']);
  });

  test('redacts phone numbers in E.164 and national formats', () => {
    const found = defaultDetector('call +43 660 1234567 or 555-123-4567');
    expect(found.some(m => m.type === 'PHONE')).toBe(true);
  });

  test('Luhn-validates credit card candidates', () => {
    // 4111 1111 1111 1111 is a known Luhn-valid test card. 1234 5678 9012 3456 is not.
    const found = defaultDetector('valid 4111 1111 1111 1111 invalid 1234 5678 9012 3456');
    const cards = found.filter(m => m.type === 'CREDIT_CARD');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.value).toBe('4111 1111 1111 1111');
  });

  test('detects IBANs', () => {
    const found = defaultDetector('IBAN: AT611904300234573201');
    expect(found.some(m => m.type === 'IBAN' && m.value === 'AT611904300234573201')).toBe(true);
  });

  test('pre-transform replaces PII with stable typed placeholders', async () => {
    const plug = privacy();
    const s = state();
    const out = await plug.pre!(baseReq('Email alex@xinity.ai about IBAN AT611904300234573201'), s);
    const text = (out.messages[0]!.content as string);
    expect(text).toContain('[XINITY_PII_EMAIL_0]');
    expect(text).toContain('[XINITY_PII_IBAN_0]');
    expect(text).not.toContain('alex@xinity.ai');
    expect(text).not.toContain('AT611904300234573201');
  });

  test('same PII value reuses the same placeholder across messages', async () => {
    const plug = privacy();
    const s = state();
    const req: ChatRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: 'send to alex@xinity.ai' },
        { role: 'user', content: 'cc alex@xinity.ai again' },
      ],
    };
    const out = await plug.pre!(req, s);
    const a = out.messages[0]!.content as string;
    const b = out.messages[1]!.content as string;
    expect(a).toContain('[XINITY_PII_EMAIL_0]');
    expect(b).toContain('[XINITY_PII_EMAIL_0]');
    // No EMAIL_1 should appear for a duplicate.
    expect(a.includes('EMAIL_1') || b.includes('EMAIL_1')).toBe(false);
  });

  test('post-transform restores placeholders in the response content', async () => {
    const plug = privacy();
    const s = state();
    await plug.pre!(baseReq('reach me at alex@xinity.ai'), s);
    const resp = fakeResponse('I will email [XINITY_PII_EMAIL_0] shortly.');
    const restored = await plug.post!(resp, s);
    expect(restored.choices[0]!.message.content).toBe('I will email alex@xinity.ai shortly.');
  });

  test('post-transform on streaming chunks restores placeholders', async () => {
    const plug = privacy();
    const s = state();
    await plug.pre!(baseReq('account 4111 1111 1111 1111'), s);
    const chunk = {
      id: 'c1',
      choices: [{
        index: 0,
        delta: { content: 'Charging card [XINITY_PII_CREDIT_CARD_0] now' },
        finishReason: null,
      }],
    };
    const restored = await plug.postChunk!(chunk, s);
    expect(restored.choices[0]!.delta.content).toBe('Charging card 4111 1111 1111 1111 now');
  });

  test('no PII in the input means no transformation of the response', async () => {
    const plug = privacy();
    const s = state();
    await plug.pre!(baseReq('just say hi'), s);
    const resp = fakeResponse('hi');
    const restored = await plug.post!(resp, s);
    expect(restored.choices[0]!.message.content).toBe('hi');
  });
});
