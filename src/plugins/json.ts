import type { ZodTypeAny } from 'zod';
import type { ChatRequest, ChatResponse, Transform, TransformState } from '../types.ts';

export type JsonOptions = {
  /** Zod schema the response must conform to. */
  schema: ZodTypeAny;
  /** Max reformat attempts. Default 1. */
  retries?: number;
  /** Override the reformatting model. Defaults to the original request's model. */
  reformatModel?: string;
};

/**
 * Two-pass structured output.
 *
 * First pass: the model answers in freeform (the original request). The plugin
 * inspects the response and tries to parse JSON matching `schema`. If valid,
 * the response is returned unchanged.
 *
 * Second pass (only if invalid): the plugin sends a focused reformat prompt to
 * the upstream asking it to convert the freeform answer into the exact schema.
 *
 * v1 limitation: streaming is forced off when this plugin is active. The
 * postChunk slot is intentionally undefined — buffering the entire stream to
 * validate and possibly reformat would defeat streaming anyway.
 */
export function json(options: JsonOptions): Transform {
  const retries = Math.max(1, options.retries ?? 1);

  return {
    name: 'json',
    shouldActivate(request) {
      // Per DESIGN §17.8.2: activate when the request asks for structured JSON
      // OR a schema was passed at construction time (always-JSON intent).
      // Schema is required in v0.2, so this resolves to `true` whenever the
      // plugin is registered — explicit by design.
      return Boolean(
        request.responseFormat?.type === 'json_schema' ||
        request.responseFormat?.type === 'json_object' ||
        options.schema,
      );
    },
    async pre(request, state) {
      if (request.stream) {
        state.logger.warn({ event: 'json.stream-disabled', message: 'json plugin forces stream:false' });
      }
      return { ...request, stream: false };
    },
    async post(response, state) {
      const first = response.choices[0];
      if (!first || typeof first.message.content !== 'string') return response;
      const raw = first.message.content;

      const parsed = tryParse(raw, options.schema);
      if (parsed.ok) {
        return replaceFirstContent(response, parsed.normalized);
      }

      let attempt = 0;
      let candidate = raw;
      let lastError = parsed.error;
      while (attempt < retries) {
        attempt += 1;
        const reformatted = await reformat({
          state, candidate, schema: options.schema, attempt, lastError,
          model: options.reformatModel ?? response.model ?? '',
        });
        const recheck = tryParse(reformatted, options.schema);
        if (recheck.ok) {
          state.logger.info({ event: 'json.reformat.success', attempt });
          return replaceFirstContent(response, recheck.normalized);
        }
        lastError = recheck.error;
        candidate = reformatted;
      }
      state.logger.warn({ event: 'json.reformat.failed', attempts: retries, error: lastError });
      return response;
    },
  };
}

function tryParse(raw: string, schema: ZodTypeAny): { ok: true; normalized: string } | { ok: false; error: string } {
  const text = extractJsonBlock(raw);
  if (text == null) return { ok: false, error: 'no JSON object/array found in response' };
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (err) { return { ok: false, error: `invalid JSON: ${(err as Error).message}` }; }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, normalized: JSON.stringify(parsed.data) };
}

/** Extract the first JSON object or array from a string, tolerating fenced code blocks. */
function extractJsonBlock(raw: string): string | null {
  const trimmed = raw.trim();
  // Fenced ```json ... ``` or ``` ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fence ? fence[1]! : trimmed;
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  // Balanced-bracket scan that ignores string contents.
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

async function reformat(args: {
  state: TransformState;
  candidate: string;
  schema: ZodTypeAny;
  attempt: number;
  lastError: string;
  model: string;
}): Promise<string> {
  const schemaDescription = describeSchema(args.schema);
  const reformatReq: ChatRequest = {
    model: args.model,
    messages: [
      {
        role: 'system',
        content:
          'You convert prose answers into exact JSON that satisfies a schema. ' +
          'Reply with a single JSON value and nothing else — no prose, no code fences.',
      },
      {
        role: 'user',
        content:
          `Schema description:\n${schemaDescription}\n\n` +
          `Previous answer (does not parse — reason: ${args.lastError}):\n${args.candidate}\n\n` +
          `Return the JSON value now.`,
      },
    ],
    temperature: 0,
  };
  const resp = await args.state.upstream.complete(reformatReq, args.state.signal);
  const content = resp.choices[0]?.message.content;
  return typeof content === 'string' ? content : '';
}

function describeSchema(schema: ZodTypeAny): string {
  // Lightweight schema description. Full JSON-Schema conversion is out of v1 scope —
  // the description prompt just needs to give the model a structural hint.
  const def = (schema._def ?? {}) as { typeName?: string; shape?: () => Record<string, unknown> };
  if (def.typeName === 'ZodObject' && typeof def.shape === 'function') {
    const shape = def.shape();
    const keys = Object.keys(shape);
    return `Object with keys: ${keys.join(', ')}`;
  }
  return def.typeName ?? 'JSON value';
}

function replaceFirstContent(response: ChatResponse, content: string): ChatResponse {
  const choices = response.choices.slice();
  const first = choices[0];
  if (!first) return response;
  choices[0] = { ...first, message: { ...first.message, content } };
  return { ...response, choices };
}
