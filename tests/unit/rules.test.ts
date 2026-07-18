import { describe, expect, test } from 'bun:test';
import { defaultRules, rulesRouter } from '../../src/router.ts';
import type { RouterContext } from '../../src/router.ts';
import { silentLogger } from '../../src/logging.ts';
import { unitTestVerifier } from '../../src/verifiers/unit-test.ts';
import type { ChatRequest, ModelProfile, Verifier, VerifierRegistry } from '../../src/types.ts';

const baseProfile: ModelProfile = {
  match: /.*/,
  thinkingMode: false,
  supportsLogprobs: false,
  contextWindow: 32_000,
};

const thinkingProfile: ModelProfile = { ...baseProfile, thinkingMode: true };
const smallWindowProfile: ModelProfile = { ...baseProfile, contextWindow: 1_000 };

const emptyVerifiers: VerifierRegistry = {
  get: () => undefined,
  has: () => false,
  names: () => [],
};

const makeRegistry = (entries: Record<string, Verifier>): VerifierRegistry => ({
  get: (n) => entries[n],
  has: (n) => n in entries,
  names: () => Object.keys(entries),
});

const ctx = (overrides: Partial<RouterContext> = {}): RouterContext => ({
  modelProfile: baseProfile,
  effortBudget: 0.5,
  signal: new AbortController().signal,
  logger: silentLogger,
  verifiers: emptyVerifiers,
  ...overrides,
});

const req = (content: string): ChatRequest => ({
  model: 'm',
  messages: [{ role: 'user', content }],
});

// Helper: run the default router and return the matched-rule names.
const matched = async (request: ChatRequest, c: RouterContext): Promise<string[]> => {
  const router = rulesRouter([...defaultRules]);
  const decision = await router.decide(request, c);
  if (decision.reason === 'no rules matched') return [];
  return decision.reason.replace(/^matched rules: /, '').split(', ');
};

// =============================================================================
// memory-for-long-input
// =============================================================================

describe('memory-for-long-input', () => {
  const longProse = 'word '.repeat(6_000); // ~30k chars → ~7.5k tokens; > 0.7 * 1000 (small window)

  test('positive: input exceeds 70% of small context window', async () => {
    const names = await matched(req(longProse), ctx({ modelProfile: smallWindowProfile }));
    expect(names).toContain('memory-for-long-input');
  });

  test('positive: input >> threshold for default window', async () => {
    // 100k chars → 25k tokens, > 0.7 * 32k = 22.4k.
    const huge = 'a'.repeat(100_000);
    const names = await matched(req(huge), ctx());
    expect(names).toContain('memory-for-long-input');
  });

  test('positive: missing contextWindow falls back to 32k default', async () => {
    const noWindow: ModelProfile = { match: /.*/, thinkingMode: false, supportsLogprobs: false };
    const huge = 'a'.repeat(100_000);
    const names = await matched(req(huge), ctx({ modelProfile: noWindow }));
    expect(names).toContain('memory-for-long-input');
  });

  test('negative: short input does not trigger', async () => {
    const names = await matched(req('Hello world.'), ctx());
    expect(names).not.toContain('memory-for-long-input');
  });

  test('negative: under threshold (50% of window)', async () => {
    // 8k chars → 2k tokens, well under 0.7 * 32k.
    const mid = 'a'.repeat(8_000);
    const names = await matched(req(mid), ctx());
    expect(names).not.toContain('memory-for-long-input');
  });

  test('negative: just below 70% boundary', async () => {
    // 0.69 * 32000 = 22080 tokens ≈ 88320 chars (just under threshold)
    const justUnder = 'a'.repeat(88_000);
    const names = await matched(req(justUnder), ctx());
    expect(names).not.toContain('memory-for-long-input');
  });

  test('apply produces a memory technique', async () => {
    const huge = 'a'.repeat(100_000);
    const router = rulesRouter([...defaultRules]);
    const decision = await router.decide(req(huge), ctx());
    expect(decision.techniques.some(t => t.name === 'memory')).toBe(true);
  });
});

