/**
 * Routing for technique selection.
 *
 * This module exports:
 *   - The `Router` interface — the contract both `rulesRouter` (v0.2, this file)
 *     and the future `@xinity/prism-router-semantic` (v0.3, separate package)
 *     implement. Frozen by design — see DESIGN §17.3.
 *   - `Rule` — a function-shaped rule (name + sync predicate + decision-producer).
 *   - `rule()` — identity helper for IDE type narrowing.
 *   - `rulesRouter()` — factory that turns a Rule[] into a Router.
 *   - `composeRouters()` — combinator that runs N routers and merges decisions.
 *   - `defaultRules` — the four-rule baseline shipped in core.
 *   - `assertRouterConformance()` — contract test reusable by future Router
 *     implementations.
 */

import { estimateTokens, looksLikeCodeGeneration, looksLikeSummary, looksLikeTranslation } from './internal/detection.ts';
import { memory } from './techniques/memory.ts';
import { planSearch } from './techniques/plan-search.ts';
import { roundTrip } from './techniques/round-trip.ts';
import { selfConsistency } from './techniques/self-consistency.ts';
import { GatewayError } from './types.ts';
import type {
  ChatRequest,
  Logger,
  ModelProfile,
  Technique,
  VerifierRegistry,
} from './types.ts';

// =============================================================================
// Public types — Router contract
// =============================================================================

export interface Router {
  readonly name: string;

  /**
   * Decide which techniques to apply.
   *
   * MUST honor `signal` for cancellation.
   * MUST be safe to call in parallel.
   * MUST NOT mutate `request` or `context`.
   * MAY return an empty technique array.
   */
  decide(request: ChatRequest, context: RouterContext): Promise<RouterDecision>;

  /** Optional warmup hook. Called once at gateway startup. */
  init?(): Promise<void>;

  /** Optional teardown hook. Called on graceful gateway shutdown. */
  close?(): Promise<void>;
}

export interface RouterContext {
  readonly modelProfile: ModelProfile;
  /**
   * Optional cost/quality knob in [0, 1]. 0 = cheapest, 1 = strongest.
   * Defaults to 0.5 when rules read it via `RuleInput.effortBudget` defaulting.
   */
  readonly effortBudget?: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /**
   * Verifier registry exposed to rules via RuleInput. The router itself does
   * not consult verifiers; it only forwards the registry to rule predicates.
   * `undefined` means "no verifiers registered" — equivalent to an empty registry.
   */
  readonly verifiers?: VerifierRegistry;
}

export interface RouterDecision {
  readonly techniques: Technique[];
  readonly reason: string;
  readonly confidence?: number;
}

// =============================================================================
// Rule type
// =============================================================================

export interface Rule {
  readonly name: string;
  /** Pure predicate. MUST be deterministic and side-effect-free. */
  when(input: RuleInput): boolean;
  /** Partial decision produced when `when` returns true. */
  apply(input: RuleInput): PartialDecision;
}

export interface RuleInput {
  readonly request: ChatRequest;
  readonly modelProfile: ModelProfile;
  readonly effortBudget?: number;
  /**
   * Verifier registry. Rules MUST handle `get()` returning undefined and let
   * the technique they construct use its default behavior.
   */
  readonly verifiers: VerifierRegistry;
}

export interface PartialDecision {
  readonly techniques: Technique[];
}

/** Identity helper. Exists only for IDE type narrowing when defining rules. */
export function rule(spec: Rule): Rule {
  return spec;
}

/**
 * Convenience constructor for a VerifierRegistry from a plain Record.
 * For inline use in test setup and small deployments. Production gateways
 * typically build a richer registry.
 */
export function verifierRegistry(entries: Record<string, import('./types.ts').Verifier>): VerifierRegistry {
  return {
    get: (name) => entries[name],
    has: (name) => name in entries,
    names: () => Object.keys(entries),
  };
}

// =============================================================================
// Empty registry — used when a router context omits `verifiers`
// =============================================================================

const EMPTY_VERIFIERS: VerifierRegistry = {
  get: () => undefined,
  has: () => false,
  names: () => [],
};

// =============================================================================
// rulesRouter
// =============================================================================

