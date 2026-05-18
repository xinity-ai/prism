import { toWireChunk } from './types.ts';
import type { ChatChunk, ChatResponse, ProgressEvent } from './types.ts';

/** Wrap an async iterable of chunks into an SSE ReadableStream. */
export function chunksToSse(
  chunks: AsyncIterable<ChatChunk>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          if (signal.aborted) break;
          const wire = toWireChunk(chunk);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(wire)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        const payload = err instanceof Error ? { message: err.message } : { message: String(err) };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: payload })}\n\n`));
      } finally {
        controller.close();
      }
    },
    cancel() {
      // Consumer disconnected. The source iterable should observe `signal`.
    },
  });
}

/** Build a synthetic chunk that carries a complete response as a single delta. */
export function responseToSingleChunk(resp: ChatResponse): ChatChunk {
  const first = resp.choices[0];
  return {
    id: resp.id,
    object: 'chat.completion.chunk',
    ...(resp.created !== undefined && { created: resp.created }),
    ...(resp.model !== undefined && { model: resp.model }),
    choices: [{
      index: 0,
      delta: {
        ...(first?.message.role !== undefined && { role: first.message.role }),
        ...(typeof first?.message.content === 'string' && { content: first.message.content }),
      },
      finishReason: first?.finishReason ?? 'stop',
    }],
  };
}

/** Encode a ProgressEvent as a custom SSE event. Clients that don't subscribe ignore it. */
export function encodeProgressEvent(event: ProgressEvent): Uint8Array {
  const { event: name, ...rest } = event;
  return new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(rest)}\n\n`);
}
