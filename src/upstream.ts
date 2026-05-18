import { createParser, type EventSourceMessage } from 'eventsource-parser';
import {
  ChatCompletionChunkSchema,
  ChatCompletionResponseSchema,
  fromWireChunk,
  fromWireResponse,
  GatewayError,
  toWireRequest,
} from './types.ts';
import type { ChatChunk, ChatRequest, ChatResponse, UpstreamClient } from './types.ts';

export type HttpUpstreamConfig = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Maximum retries on transient errors (5xx, network). 0 disables retry. */
  retries?: number;
  /** Extra headers forwarded on every upstream call. */
  extraHeaders?: Record<string, string>;
  /** Inject a custom fetch implementation. Tests use this. */
  fetchImpl?: FetchLike;
};

/** The subset of `fetch` the upstream client actually invokes. */
export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function createHttpUpstreamClient(config: HttpUpstreamConfig): UpstreamClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 120_000;
  const retries = config.retries ?? 1;
  const fetchImpl = config.fetchImpl ?? fetch;

  function buildRequest(req: ChatRequest, stream: boolean): Request {
    const wire = toWireRequest(req);
    const body = JSON.stringify({ ...wire, stream });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.extraHeaders,
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    return new Request(`${baseUrl}/chat/completions`, { method: 'POST', headers, body });
  }

  async function callOnce(req: ChatRequest, stream: boolean, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetchImpl(buildRequest(req, stream), { signal: combined });
    } catch (cause) {
      if (signal.aborted) throw new GatewayError(499, 'client_closed_request', 'request aborted', cause);
      throw new GatewayError(502, 'upstream_unreachable', `upstream fetch failed: ${(cause as Error).message ?? cause}`, cause);
    }
    if (!response.ok && TRANSIENT_STATUSES.has(response.status)) {
      // Drain body to free the connection before throwing.
      await response.text().catch(() => undefined);
      throw new GatewayError(response.status, 'upstream_transient', `upstream returned ${response.status}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GatewayError(response.status, 'upstream_error', text || `upstream returned ${response.status}`);
    }
    return response;
  }

  async function callWithRetry(req: ChatRequest, stream: boolean, signal: AbortSignal): Promise<Response> {
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= retries) {
      try {
        return await callOnce(req, stream, signal);
      } catch (err) {
        lastError = err;
        if (signal.aborted) throw err;
        if (err instanceof GatewayError && err.code === 'upstream_transient' && attempt < retries) {
          attempt += 1;
          const backoff = 100 * 2 ** (attempt - 1);
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, backoff);
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new GatewayError(499, 'client_closed_request', 'aborted during backoff'));
            }, { once: true });
          });
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  return {
    async complete(req, signal) {
      const response = await callWithRetry(req, false, signal);
      const json = await response.json();
      const wire = ChatCompletionResponseSchema.parse(json);
      return fromWireResponse(wire);
    },
    stream(req, signal): AsyncIterable<ChatChunk> {
      return streamChunks(() => callWithRetry(req, true, signal), signal);
    },
    async raw(req, signal) {
      // Forward client's stream flag verbatim. No retry — pass-through is best-effort,
      // and the body must be consumed exactly once by the caller.
      const wire = toWireRequest(req);
      const body = JSON.stringify({ ...wire, ...(req.stream !== undefined && { stream: req.stream }) });
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...config.extraHeaders,
      };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      try {
        return await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST', headers, body, signal,
        });
      } catch (cause) {
        if (signal.aborted) throw new GatewayError(499, 'client_closed_request', 'request aborted', cause);
        throw new GatewayError(502, 'upstream_unreachable', `upstream fetch failed: ${(cause as Error).message ?? cause}`, cause);
      }
    },
  };
}

async function* streamChunks(
  open: () => Promise<Response>,
  signal: AbortSignal,
): AsyncIterable<ChatChunk> {
  const response = await open();
  if (!response.body) throw new GatewayError(502, 'upstream_no_body', 'upstream stream has no body');
  const queue: (ChatChunk | { done: true } | { error: unknown })[] = [];
  let resolve: (() => void) | null = null;
  const wake = () => {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  };

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!event.data) return;
      if (event.data === '[DONE]') {
        queue.push({ done: true });
        wake();
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        const wire = ChatCompletionChunkSchema.parse(parsed);
        queue.push(fromWireChunk(wire));
        wake();
      } catch (err) {
        queue.push({ error: err });
        wake();
      }
    },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
    queue.push({ error: new GatewayError(499, 'client_closed_request', 'stream aborted') });
    wake();
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          queue.push({ done: true });
          wake();
          return;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (!signal.aborted) {
        queue.push({ error: err });
        wake();
      }
    }
  })();

  try {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>(r => { resolve = r; });
      }
      const next = queue.shift()!;
      if ('done' in next) return;
      if ('error' in next) throw next.error;
      yield next;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => undefined);
  }
}
