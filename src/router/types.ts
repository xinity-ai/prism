import type { ChatRequest, ModelProfile, Transform, Technique, Logger } from '../types';
import type { TaskSignal, RequestFeatures } from '../internal/detection/types';

/**
 * Per-request context passed to a {@link Router} when deciding which plugins
 * and techniques to activate. Routers never receive shared/mutable state —
 * they are stateless and a fresh context is constructed for every request.
 */
export type RouterContext = {
  modelProfile: ModelProfile;
  logger: Logger;
  signal: AbortSignal;
};

/**
 * The result of a {@link Router#decide} call.
 *
 * The pipeline merges this with explicit user configuration and server-level
 * defaults; the router never activates anything itself. See `merge.ts` and
 * the precedence model in the v0.2 design notes.
 */
export type RouterDecision = {
  /** Plugin instances to add to the request pipeline. */
  plugins: Transform[];
  /**
   * Technique instances to add. In v0.2 the rules router only ever emits
   * `memory` here; a future semantic router (v0.3) may emit others.
   */
  techniques: Technique[];
  /**
   * Signals consulted to produce this decision — both firing and non-firing.
   * Populated even when no consumer reads them, so a downstream semantic
   * router can reuse the rules layer's work as classifier features without
   * re-running detection.
   */
  signals: TaskSignal[];
  /** Per-target rationale, for the single structured `router.decide` log event. */
  rationale: RouterRationale[];
};

/** One row of the rationale array. One entry per activated plugin/technique. */
export type RouterRationale = {
  /** Plugin or technique name (e.g. `'privacy'`, `'readUrls'`, `'memory'`). */
  target: string;
  /** Identifier for the rule that fired (e.g. `'pii-detected'`). */
  rule: string;
  /** Short human-readable reason, suitable for structured logs. */
  reason: string;
};

/**
 * A router inspects a {@link ChatRequest} and proposes plugins/techniques to
 * activate for it. Routers are pure functions of the request and context;
 * they hold no cross-request state and never mutate their inputs.
 *
 * The pipeline calls `decide()` at most once per request, only when routing
 * is explicitly enabled (server-level `router:` option, `X-Xinity-Auto`
 * header, or `xinity.auto` body field). When disabled, no router is
 * constructed and there is zero overhead on the hot path.
 *
 * Implementations may be rule-based (the in-tree `rulesRouter`) or learned
 * (the future `@xinity/prism-router-semantic` package); this interface is
 * deliberately neutral about the strategy used.
 */
export type Router = {
  readonly name: string;
  decide(request: ChatRequest, ctx: RouterContext): Promise<RouterDecision>;
};

// Re-export the detection-layer types referenced by RouterDecision so
// consumers of the router API have a single import surface.
export type { TaskSignal, RequestFeatures };
