import { approximateTokens, chunkText } from '../internal/chunking.ts';
import type {
  ChatRequest, ChatResponse, Message, Technique, TechniqueContext, UpstreamClient,
} from '../types.ts';

export type MemoryOptions = {
  /** Target tokens per chunk in stage 1. Default 4000. */
  chunkTokens?: number;
  /** Overlap between adjacent chunks (in tokens). Default 200. */
  overlapTokens?: number;
  /** Fraction of the model's context window above which chunking activates.
   *  Default 0.7. Below this, the request passes through unchanged. */
  threshold?: number;
  /** Custom token counter (defaults to approximate `text.length / 4`). */
  tokensFn?: (text: string) => number;
  /** Override the model used for margin-note extraction. Defaults to the request model. */
  marginModel?: string;
};

/**
 * Memory — Writing in the Margins.
 *
 * 1. Find the long document in the request (heuristic: longest user-content block).
 * 2. If document tokens < threshold * context window, pass through.
 * 3. Otherwise chunk and ask the upstream to extract relevant margin notes for
 *    each chunk relative to the user's question. Notes prefixed `YES#` are kept.
 * 4. Replace the long content with the concatenated margin notes and re-issue
 *    the question via `ctx.next` so the rest of the pipeline (verifiers, voters,
 *    streaming) sees a normal-sized request.
 */
export function memory(options: MemoryOptions = {}): Technique {
  const chunkTokens = options.chunkTokens ?? 4000;
  const overlapTokens = options.overlapTokens ?? 200;
  const threshold = options.threshold ?? 0.7;
  const countTokens = options.tokensFn ?? approximateTokens;

  return {
    name: 'memory',
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: true,
      addsLatency: 'medium',
      tokenMultiplier: 2,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },

    async apply(ctx: TechniqueContext): Promise<ChatResponse> {
      const target = pickDocumentTarget(ctx.request);
      if (!target) return ctx.next(ctx.request);

      const contextWindow = ctx.modelProfile.contextWindow;
      const documentTokens = countTokens(target.text);
      if (contextWindow && documentTokens < contextWindow * threshold) {
        return ctx.next(ctx.request);
      }
      // No context window known and the document isn't huge: skip too.
      if (!contextWindow && documentTokens < chunkTokens) {
        return ctx.next(ctx.request);
      }

      const question = extractQuestion(ctx.request, target);
      const chunks = chunkText(target.text, { chunkTokens, overlapTokens, ...(options.tokensFn !== undefined && { tokensFn: options.tokensFn }) });
      ctx.logger.info({ event: 'memory.chunked', chunks: chunks.length, documentTokens });

      const marginNotes: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        if (ctx.signal.aborted) break;
        const note = await extractMarginNote(
          ctx.upstream,
          options.marginModel ?? ctx.request.model,
          chunks[i]!,
          question,
          ctx.signal,
        );
        if (note) marginNotes.push(note);
        ctx.progress({ event: 'xinity.chunk.processed', index: i + 1, of: chunks.length });
      }
      ctx.logger.info({ event: 'memory.margins', kept: marginNotes.length, of: chunks.length });

      const condensedRequest = replaceDocument(ctx.request, target, formatMargins(marginNotes));
      return ctx.next(condensedRequest);
    },
  };
}

type DocumentTarget = { messageIndex: number; partIndex?: number; text: string };

function pickDocumentTarget(request: ChatRequest): DocumentTarget | null {
  let best: DocumentTarget | null = null;
  for (let i = 0; i < request.messages.length; i++) {
    const m = request.messages[i]!;
    if (m.role === 'assistant' || m.content == null) continue;
    if (typeof m.content === 'string') {
      if (!best || m.content.length > best.text.length) best = { messageIndex: i, text: m.content };
    } else {
      for (let j = 0; j < m.content.length; j++) {
        const part = m.content[j]!;
        if (part.type === 'text' && (!best || part.text.length > best.text.length)) {
          best = { messageIndex: i, partIndex: j, text: part.text };
        }
      }
    }
  }
  return best;
}

function extractQuestion(request: ChatRequest, target: DocumentTarget): string {
  // Prefer the last user message that isn't the document itself.
  for (let i = request.messages.length - 1; i >= 0; i--) {
    if (i === target.messageIndex) continue;
    const m = request.messages[i]!;
    if (m.role !== 'user' || m.content == null) continue;
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (text.trim()) return text;
  }
  // Fallback: if the document message itself ends with an explicit "Query: …",
  // use that. Otherwise default to a generic summarisation prompt.
  const queryIdx = target.text.lastIndexOf('Query:');
  if (queryIdx !== -1) return target.text.slice(queryIdx + 6).trim();
  return 'What is the main point of the document above?';
}

async function extractMarginNote(
  upstream: UpstreamClient, model: string, chunk: string, question: string, signal: AbortSignal,
): Promise<string | null> {
  const req: ChatRequest = {
    model,
    messages: [
      {
        role: 'system',
        content:
          'Extract only context relevant to the user\'s question from the supplied text. ' +
          'If the text contains relevant information, reply starting with "YES#" then the context. ' +
          'If the text is not relevant, reply with exactly "NO#" and nothing else.',
      },
      {
        role: 'user',
        content: `Text:\n${chunk}\n\nQuestion: ${question}\n\nReply with YES#... or NO#`,
      },
    ],
    temperature: 0,
    maxTokens: 800,
    stream: false,
  };
  const resp = await upstream.complete(req, signal);
  const content = resp.choices[0]?.message.content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('YES#')) return null;
  return trimmed.slice(4).trim();
}

function formatMargins(notes: string[]): string {
  if (notes.length === 0) {
    return '(no relevant information was found in the document for this query)';
  }
  return [
    'These are margin notes extracted from the original document, organized in order of appearance:',
    ...notes.map((n, i) => `[${i + 1}] ${n}`),
  ].join('\n\n');
}

function replaceDocument(request: ChatRequest, target: DocumentTarget, replacement: string): ChatRequest {
  const messages: Message[] = request.messages.map((m, i) => {
    if (i !== target.messageIndex) return m;
    if (target.partIndex === undefined) return { ...m, content: replacement };
    if (m.content == null || typeof m.content === 'string') return m;
    const newParts = m.content.map((p, j) => j === target.partIndex && p.type === 'text' ? { ...p, text: replacement } : p);
    return { ...m, content: newParts };
  });
  return { ...request, messages };
}