export function rulesRouter(rules: Rule[]): Router {
  // Freeze the rule list at factory time. Callers that mutate their original
  // array after construction don't surprise themselves.
  const frozen: readonly Rule[] = Object.freeze(rules.slice());

  return {
    name: 'rules',
    async decide(request, context) {
      if (context.signal.aborted) {
        throw new GatewayError(499, 'client_closed_request', 'router aborted');
      }
      const input: RuleInput = {
        request,
        modelProfile: context.modelProfile,
        ...(context.effortBudget !== undefined && { effortBudget: context.effortBudget }),
        verifiers: context.verifiers ?? EMPTY_VERIFIERS,
      };

      const matched: string[] = [];
      const techniques: Technique[] = [];
      for (const r of frozen) {
        if (context.signal.aborted) {
          throw new GatewayError(499, 'client_closed_request', 'router aborted');
        }
        if (r.when(input)) {
          matched.push(r.name);
          techniques.push(...r.apply(input).techniques);
        }
      }
      return {
        techniques,
        reason: matched.length === 0
          ? 'no rules matched'
          : `matched rules: ${matched.join(', ')}`,
        // confidence intentionally omitted — rules are deterministic
      };
    },
  };
}

// =============================================================================
// composeRouters
// =============================================================================

/**
 * Run N routers in parallel and merge their decisions.
 *
 * - Techniques are concatenated in the order of `routers`. Outer-most first
 *   per the pipeline composition contract.
 * - Reasons are joined with `; ` and prefixed by each router's name.
 * - Confidence is the minimum of any child router's confidence; undefined if
 *   no child reports confidence.
 * - `init` and `close` propagate to all children sequentially.
 */
export function composeRouters(routers: Router[]): Router {
  const children = routers.slice();
  const name = `composed(${children.map(r => r.name).join('+') || 'empty'})`;

  const hasInit = children.some(r => typeof r.init === 'function');
  const hasClose = children.some(r => typeof r.close === 'function');

  const composed: Router = {
    name,
    async decide(request, context) {
      if (context.signal.aborted) {
        throw new GatewayError(499, 'client_closed_request', 'router aborted');
      }
      const decisions = await Promise.all(
        children.map(r => r.decide(request, context)),
      );

      const techniques: Technique[] = decisions.flatMap(d => d.techniques);
      const reason = decisions.length === 0
        ? 'no routers configured'
        : decisions.map((d, i) => `[${children[i]!.name}] ${d.reason}`).join('; ');

      let confidence: number | undefined;
      for (const d of decisions) {
        if (typeof d.confidence === 'number') {
          confidence = confidence === undefined ? d.confidence : Math.min(confidence, d.confidence);
        }
      }
      return confidence === undefined ? { techniques, reason } : { techniques, reason, confidence };
    },
  };

  if (hasInit) {
    composed.init = async () => {
      for (const r of children) {
        if (r.init) await r.init();
      }
    };
  }
  if (hasClose) {
    composed.close = async () => {
      for (const r of children) {
        if (r.close) await r.close();
      }
    };
  }

  return composed;
}

// =============================================================================
// Default rule set
// =============================================================================

const DEFAULT_CONTEXT_WINDOW = 32_000;
const LONG_INPUT_THRESHOLD = 0.7;
const PLAN_SEARCH_EFFORT_FLOOR = 0.4;
const SC_EFFORT_FLOOR = 0.3;
const SC_LOW_EFFORT_CUTOFF = 0.5;

