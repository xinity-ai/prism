import type { ChatResponse, Voter } from '../types.ts';

/**
 * Extract the "final answer" from a response. Tries, in order:
 *  1. Content inside a `\boxed{...}` macro (math/MMLU convention).
 *  2. Content inside the last fenced code block.
 *  3. Content after the last `Answer:` / `Final answer:` / `####` marker
 *     (GSM8K convention).
 *  4. The trimmed full content.
 */
export function extractFinalAnswer(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  const boxed = /\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let lastBoxed: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = boxed.exec(trimmed)) !== null) lastBoxed = match;
  if (lastBoxed) return lastBoxed[1]!.trim();

  const fences = [...trimmed.matchAll(/```(?:[\w-]+)?\s*\n?([\s\S]*?)```/g)];
  if (fences.length > 0) return fences[fences.length - 1]![1]!.trim();

  // GSM8K-style #### marker or Final answer label.
  const labelled = trimmed.match(/(?:####|(?:final\s+)?answer\s*[:\-])\s*([\s\S]+?)\s*$/i);
  if (labelled) return labelled[1]!.trim();

  return trimmed;
}

/**
 * Normalize a candidate answer for equality comparison.
 *
 * Strips two classes of variability that fragment otherwise-equivalent answers
 * into different hash buckets:
 *  - **Math blocks** (`$$ … $$`, `\[ … \]`, fenced ```math` / ```latex` / ```tex` `):
 *    the model "showing its work" alongside a prose answer. Removed entirely
 *    (delimiters and content), since a correct answer and a wrong derivation
 *    can co-exist in one response and we want to vote on the *claim*, not the
 *    derivation.
 *  - **Emphasis markers** (`**`, `__`, `*`, `_`, `` ` ``): keep the content,
 *    drop the markers, so `**42**` and `42` hash identically.
 */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    // strip display-math blocks entirely
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    // strip math-tagged fenced code blocks entirely
    .replace(/```(?:math|latex|tex)\b[\s\S]*?```/gi, ' ')
    // strip emphasis / code markers but keep their content
    .replace(/\*+/g, '')
    .replace(/_+/g, '')
    .replace(/`+/g, '')
    // collapse whitespace and commas to single spaces
    .replace(/[\s,]+/g, ' ')
    .trim()
    .replace(/[.!?]+$/g, '')
    .trim();
}

/** Default voter: extract → normalize → majority vote, ties broken by first-seen order. */
export function defaultVoter(): Voter {
  return {
    name: 'majority-vote',
    vote(candidates) {
      if (candidates.length === 0) throw new Error('voter: no candidates');
      const distribution: Record<string, number> = {};
      const firstSeenIndex: Record<string, number> = {};
      const representatives: Record<string, ChatResponse> = {};
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const content = c.choices[0]?.message.content;
        if (typeof content !== 'string') continue;
        const key = normalizeAnswer(extractFinalAnswer(content));
        distribution[key] = (distribution[key] ?? 0) + 1;
        if (!(key in firstSeenIndex)) {
          firstSeenIndex[key] = i;
          representatives[key] = c;
        }
      }
      const entries = Object.entries(distribution);
      if (entries.length === 0) {
        return { winner: candidates[0]!, distribution: {} };
      }
      entries.sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return (firstSeenIndex[a[0]] ?? 0) - (firstSeenIndex[b[0]] ?? 0);
      });
      const winnerKey = entries[0]![0];
      return { winner: representatives[winnerKey]!, distribution };
    },
  };
}
