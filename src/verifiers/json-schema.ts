import type { ZodTypeAny } from 'zod';
import type { Verifier } from '../types.ts';

export type JsonSchemaVerifierOptions = {
  schema: ZodTypeAny;
};

/**
 * Score 1.0 if the candidate's first choice content parses as JSON and matches
 * the schema, 0.0 otherwise. Tolerates fenced code blocks (```json …```).
 */
export function jsonSchemaVerifier(options: JsonSchemaVerifierOptions): Verifier {
  return {
    name: 'json-schema',
    async score(candidate) {
      const content = candidate.choices[0]?.message.content;
      if (typeof content !== 'string') return 0;
      const text = extractJsonBlock(content);
      if (text == null) return 0;
      let value: unknown;
      try { value = JSON.parse(text); } catch { return 0; }
      const parsed = options.schema.safeParse(value);
      return parsed.success ? 1 : 0;
    },
  };
}

function extractJsonBlock(raw: string): string | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fence ? fence[1]! : trimmed;
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}
