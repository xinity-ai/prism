import { GatewayError } from './types.ts';
import type {
  ChatRequest,
  ChatResponse,
  Logger,
  ModelProfile,
  ProgressEvent,
  Technique,
  Transform,
  TransformState,
  UpstreamClient,
} from './types.ts';

export type PipelineInput = {
  request: ChatRequest;
  techniques: Technique[];
  transforms: Transform[];
  upstream: UpstreamClient;
  modelProfile: ModelProfile;
  logger: Logger;
  signal: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
};

/**
 * Run techniques and transforms for a single non-streaming request.
 *
 * Order:
 *  1. Capability gate (logprobs requirement, subsumption by thinking mode).
 *  2. Pre-transforms in registration order.
 *  3. Technique chain (reduceRight: outermost wraps innermost; innermost calls upstream).
 *  4. Post-transforms in reverse order.
 *
 * Caller is responsible for the pass-through fast path (zero techniques and
 * zero transforms) — `pipelineRun` still works in that case, but the server
 * skips it to preserve byte-for-byte upstream output.
 */
export async function pipelineRun(input: PipelineInput): Promise<ChatResponse> {
  const { logger, modelProfile, signal, upstream } = input;
  const onProgress = input.onProgress ?? (() => {});

  // Capability gate — fail fast at request time.
  const techniques: Technique[] = [];
  for (const t of input.techniques) {
    if (t.capabilities.requiresLogprobs && !modelProfile.supportsLogprobs) {
      throw new GatewayError(
        400,
        'technique_requires_logprobs',
        `technique '${t.name}' requires logprobs, but model '${input.request.model}' does not support them`,
      );
    }
    if (t.capabilities.subsumedByThinkingMode && modelProfile.thinkingMode) {
      logger.info({ event: 'technique.skipped.subsumed', name: t.name });
      onProgress({ event: 'xinity.technique.skipped', name: t.name, reason: 'subsumed-by-thinking-mode' });
      continue;
    }
    techniques.push(t);
  }

  const state: TransformState = {
    store: new Map(),
    logger,
    signal,
    upstream,
    modelProfile,
  };

  // Pre-transforms.
  let req = input.request;
  for (const tr of input.transforms) {
    if (!tr.pre) continue;
    req = await tr.pre(req, state);
    if (signal.aborted) throw new GatewayError(499, 'client_closed_request', 'aborted in pre-transform');
  }

  // Compose technique chain. Innermost = bare upstream call.
  const base = async (r: ChatRequest): Promise<ChatResponse> => upstream.complete(r, signal);
  const chain = techniques.reduceRight<(r: ChatRequest) => Promise<ChatResponse>>(
    (next, technique) => (r) => technique.apply({
      request: r,
      upstream,
      next,
      modelProfile,
      signal,
      logger: logger.child({ technique: technique.name }),
      progress: onProgress,
    }),
    base,
  );

  let response = await chain(req);

  // Post-transforms in reverse order.
  for (let i = input.transforms.length - 1; i >= 0; i--) {
    const tr = input.transforms[i];
    if (!tr?.post) continue;
    response = await tr.post(response, state);
    if (signal.aborted) throw new GatewayError(499, 'client_closed_request', 'aborted in post-transform');
  }

  return response;
}
