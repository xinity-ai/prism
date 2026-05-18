import { resolveConfig, type Registry } from './config.ts';
import { createJsonLogger } from './logging.ts';
import { resolveModelProfile } from './model-profile.ts';
import { pipelineRun } from './pipeline.ts';
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

    let resolved;
    try {
      resolved = resolveConfig({
        model: wireReq.model,
        body: wireReq.xinity,
        headers: headersToRecord(req.headers),
        defaults: config.defaults,
      }, registry);
    } catch (err) {
      return errorToResponse(err);
    }

    const internalReq = fromWireRequest({ ...wireReq, model: resolved.resolvedModel });
    const modelProfile = resolveModelProfile(resolved.resolvedModel, profiles, resolved.modelProfileName);
    const wantsStream = wireReq.stream === true;

    requestLogger.info({
      event: 'request.received',
      model: resolved.resolvedModel,
      techniques: resolved.techniques.map(t => t.name),
      plugins: resolved.transforms.map(t => t.name),
      stream: wantsStream,
    });

    // ---- Pass-through fast path: zero techniques + zero plugins -------------
    if (resolved.techniques.length === 0 && resolved.transforms.length === 0) {
      try {
        const raw = await upstream.raw(internalReq, controller.signal);
        return new Response(raw.body, { status: raw.status, headers: forwardHeaders(raw.headers) });
      } catch (err) {
        return errorToResponse(err);
      }
    }

    // ---- Active pipeline ---------------------------------------------------
    if (wantsStream) {
      return runStreaming({
        techniques: resolved.techniques,
        transforms: resolved.transforms,
        request: internalReq,
        upstream,
        modelProfile,
        logger: requestLogger,
        signal: controller.signal,
      });
    }

    try {
      const response = await pipelineRun({
        request: internalReq,
        techniques: resolved.techniques,
        transforms: resolved.transforms,
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

type StreamingArgs = {
  techniques: Technique[];
  transforms: Transform[];
  request: ReturnType<typeof fromWireRequest>;
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
          techniques: args.techniques,
          transforms: args.transforms,
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
