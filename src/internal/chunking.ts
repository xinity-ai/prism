/**
 * Approximate token count for budgeting. `text.length / 4` is the canonical
 * cheap heuristic for English/Latin-1 text and is good enough for v1 chunk
 * sizing — DeepConf uses real per-token logprobs from the upstream and does
 * not depend on this. Inject a precise tokenizer through `tokensFn` if needed.
 */
export const approximateTokens = (text: string): number => Math.ceil(text.length / 4);

export type ChunkOptions = {
  /** Target tokens per chunk. */
  chunkTokens: number;
  /** Overlap between adjacent chunks (in tokens). */
  overlapTokens?: number;
  /** Custom token counter. Defaults to length/4. */
  tokensFn?: (text: string) => number;
};

/**
 * Split a long text into chunks of approximately `chunkTokens`, with overlap.
 *
 * Boundary-finding: starts from the target end-offset in chars and walks back
 * to the nearest paragraph/sentence/word boundary so chunks don't tear words.
 * Returns the original text unchanged if it already fits.
 */
export function chunkText(text: string, options: ChunkOptions): string[] {
  const chunkTokens = Math.max(1, options.chunkTokens);
  const overlapTokens = Math.max(0, Math.min(options.overlapTokens ?? 0, chunkTokens - 1));
  const countTokens = options.tokensFn ?? approximateTokens;
  if (countTokens(text) <= chunkTokens) return [text];

  // Approximate chars per token from the actual text — better than a fixed 4
  // when `tokensFn` is a real tokenizer.
  const totalChars = text.length;
  const totalTokens = countTokens(text);
  const charsPerToken = totalChars / Math.max(1, totalTokens);
  const targetChars = Math.max(1, Math.round(chunkTokens * charsPerToken));
  const overlapChars = Math.max(0, Math.round(overlapTokens * charsPerToken));

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const naiveEnd = Math.min(text.length, start + targetChars);
    const end = naiveEnd >= text.length ? text.length : findBoundary(text, start, naiveEnd);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
}

function findBoundary(text: string, start: number, target: number): number {
  // Look for a paragraph break first, then sentence terminator, then whitespace.
  // Search within a window before `target` only — never advance past it (would
  // overflow the chunk budget). Window width = 20% of chunk size, capped at 400.
  const windowSize = Math.min(400, Math.max(40, Math.round((target - start) * 0.2)));
  const windowStart = Math.max(start, target - windowSize);
  const candidates: number[] = [];

  const pushIfLater = (i: number) => { if (i > windowStart) candidates.push(i); };
  pushIfLater(text.lastIndexOf('\n\n', target));
  pushIfLater(text.lastIndexOf('. ', target));
  pushIfLater(text.lastIndexOf('! ', target));
  pushIfLater(text.lastIndexOf('? ', target));
  pushIfLater(text.lastIndexOf('\n', target));
  pushIfLater(text.lastIndexOf(' ', target));

  if (candidates.length === 0) return target;
  // Prefer the highest-quality boundary that falls within the window.
  return Math.max(...candidates) + 1; // +1 so the boundary char stays with the previous chunk
}