export const defaultRules: readonly Rule[] = Object.freeze([
  // (1) Memory: input exceeds 70% of the model's effective context window.
  // The technique itself no-ops when the document fits, so this rule is safe to
  // fire whenever the threshold is crossed.
  rule({
    name: 'memory-for-long-input',
    when: ({ request, modelProfile }) =>
      estimateTokens(request) > LONG_INPUT_THRESHOLD * (modelProfile.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    apply: () => ({ techniques: [memory({})] }),
  }),

  // (2) PlanSearch for code-generation prompts. Gated by effortBudget because
  // PlanSearch is expensive (5-7× tokens). Pairs with the unit-test verifier if
  // registered; otherwise PlanSearch falls back to voting.
  rule({
    name: 'plan-search-for-code',
    when: ({ request, effortBudget = SC_LOW_EFFORT_CUTOFF }) =>
      looksLikeCodeGeneration(request) && effortBudget >= PLAN_SEARCH_EFFORT_FLOOR,
    apply: ({ verifiers }) => {
      const v = verifiers.get('unit-test');
      return {
        techniques: [planSearch({ numPlans: 5, ...(v && { verifier: v }) })],
      };
    },
  }),

  // (3) RoundTrip for translation and summarization. Always fires when detected.
  rule({
    name: 'round-trip-for-translation-or-summary',
    when: ({ request }) => looksLikeTranslation(request) || looksLikeSummary(request),
    apply: () => ({ techniques: [roundTrip({})] }),
  }),

  // (4) Self-Consistency universal fallback. Composes additively with anything
  // above. k adapts to model (thinking-mode uses fewer samples) and budget.
  rule({
    name: 'self-consistency-default',
    when: ({ effortBudget = SC_LOW_EFFORT_CUTOFF }) => effortBudget >= SC_EFFORT_FLOOR,
    apply: ({ modelProfile, effortBudget = SC_LOW_EFFORT_CUTOFF }) => ({
      techniques: [selfConsistency({
        k: effortBudget < SC_LOW_EFFORT_CUTOFF ? 2 : modelProfile.thinkingMode ? 3 : 5,
      })],
    }),
  }),
]) as readonly Rule[];

// =============================================================================
// Conformance contract
// =============================================================================

/**
 * Reusable contract check for any Router implementation. The v0.3 semantic
 * router package will import and run this against its own implementation.
 *
 * Asserts:
 *   - decide() returns a well-formed RouterDecision
 *   - decide() does not mutate the request or context
 *   - decide() honors AbortSignal (pre-aborted signal causes rejection)
 *   - init()/close() are awaitable and idempotent under double-call
 *
 * Pass a `makeContext()` factory rather than a single context, because some
 * checks need a fresh, non-aborted signal.
 */
export async function assertRouterConformance(
  router: Router,
  makeContext: () => RouterContext,
  sampleRequest: ChatRequest,
): Promise<void> {
  const assert = (cond: unknown, msg: string): void => {
    if (!cond) throw new Error(`Router conformance failed: ${msg}`);
  };

  if (router.init) {
    await router.init();
    // Idempotent under double-call — implementations may warn but must not throw.
    await router.init();
  }

  // 1. Basic shape
  const ctx1 = makeContext();
  const reqSnapshot = JSON.stringify(sampleRequest);
  const ctxSnapshot = JSON.stringify({
    modelProfile: ctx1.modelProfile,
    effortBudget: ctx1.effortBudget,
  });
  const decision = await router.decide(sampleRequest, ctx1);
  assert(typeof router.name === 'string' && router.name.length > 0, 'router.name missing');
  assert(Array.isArray(decision.techniques), 'decision.techniques must be an array');
  assert(typeof decision.reason === 'string', 'decision.reason must be a string');
  if (decision.confidence !== undefined) {
    assert(
      typeof decision.confidence === 'number' && decision.confidence >= 0 && decision.confidence <= 1,
      'decision.confidence must be in [0, 1] when present',
    );
  }

  // 2. No mutation of inputs
  assert(JSON.stringify(sampleRequest) === reqSnapshot, 'request was mutated by decide()');
  assert(
    JSON.stringify({ modelProfile: ctx1.modelProfile, effortBudget: ctx1.effortBudget }) === ctxSnapshot,
    'context was mutated by decide()',
  );

  // 3. AbortSignal honored. A router that ignores the signal is non-conformant.
  const abortCtl = new AbortController();
  abortCtl.abort();
  const abortedCtx: RouterContext = { ...makeContext(), signal: abortCtl.signal };
  let aborted = false;
  try {
    await router.decide(sampleRequest, abortedCtx);
  } catch {
    aborted = true;
  }
  assert(aborted, 'decide() must reject when signal is already aborted');

  if (router.close) {
    await router.close();
  }
}
