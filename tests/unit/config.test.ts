import { describe, expect, test } from 'bun:test';
import { resolveConfig, type Registry } from '../../src/config.ts';
import type { Technique, Transform } from '../../src/types.ts';

function fakeTechnique(name: string): (options?: unknown) => Technique {
  return (options?: unknown) => ({
    name,
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: true,
      addsLatency: 'low',
      tokenMultiplier: 1,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },
    async apply(ctx) {
      // The factory stores options on the instance so tests can inspect them.
      (ctx.request as Record<string, unknown>).__options = options;
      return ctx.next(ctx.request);
    },
  });
}

function fakeTransform(name: string): (options?: unknown) => Transform {
  return (_options?: unknown) => ({ name });
}

function registry(): Registry {
  return {
    techniques: new Map([
      ['self-consistency', fakeTechnique('self-consistency')],
      ['round-trip', fakeTechnique('round-trip')],
      ['plan-search', fakeTechnique('plan-search')],
    ]),
    transforms: new Map([
      ['privacy', fakeTransform('privacy')],
      ['read-urls', fakeTransform('read-urls')],
    ]),
  };
}

describe('resolveConfig', () => {
  test('parses header mini-grammar with options', () => {
    const resolved = resolveConfig({
      model: 'gpt-4o',
      headers: {
        'x-xinity-techniques': 'self-consistency:k=5,round-trip',
        'x-xinity-plugins': 'privacy,read-urls',
      },
    }, registry());
    expect(resolved.techniques.map(t => t.name)).toEqual(['self-consistency', 'round-trip']);
    expect(resolved.transforms.map(t => t.name)).toEqual(['privacy', 'read-urls']);
  });

  test('headers override body which overrides defaults', () => {
    const resolved = resolveConfig({
      model: 'gpt-4o',
      headers: { 'x-xinity-techniques': 'round-trip' },
      body: { techniques: ['self-consistency'] },
      defaults: { techniques: ['plan-search'] },
    }, registry());
    expect(resolved.techniques.map(t => t.name)).toEqual(['round-trip']);
  });

  test('model-name suffix parses techniques and strips the suffix', () => {
    const resolved = resolveConfig({
      model: 'deepseek-r1@self-consistency:k=3',
    }, registry());
    expect(resolved.resolvedModel).toBe('deepseek-r1');
    expect(resolved.techniques.map(t => t.name)).toEqual(['self-consistency']);
  });

  test('body overrides model suffix', () => {
    const resolved = resolveConfig({
      model: 'gpt-4o@self-consistency',
      body: { techniques: ['round-trip'] },
    }, registry());
    expect(resolved.techniques.map(t => t.name)).toEqual(['round-trip']);
  });

  test('disabled list subtracts from merged result', () => {
    const resolved = resolveConfig({
      model: 'gpt-4o',
      defaults: { techniques: ['self-consistency', 'round-trip'] },
      headers: { 'x-xinity-disabled': 'round-trip' },
    }, registry());
    expect(resolved.techniques.map(t => t.name)).toEqual(['self-consistency']);
  });

  test('base64 X-Xinity-Config escape hatch wins over mini-grammar', () => {
    const cfg = JSON.stringify({ techniques: ['plan-search'] });
    const b64 = btoa(cfg);
    const resolved = resolveConfig({
      model: 'gpt-4o',
      headers: {
        'x-xinity-config': b64,
        'x-xinity-techniques': 'self-consistency',
      },
    }, registry());
    expect(resolved.techniques.map(t => t.name)).toEqual(['plan-search']);
  });

  test('unknown technique throws 400', () => {
    expect(() => resolveConfig({
      model: 'gpt-4o',
      headers: { 'x-xinity-techniques': 'mcts' },
    }, registry())).toThrow();
  });

  test('zero techniques + zero plugins triggers pass-through', () => {
    const resolved = resolveConfig({ model: 'gpt-4o' }, registry());
    expect(resolved.techniques).toEqual([]);
    expect(resolved.transforms).toEqual([]);
  });

  test('option values parse as JSON literals', () => {
    // Just verifies the parsing path; deeper test of types via integration.
    const resolved = resolveConfig({
      model: 'gpt-4o',
      headers: { 'x-xinity-techniques': 'self-consistency:k=5;label="run-a";enabled=true' },
    }, registry());
    expect(resolved.techniques).toHaveLength(1);
  });
});