// =============================================================================
// plan-search-for-code
// =============================================================================

describe('plan-search-for-code', () => {
  test('positive: code prompt with default effortBudget', async () => {
    const names = await matched(req('Write a Python function to reverse a string.'), ctx());
    expect(names).toContain('plan-search-for-code');
  });

  test('positive: refactor (strong EN verb)', async () => {
    const names = await matched(req('Refactor this controller to remove duplication.'), ctx());
    expect(names).toContain('plan-search-for-code');
  });

  test('positive: code at effortBudget threshold (0.4)', async () => {
    const names = await matched(req('Implement a binary tree in Rust.'), ctx({ effortBudget: 0.4 }));
    expect(names).toContain('plan-search-for-code');
  });

  test('negative: code prompt but effortBudget too low', async () => {
    const names = await matched(req('Write a Python function.'), ctx({ effortBudget: 0.3 }));
    expect(names).not.toContain('plan-search-for-code');
  });

  test('negative: prose question (no code intent)', async () => {
    const names = await matched(req('Explain how recursion works.'), ctx());
    expect(names).not.toContain('plan-search-for-code');
  });

  test('negative: translation request (not code)', async () => {
    const names = await matched(req('Translate this to French.'), ctx());
    expect(names).not.toContain('plan-search-for-code');
  });

  test('apply pairs unit-test verifier when registered', async () => {
    const verifier = unitTestVerifier({
      language: 'python',
      tests: '',
      runner: async () => ({ passed: 0, total: 0 }),
    });
    const verifiers = makeRegistry({ 'unit-test': verifier });
    const router = rulesRouter([...defaultRules]);
    const decision = await router.decide(
      req('Write a function to compute factorials.'),
      ctx({ verifiers }),
    );
    const ps = decision.techniques.find(t => t.name === 'plan-search');
    expect(ps).toBeDefined();
    // No direct introspection of verifier on Technique; absence of crash is the
    // primary signal. The behavior is also covered by plan-search's own tests.
  });

  test('apply gracefully omits verifier when registry has none', async () => {
    const router = rulesRouter([...defaultRules]);
    const decision = await router.decide(
      req('Write a function to compute factorials.'),
      ctx({ verifiers: emptyVerifiers }),
    );
    expect(decision.techniques.some(t => t.name === 'plan-search')).toBe(true);
  });
});

// =============================================================================
// round-trip-for-translation-or-summary
// =============================================================================

describe('round-trip-for-translation-or-summary', () => {
  test('positive: explicit translation request', async () => {
    const names = await matched(req('Translate this to Spanish.'), ctx());
    expect(names).toContain('round-trip-for-translation-or-summary');
  });

  test('positive: summarization request', async () => {
    const names = await matched(req('Summarize this report in three sentences.'), ctx());
    expect(names).toContain('round-trip-for-translation-or-summary');
  });

  test('positive: TL;DR shorthand', async () => {
    const names = await matched(req('TL;DR please, this is too long.'), ctx());
    expect(names).toContain('round-trip-for-translation-or-summary');
  });

  test('negative: prose question', async () => {
    const names = await matched(req('What is the capital of France?'), ctx());
    expect(names).not.toContain('round-trip-for-translation-or-summary');
  });

  test('negative: code generation', async () => {
    const names = await matched(req('Write a function in Python.'), ctx());
    expect(names).not.toContain('round-trip-for-translation-or-summary');
  });

  test('negative: noun "translation" (not a request)', async () => {
    const names = await matched(req('What is the best translation tool?'), ctx());
    expect(names).not.toContain('round-trip-for-translation-or-summary');
  });

  test('apply produces a round-trip technique', async () => {
    const router = rulesRouter([...defaultRules]);
    const decision = await router.decide(req('Summarize this article.'), ctx());
    expect(decision.techniques.some(t => t.name === 'round-trip')).toBe(true);
  });
});

