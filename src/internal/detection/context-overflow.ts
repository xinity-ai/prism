import type { ChatRequest } from '../../types.ts';
import type { RequestFeatures, TaskSignal } from './types.ts';

export type DetectContextOverflowOptions = {
  /** Model context window in tokens. When undefined the detector cannot fire. */
  contextWindow?: number;
  /** Fraction of the context window above which the detector fires. Default 0.7. */
  ratio?: number;
};

/**
 * Detect requests whose approximate token count exceeds
 * `ratio × contextWindow`. This is the structural trigger for the `memory`
 * technique — it lives in the rules detection layer because the question
 * "does this fit?" is a pure fact about the request, not a judgment about
 * reasoning difficulty.
 *
 * Returns `match: false` when no `contextWindow` is supplied: we cannot
 * decide overflow without knowing the budget.
 */
export function detectContextOverflow(
  _request: ChatRequest,
  features: RequestFeatures,
  options: DetectContextOverflowOptions = {},
): TaskSignal {
  const ratio = options.ratio ?? 0.7;
  const contextWindow = options.contextWindow;
  if (contextWindow === undefined) {
    return {
      name: 'context-overflow',
      match: false,
      reason: 'no contextWindow on model profile',
    };
  }
  const threshold = contextWindow * ratio;
  if (features.tokenEstimate < threshold) {
    return {
      name: 'context-overflow',
      match: false,
      reason: `${features.tokenEstimate} tokens < ${Math.round(threshold)} (${Math.round(ratio * 100)}% of ${contextWindow})`,
      details: { tokenEstimate: features.tokenEstimate, threshold, contextWindow, ratio },
    };
  }
  return {
    name: 'context-overflow',
    match: true,
    reason: `${features.tokenEstimate} tokens ≥ ${Math.round(threshold)} (${Math.round(ratio * 100)}% of ${contextWindow})`,
    details: { tokenEstimate: features.tokenEstimate, threshold, contextWindow, ratio },
  };
}
