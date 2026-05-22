import { describe, expect, test } from 'bun:test';
import { mergePluginSources, mergeTechniqueSources } from '../../src/router/merge.ts';
import type { Technique, Transform } from '../../src/types.ts';

// Tag each fake plugin with an `id` so we can assert which instance survived
// merging (a plain name check can't tell two `privacy()` instances apart).
const t = (name: string, id?: string): Transform & { id?: string } =>
  id !== undefined ? { name, id } : { name };
const names = (xs: { name: string }[]) => xs.map(x => x.name);
const ids = (xs: Array<{ name: string; id?: string }>) => xs.map(x => x.id);

describe('mergePluginSources — precedence matrix', () => {
  test('no sources → empty', () => {
    expect(mergePluginSources({})).toEqual([]);
  });

  test('router-only → router output (order preserved)', () => {
    const out = mergePluginSources({ router: [t('privacy'), t('readUrls')] });
    expect(names(out)).toEqual(['privacy', 'readUrls']);
  });

  test('opts-only → opts output', () => {
    const out = mergePluginSources({ opts: [t('json')] });
    expect(names(out)).toEqual(['json']);
  });

  test('explicit-only → explicit output', () => {
    const out = mergePluginSources({ explicit: [t('privacy')] });
    expect(names(out)).toEqual(['privacy']);
  });

  test('serverDefaults-only → defaults output', () => {
    const out = mergePluginSources({ serverDefaults: [t('json')] });
    expect(names(out)).toEqual(['json']);
  });

  test('router + serverDefaults → additive, both present', () => {
    const out = mergePluginSources({
      router: [t('privacy')],
      serverDefaults: [t('json')],
    });
    expect(names(out).sort()).toEqual(['json', 'privacy']);
  });

  test('router + serverDefaults: serverDefaults wins on name conflict', () => {
    const out = mergePluginSources({
      router: [t('privacy', 'from-router')],
      serverDefaults: [t('privacy', 'from-server')],
    });
    expect(out).toHaveLength(1);
    expect(ids(out as Array<{ name: string; id?: string }>)).toEqual(['from-server']);
  });

  test('router + serverDefaults: serverDefaults appear first', () => {
    const out = mergePluginSources({
      router: [t('readUrls')],
      serverDefaults: [t('privacy')],
    });
    expect(names(out)).toEqual(['privacy', 'readUrls']);
  });

  test('explicit replaces router', () => {
    const out = mergePluginSources({
      explicit: [t('readUrls')],
      router: [t('privacy')],
    });
    expect(names(out)).toEqual(['readUrls']);
  });

  test('explicit replaces serverDefaults', () => {
    const out = mergePluginSources({
      explicit: [t('readUrls')],
      serverDefaults: [t('privacy')],
    });
    expect(names(out)).toEqual(['readUrls']);
  });

  test('explicit replaces both router and serverDefaults', () => {
    const out = mergePluginSources({
      explicit: [t('json')],
      router: [t('privacy')],
      serverDefaults: [t('readUrls')],
    });
    expect(names(out)).toEqual(['json']);
  });

  test('explicit: [] (empty array) is an active signal — no plugins', () => {
    const out = mergePluginSources({
      explicit: [],
      router: [t('privacy')],
      serverDefaults: [t('readUrls')],
    });
    expect(out).toEqual([]);
  });

  test('opts replaces router and serverDefaults', () => {
    const out = mergePluginSources({
      opts: [t('json')],
      router: [t('privacy')],
      serverDefaults: [t('readUrls')],
    });
    expect(names(out)).toEqual(['json']);
  });

  test('opts: [] is an active signal — no plugins', () => {
    const out = mergePluginSources({
      opts: [],
      router: [t('privacy')],
    });
    expect(out).toEqual([]);
  });

  test('explicit wins over opts when both set', () => {
    const out = mergePluginSources({
      explicit: [t('privacy')],
      opts: [t('readUrls')],
      router: [t('json')],
    });
    expect(names(out)).toEqual(['privacy']);
  });

  test('disabled removes from explicit', () => {
    const out = mergePluginSources({
      explicit: [t('privacy'), t('readUrls')],
      disabled: ['privacy'],
    });
    expect(names(out)).toEqual(['readUrls']);
  });

  test('disabled removes from opts', () => {
    const out = mergePluginSources({
      opts: [t('privacy'), t('readUrls')],
      disabled: ['readUrls'],
    });
    expect(names(out)).toEqual(['privacy']);
  });

  test('disabled removes from router-only merged set', () => {
    const out = mergePluginSources({
      router: [t('privacy'), t('readUrls')],
      disabled: ['privacy'],
    });
    expect(names(out)).toEqual(['readUrls']);
  });

  test('disabled removes from additive router + serverDefaults', () => {
    const out = mergePluginSources({
      router: [t('privacy'), t('readUrls')],
      serverDefaults: [t('json')],
      disabled: ['privacy', 'json'],
    });
    expect(names(out)).toEqual(['readUrls']);
  });

  test('disabled with no matching names is a no-op', () => {
    const out = mergePluginSources({
      router: [t('privacy')],
      disabled: ['ghost'],
    });
    expect(names(out)).toEqual(['privacy']);
  });

  test('disabled with empty array is a no-op', () => {
    const out = mergePluginSources({
      router: [t('privacy')],
      disabled: [],
    });
    expect(names(out)).toEqual(['privacy']);
  });

  test('preserves referential identity of merged instances', () => {
    const inst = t('privacy', 'unique');
    const out = mergePluginSources({ router: [inst] });
    expect(out[0]).toBe(inst);
  });

  test('explicit replace: instance identity preserved from explicit, not from defaults', () => {
    const explicitInst = t('privacy', 'explicit');
    const defaultInst = t('privacy', 'default');
    const out = mergePluginSources({
      explicit: [explicitInst],
      serverDefaults: [defaultInst],
    });
    expect(out[0]).toBe(explicitInst);
  });

  test('dedupe within a single source: serverDefaults', () => {
    const a = t('privacy', 'a');
    const b = t('privacy', 'b');
    const out = mergePluginSources({ serverDefaults: [a, b] });
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(a);
  });

  test('dedupe within router and across router+defaults', () => {
    const out = mergePluginSources({
      router: [t('privacy', 'r1'), t('privacy', 'r2')],
      serverDefaults: [t('json', 'd1')],
    });
    // First privacy from router survives; serverDefaults contributes json.
    expect(out).toHaveLength(2);
    expect(names(out).sort()).toEqual(['json', 'privacy']);
  });

  test('serverDefaults can be undefined explicitly', () => {
    const out = mergePluginSources({
      router: [t('privacy')],
      serverDefaults: undefined,
    });
    expect(names(out)).toEqual(['privacy']);
  });

  test('three independent additive plugins keep insertion order: defaults then router', () => {
    const out = mergePluginSources({
      router: [t('readUrls'), t('json')],
      serverDefaults: [t('privacy')],
    });
    expect(names(out)).toEqual(['privacy', 'readUrls', 'json']);
  });
});

describe('mergeTechniqueSources — same semantics as plugins', () => {
  const tech = (name: string): Technique => ({
    name,
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: false,
      addsLatency: 'low',
      tokenMultiplier: 1,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },
    async apply(ctx) { return ctx.next(ctx.request); },
  });

  test('explicit replaces router (memory case)', () => {
    const out = mergeTechniqueSources({
      explicit: [tech('self-consistency')],
      router: [tech('memory')],
    });
    expect(names(out)).toEqual(['self-consistency']);
  });

  test('router + serverDefaults additive', () => {
    const out = mergeTechniqueSources({
      router: [tech('memory')],
      serverDefaults: [tech('self-consistency')],
    });
    expect(names(out).sort()).toEqual(['memory', 'self-consistency']);
  });

  test('disabled removes memory even when router activates it', () => {
    const out = mergeTechniqueSources({
      router: [tech('memory')],
      disabled: ['memory'],
    });
    expect(out).toEqual([]);
  });

  test('empty everything → empty', () => {
    expect(mergeTechniqueSources({})).toEqual([]);
  });
});