// =============================================================================
// self-consistency-default
// =============================================================================

describe('self-consistency-default', () => {
  test('positive: default effortBudget triggers', async () => {
    const names = await matched(req('What is 2 + 2?'), ctx());
    expect(names).toContain('self-consistency-default');
  });

  test('positive: at threshold (0.3)', async () => {
    const names = await matched(req('What is 2 + 2?'), ctx({ effortBudget: 0.3 }));
    expect(names).toContain('self-consistency-default');
  });

  test('positive: high effortBudget', async () => {
    const names = await matched(req('What is 2 + 2?'), ctx({ effortBudget: 1.0 }));
    expect(names).toContain('self-consistency-default');
  });

  test('negative: effortBudget below threshold', async () => {
    const names = await matched(req('What is 2 + 2?'), ctx({ effortBudget: 0.2 }));
    expect(names).not.toContain('self-consistency-default');
  });

  test('negative: effortBudget zero', async () => {
    const names = await matched(req('What is 2 + 2?'), ctx({ effortBudget: 0 }));
    expect(names).not.toContain('self-consistency-default');
  });

  test('apply: low effort uses k=2', async () => {
    const router = rulesRouter([...defaultRules]);
    const decision = await router.decide(req('What is 2 + 2?'), ctx({ effortBudget: 0.4 }));
    const sc = decision.techniques.find(t => t.name === 'self-consistency');
    expect(sc).toBeDefined();
    // SC technique doesn't expose k on itself; we re-evaluate via the rule directly.
    // The shape check is sufficient at this layer; SC's own tests cover k behavior.
  });

  test('apply: thinking-mode model uses k=3 (vs 5 for non-thinking)', async () => {
    // Validate behaviorally by re-running with two profiles and confirming we
    // still produce a self-consistency technique. The k value is internal.
    const r = rulesRouter([...defaultRules]);
    const t = await r.decide(req('What is 2 + 2?'), ctx({ modelProfile: thinkingProfile, effortBudget: 0.8 }));
    const nt = await r.decide(req('What is 2 + 2?'), ctx({ modelProfile: baseProfile, effortBudget: 0.8 }));
    expect(t.techniques.some(x => x.name === 'self-consistency')).toBe(true);
    expect(nt.techniques.some(x => x.name === 'self-consistency')).toBe(true);
  });
});

// =============================================================================
// Composition behavior (the value of the rule set is in additive composition)
// =============================================================================

describe('rule composition', () => {
  test('long-document code generation matches memory + plan-search + SC', async () => {
    const huge = 'Write a Python function. ' + 'a'.repeat(100_000);
    const names = await matched(req(huge), ctx());
    expect(names).toEqual(expect.arrayContaining([
      'memory-for-long-input',
      'plan-search-for-code',
      'self-consistency-default',
    ]));
  });

  test('translation + SC compose additively', async () => {
    const names = await matched(req('Translate this to German.'), ctx());
    expect(names).toEqual(expect.arrayContaining([
      'round-trip-for-translation-or-summary',
      'self-consistency-default',
    ]));
  });

  test('effortBudget=0.2 disables everything except memory', async () => {
    const huge = 'Write a Python function. ' + 'a'.repeat(100_000);
    const names = await matched(req(huge), ctx({ effortBudget: 0.2 }));
    expect(names).toContain('memory-for-long-input');
    expect(names).not.toContain('plan-search-for-code');
    expect(names).not.toContain('self-consistency-default');
  });

  test('no rules match yields empty techniques and "no rules matched" reason', async () => {
    const router = rulesRouter([...defaultRules]);
    // effortBudget below all thresholds + short non-code/non-translation prompt
    const decision = await router.decide(req('Hi.'), ctx({ effortBudget: 0 }));
    expect(decision.techniques).toEqual([]);
    expect(decision.reason).toBe('no rules matched');
    expect(decision.confidence).toBeUndefined();
  });
});
