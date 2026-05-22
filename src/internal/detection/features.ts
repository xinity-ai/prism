import { approximateTokens } from '../chunking.ts';
import type { ChatRequest, Message } from '../../types.ts';
import type { RequestFeatures } from './types.ts';

/**
 * Compute a {@link RequestFeatures} once per request. Detectors consume this
 * instead of walking `request.messages` themselves.
 *
 * Only text content is included. Image parts contribute nothing to `text`;
 * tool-call argument JSON is excluded because detectors target user/agent
 * prose, not tool plumbing.
 */
export function extractFeatures(request: ChatRequest): RequestFeatures {
  const text = collectText(request.messages);
  return {
    text,
    messageCount: request.messages.length,
    tokenEstimate: approximateTokens(text),
  };
}

function collectText(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.content == null) continue;
    if (typeof m.content === 'string') {
      if (m.content.length > 0) parts.push(m.content);
      continue;
    }
    for (const p of m.content) {
      if (p.type === 'text' && p.text.length > 0) parts.push(p.text);
    }
  }
  return parts.join('\n');
}
