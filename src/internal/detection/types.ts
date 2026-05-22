/**
 * Output of a single detector. Detectors always return a signal — even when
 * `match` is false — so downstream routers (the rules layer in v0.2, the
 * semantic classifier in v0.3) can reuse the work as features without
 * re-running detection.
 */
export type TaskSignal = {
  /** Detector identifier. Stable across versions. */
  name: 'pii' | 'urls' | 'context-overflow';
  /** Did the detector fire? */
  match: boolean;
  /** Short human-readable explanation, suitable for structured logs.
   *  Populated whether or not `match` is true. */
  reason: string;
  /** Optional structured details — detector-specific shape. */
  details?: Record<string, unknown>;
};

/**
 * Pre-computed features of a {@link ChatRequest}. Computed once per request
 * by {@link extractFeatures} and passed to every detector so each detector
 * does not have to re-walk the message list.
 */
export type RequestFeatures = {
  /** All text content across all messages, joined with newlines.
   *  Image parts, tool-call payloads, and null-content messages are skipped. */
  text: string;
  /** Number of messages in the request. */
  messageCount: number;
  /** Approximate token count of `text` (length / 4 heuristic). */
  tokenEstimate: number;
};
