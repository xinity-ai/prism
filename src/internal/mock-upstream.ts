import type { ChatChunk, ChatRequest, ChatResponse, UpstreamClient } from '../types.ts';

export type CompleteHandler = (req: ChatRequest, call: number) => ChatResponse | Promise<ChatResponse>;
export type StreamHandler = (req: ChatRequest, call: number) => AsyncIterable<ChatChunk>;
export type RawHandler = (req: ChatRequest, call: number) => Response | Promise<Response>;

export type MockUpstream = UpstreamClient & {
  readonly completeCalls: ChatRequest[];
  readonly streamCalls: ChatRequest[];
  readonly rawCalls: ChatRequest[];
};

export function createMockUpstream(handlers: {
  complete?: CompleteHandler;
  stream?: StreamHandler;
  raw?: RawHandler;
}): MockUpstream {
  const completeCalls: ChatRequest[] = [];
  const streamCalls: ChatRequest[] = [];
  const rawCalls: ChatRequest[] = [];
  return {
    completeCalls, streamCalls, rawCalls,
    async complete(req, _signal) {
      if (!handlers.complete) throw new Error('mock: no complete handler');
      const callIndex = completeCalls.length;
      completeCalls.push(req);
      return handlers.complete(req, callIndex);
    },
    stream(req, _signal) {
      if (!handlers.stream) throw new Error('mock: no stream handler');
      const callIndex = streamCalls.length;
      streamCalls.push(req);
      return handlers.stream(req, callIndex);
    },
    async raw(req, _signal) {
      if (!handlers.raw) throw new Error('mock: no raw handler');
      const callIndex = rawCalls.length;
      rawCalls.push(req);
      return handlers.raw(req, callIndex);
    },
  };
}

export function fakeResponse(content: string, opts: { id?: string; logprobs?: boolean } = {}): ChatResponse {
  return {
    id: opts.id ?? 'mock-' + Math.random().toString(36).slice(2),
    object: 'chat.completion',
    model: 'mock',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finishReason: 'stop',
      logprobs: opts.logprobs
        ? { content: content.split('').slice(0, 8).map(t => ({ token: t, logprob: -0.1, bytes: null })) }
        : null,
    }],
    xinityMeta: { hadLogprobs: !!opts.logprobs },
  };
}

export function fakeChunkStream(parts: string[]): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      let i = 0;
      for (const part of parts) {
        yield {
          id: 'mock-stream',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: i === 0 ? { role: 'assistant', content: part } : { content: part },
            finishReason: null,
          }],
        };
        i += 1;
      }
      yield {
        id: 'mock-stream',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finishReason: 'stop' }],
      };
    },
  };
}
