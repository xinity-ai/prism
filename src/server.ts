import { resolveConfigStaged, type Registry, type StagedConfig } from './config.ts';
import { createJsonLogger } from './logging.ts';
import { resolveModelProfile } from './model-profile.ts';
import { pipelineRun } from './pipeline.ts';
import { rulesRouter } from './router/rules.ts';
import type { Router } from './router/types.ts';
import { encodeProgressEvent, responseToSingleChunk } from './streaming.ts';
import { createHttpUpstreamClient, type HttpUpstreamConfig } from './upstream.ts';
import {
  ChatCompletionRequestSchema,
  fromWireRequest,
  GatewayError,
  toWireChunk,
  toWireResponse,
} from './types.ts';
import type {
  ChatResponse,
  Logger,
  ModelProfile,
  ProgressEvent,
  Technique,
  Transform,
  UpstreamClient,
  XinityConfig,
} from './types.ts';

export type GatewayConfig = {
  upstream: HttpUpstreamConfig | UpstreamClient;
  defaults?: XinityConfig;
  modelProfiles?: ModelProfile[];
  registry?: Partial<Registry>;
  logger?: Logger;
  /**
   * Optional auto-routing strategy. `'rules'` activates the in-tree
   * {@link rulesRouter} with default settings. `'none'` (or omitted) means no
   * router — v0.1 behavior. A custom {@link Router} can be passed for the
   * future `@xinity/prism-router-semantic` integration.
   *
   * The router is consulted per-request, only when `xinity.auto === 'plugins'`
   * (or `X-Xinity-Auto: plugins` header) is set.
   */
  router?: Router | 'rules' | 'none';
};

export type Gateway = {
  fetch: (req: Request) => Promise<Response>;
  serve: (opts: { port?: number; hostname?: string }) => Promise<{ url: string; stop: () => Promise<void> }>;
};

export function createGateway(config: GatewayConfig): Gateway {
  const upstream: UpstreamClient = isUpstreamClient(config.upstream)
    ? config.upstream
    : createHttpUpstreamClient(config.upstream);
  const logger = config.logger ?? createJsonLogger({ component: 'gateway' });
  const profiles = config.modelProfiles ?? [];
  const registry: Registry = {
    techniques: new Map(config.registry?.techniques),
    transforms: new Map(config.registry?.transforms),
  };
  const router = normalizeRouter(config.router);

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      return json({ status: 'ok' });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return openaiError(404, 'not_found', `no route for ${req.method} ${url.pathname}`);
    }

    const requestId = crypto.randomUUID();
    const requestLogger = logger.child({ requestId });
    const controller = new AbortController();
    // Forward client disconnect to upstream.
    req.signal.addEventListener('abort', () => controller.abort(), { once: true });

    let bodyJson: unknown;
    try {
      bodyJson = await req.json();
    } catch (err) {
      return openaiError(400, 'invalid_json', `request body is not valid JSON: ${(err as Error).message}`);
    }

    const parsed = ChatCompletionRequestSchema.safeParse(bodyJson);
    if (!parsed.success) {
      return openaiError(400, 'invalid_request', parsed.error.message);
    }
    const wireReq = parsed.data;

    let staged: StagedConfig;
    try {
      staged = resolveConfigStaged({
        model: wireReq.model,
        body: wireReq.xinity,
        headers: headersToRecord(req.headers),
        defaults: config.defaults,
      }, registry);
    } catch (err) {
      return errorToResponse(err);
    }

    const internalReq = fromWireRequest({ ...wireReq, model: staged.resolvedModel });
    const modelProfile = resolveModelProfile(staged.resolvedModel, profiles, staged.modelProfileName);
    const wantsStream = wireReq.stream === true;

    const routerWillRun = router !== undefined && staged.auto === 'plugins';
    const v01Effective = effectiveV01Final(staged);

    requestLogger.info({
      event: 'request.received',
      model: staged.resolvedModel,
      techniques: v01Effective.techniques.map(t => t.name),
      plugins: v01Effective.transforms.map(t => t.name),
      stream: wantsStream,
      ...(staged.auto !== undefined && { auto: staged.auto }),
      ...(routerWillRun && { routerEnabled: true }),
    });

    // ---- Pass-through fast path: zero techniques + zero plugins + no router -
    if (
      !routerWillRun &&
      v01Effective.techniques.length === 0 &&
      v01Effective.transforms.length === 0
    ) {
      try {
        const raw = await upstream.raw(internalReq, controller.signal);
        return new Response(raw.body, { status: raw.status, headers: forwardHeaders(raw.headers) });
      } catch (err) {
        return errorToResponse(err);
      }
    }

    // ---- Active pipeline ---------------------------------------------------
    const activeRouter = routerWillRun ? router : undefined;
    const serverDefaults = {
      transforms: staged.defaultTransforms,
      techniques: staged.defaultTechniques,
    };

    if (wantsStream) {
      return runStreaming({
        request: internalReq,
        ...(staged.explicitTechniques !== undefined && { techniques: staged.explicitTechniques }),
        ...(staged.explicitTransforms !== undefined && { transforms: staged.explicitTransforms }),
        ...(activeRouter !== undefined && { router: activeRouter }),
        serverDefaults,
        upstream,
        modelProfile,
        logger: requestLogger,
        signal: controller.signal,
      });
    }

    try {
      const response = await pipelineRun({
        request: internalReq,
        ...(staged.explicitTechniques !== undefined && { techniques: staged.explicitTechniques }),
        ...(staged.explicitTransforms !== undefined && { transforms: staged.explicitTransforms }),
        ...(activeRouter !== undefined && { router: activeRouter }),
        serverDefaults,
        upstream,
        modelProfile,
        logger: requestLogger,
        signal: controller.signal,
      });
      return json(toWireResponse(response));
    } catch (err) {
      return errorToResponse(err);
    }
  }

  return {
    fetch: handle,
    async serve({ port = 4000, hostname = '0.0.0.0' }) {
      const server = Bun.serve({ port, hostname, fetch: handle });
      logger.info({ event: 'server.listening', url: `http://${hostname}:${server.port}` });
      return {
        url: `http://${hostname}:${server.port}`,
        async stop() { await server.stop(); },
      };
    },
  };
}

