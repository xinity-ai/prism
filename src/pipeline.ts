import { mergePluginSources, mergeTechniqueSources } from './router/merge.ts';
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
import type { Router } from './router/types.ts';

export type PipelineInput = {
  request: ChatRequest;
  /** Request-level explicit techniques (parsed `xinity.techniques`).
   *  Undefined means "not set on the request" → router/defaults apply.
   *  An empty array is an active "no techniques" signal. */
  techniques?: Technique[];
  /** Request-level explicit transforms (parsed `xinity.plugins`).
   *  Undefined means "not set on the request" → router/defaults apply.
   *  An empty array is an active "no plugins" signal. */
  transforms?: Transform[];
  /** Optional rules-based or semantic router. Consulted only when
   *  `request.xinity?.auto === 'plugins'`. v0.1 callers omit this. */
  router?: Router;
  /** Server-level defaults (from `createGateway({ defaults })`). Additive
   *  base merged with router output when explicit lists are absent. */
  serverDefaults?: { techniques?: Technique[]; transforms?: Transform[] };
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
 *  1. Resolve the active set: consult the router (if enabled) and merge with
 *     explicit/default sources per the v0.2 precedence model.
 *  2. Capability gate (logprobs requirement, subsumption by thinking mode).
 *  3. Pre-transforms in registration order.
 *  4. Technique chain (reduceRight: outermost wraps innermost; innermost calls upstream).
 *  5. Post-transforms in reverse order.
 *
 * Caller is responsible for the pass-through fast path (zero techniques and
 * zero transforms) — `pipelineRun` still works in that case, but the server
 * skips it to preserve byte-for-byte upstream output.
 */
export async function pipelineRun(input: PipelineInput): Promise<ChatResponse> {
  const { logger, modelProfile, signal, upstream } = input;
  const onProgress = input.onProgress ?? (() => {});

  // ---- v0.2 routing: consult router and merge sources -----------------------
  const routerEnabled = input.request.xinity?.auto === 'plugins' && input.router !== undefined;
  let routerPlugins: Transform[] = [];
  let routerTechniques: Technique[] = [];
  if (routerEnabled && input.router) {
    const decision = await input.router.decide(input.request, {
      modelProfile,
      logger,
      signal,
    });
    routerPlugins = decision.plugins;
    routerTechniques = decision.techniques;
  }

  const disabled = input.request.xinity?.disabled;
  const activeTransforms = mergePluginSources({
    opts: input.transforms,
    router: routerPlugins,
    serverDefaults: input.serverDefaults?.transforms,
    disabled,
  });
  const activeTechniques = mergeTechniqueSources({
    opts: input.techniques,
    router: routerTechniques,
    serverDefaults: input.serverDefaults?.techniques,
    disabled,
  });

  // Capability gate — fail fast at request time.
  const techniques: Technique[] = [];
  for (const t of activeTechniques) {
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
  for (const tr of activeTransforms) {
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
  for (let i = activeTransforms.length - 1; i >= 0; i--) {
    const tr = activeTransforms[i];
    if (!tr?.post) continue;
    response = await tr.post(response, state);
    if (signal.aborted) throw new GatewayError(499, 'client_closed_request', 'aborted in post-transform');
  }

  return response;
}
