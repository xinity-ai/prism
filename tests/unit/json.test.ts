import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { json } from '../../src/plugins/json.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { TransformState } from '../../src/types.ts';

const userSchema = z.object({ name: z.string(), age: z.number() });

const baseState = (upstream = createMockUpstream({})): TransformState => ({
  store: new Map(),
  logger: silentLogger,
  signal: new AbortController().signal,
  upstream,
  modelProfile: { match: /.*/, thinkingMode: false, supportsLogprobs: false },
});

describe('json plugin', () => {
  test('valid JSON passes through unchanged', async () => {
    const plug = json({ schema: userSchema });
    const resp = fakeResponse('{"name":"Alex","age":30}');
    const out = await plug.post!(resp, baseState());
    expect(JSON.parse(out.choices[0]!.message.content as string)).toEqual({ name: 'Alex', age: 30 });
  });

  test('extracts JSON from a fenced code block', async () => {
    const plug = json({ schema: userSchema });
    const resp = fakeResponse('Sure!\n```json\n{"name":"Alex","age":30}\n```\nlet me know if that helps.');
    const out = await plug.post!(resp, baseState());
    expect(JSON.parse(out.choices[0]!.message.content as string)).toEqual({ name: 'Alex', age: 30 });
  });

  test('calls upstream to reformat when freeform answer does not validate', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('{"name":"Alex","age":30}'),
    });
    const plug = json({ schema: userSchema });
    const resp = fakeResponse('The user is Alex, age 30.');
    const out = await plug.post!(resp, baseState(upstream));
    expect(upstream.completeCalls).toHaveLength(1);
    expect(JSON.parse(out.choices[0]!.message.content as string)).toEqual({ name: 'Alex', age: 30 });
  });

  test('returns original response when reformat keeps failing', async () => {
    const upstream = createMockUpstream({
      complete: async () => fakeResponse('still not json'),
    });
    const plug = json({ schema: userSchema, retries: 2 });
    const resp = fakeResponse('totally prose');
    const out = await plug.post!(resp, baseState(upstream));
    expect(upstream.completeCalls).toHaveLength(2);
    expect(out.choices[0]!.message.content).toBe('totally prose');
  });

  test('pre-transform forces stream:false', async () => {
    const plug = json({ schema: userSchema });
    const req = { model: 'm', messages: [], stream: true };
    const out = await plug.pre!(req, baseState());
    expect(out.stream).toBe(false);
  });
});