function normalizeRouter(spec: Router | 'rules' | 'none' | undefined): Router | undefined {
  if (spec === undefined || spec === 'none') return undefined;
  if (spec === 'rules') return rulesRouter();
  return spec;
}

/**
 * Compute the effective v0.1-style final list from a staged config.
 *
 * Mirrors `resolveConfig` semantics: request-level explicit (if set) replaces
 * server defaults wholesale, then the merged disabled list is subtracted. Used
 * for the pass-through fast-path check and the `request.received` log event.
 */
function effectiveV01Final(staged: StagedConfig): { techniques: Technique[]; transforms: Transform[] } {
  const disabled = new Set(staged.disabled);
  const transforms = (staged.explicitTransforms ?? staged.defaultTransforms)
    .filter(t => !disabled.has(t.name));
  const techniques = (staged.explicitTechniques ?? staged.defaultTechniques)
    .filter(t => !disabled.has(t.name));
  return { transforms, techniques };
}

type StreamingArgs = {
  request: ReturnType<typeof fromWireRequest>;
  techniques?: Technique[];
  transforms?: Transform[];
  router?: Router;
  serverDefaults: { techniques: Technique[]; transforms: Transform[] };
  upstream: UpstreamClient;
  modelProfile: ModelProfile;
  logger: Logger;
  signal: AbortSignal;
};

/**
 * Streaming response for an active pipeline.
 *
 * v1 implements the "quiet degrade" path from DESIGN §16.3 only: run the
 * pipeline non-streaming, emit `xinity.*` SSE progress events as work happens,
 * then emit the final response as a single delta chunk and `[DONE]`.
 *
 * Techniques that genuinely support streaming (RTO single-pass, Memory final
 * synthesis, DeepConf online) wire up their own streaming path inside the
 * technique implementation; that is added in Phase 3 when those techniques land.
 */
function runStreaming(args: StreamingArgs): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onProgress = (event: ProgressEvent) => {
        try { controller.enqueue(encodeProgressEvent(event)); } catch { /* closed */ }
      };
      try {
        const response = await pipelineRun({
          request: args.request,
          ...(args.techniques !== undefined && { techniques: args.techniques }),
          ...(args.transforms !== undefined && { transforms: args.transforms }),
          ...(args.router !== undefined && { router: args.router }),
          serverDefaults: args.serverDefaults,
          upstream: args.upstream,
          modelProfile: args.modelProfile,
          logger: args.logger,
          signal: args.signal,
          onProgress,
        });
        const wireChunk = toWireChunk(responseToSingleChunk(response));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(wireChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        const payload = err instanceof GatewayError
          ? { error: { message: err.message, code: err.code, type: 'gateway_error' } }
          : { error: { message: (err as Error).message ?? 'internal error', type: 'internal' } };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

function isUpstreamClient(x: HttpUpstreamConfig | UpstreamClient): x is UpstreamClient {
  return typeof (x as UpstreamClient).complete === 'function';
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function openaiError(status: number, code: string, message: string): Response {
  return json({ error: { message, type: 'invalid_request_error', code } }, status);
}

function errorToResponse(err: unknown): Response {
  if (err instanceof GatewayError) {
    return openaiError(err.statusCode, err.code, err.message);
  }
  if (err instanceof Error) {
    return openaiError(500, 'internal_error', err.message);
  }
  return openaiError(500, 'internal_error', String(err));
}
