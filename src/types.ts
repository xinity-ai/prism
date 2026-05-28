import { z } from 'zod';

// =============================================================================
// Wire format — snake_case, validated at the HTTP boundary. Mirrors OpenAI.
// =============================================================================

const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool', 'developer']);

const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ImageContentSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: z.string(), detail: z.enum(['auto', 'low', 'high']).optional() }),
});

const ContentPartSchema = z.union([TextContentSchema, ImageContentSchema]);

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const MessageSchema = z.object({
  role: RoleSchema,
  content: z.union([z.string(), z.array(ContentPartSchema), z.null()]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
});

const ToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
  }),
});

const ToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
]);

const ResponseFormatSchema = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string(),
      schema: z.unknown(),
      strict: z.boolean().optional(),
    }),
  }),
]);

const XinityTechniqueRefSchema = z.union([
  z.string(),
  z.object({ name: z.string(), options: z.unknown().optional() }),
]);

/**
 * Auto-routing mode. `'plugins'` enables the rules-based router for this
 * request (privacy/readUrls/json/memory). `'none'` disables it.
 *
 * Reserved for forward-compat: `'techniques'` and `'all'` will be added when
 * the semantic router (v0.3, `@xinity/prism-router-semantic`) ships.
 */
const XinityAutoSchema = z.enum(['plugins', 'none']);

export const XinityConfigSchema = z
  .object({
    techniques: z.array(XinityTechniqueRefSchema).optional(),
    plugins: z.array(XinityTechniqueRefSchema).optional(),
    modelProfile: z.string().optional(),
    disabled: z.array(z.string()).optional(),
    auto: XinityAutoSchema.optional(),
    /**
     * Request-level thinking-mode toggle. When `true`, the resolved
     * {@link ModelProfile.thinkingParams} hook (if any) produces a bag of wire
     * fields merged into the upstream payload — e.g. for Qwen3 via vLLM,
     * `{ chat_template_kwargs: { enable_thinking: true } }`. The pipeline also
     * treats the model as thinking-mode for that request: techniques marked
     * `subsumedByThinkingMode` are skipped and self-consistency drops k.
     */
    thinking: z.boolean().optional(),
  })
  .strict();

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(MessageSchema),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    n: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    logprobs: z.boolean().optional(),
    top_logprobs: z.number().int().min(0).max(20).optional(),
    response_format: ResponseFormatSchema.optional(),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceSchema.optional(),
    seed: z.number().int().optional(),
    user: z.string().optional(),
    xinity: XinityConfigSchema.optional(),
    /**
     * OpenAI-style reasoning-effort control. Consumed at the gateway boundary
     * (NOT forwarded upstream): translated to the boolean thinking toggle and
     * fed through the profile's {@link ModelProfile.thinkingParams} hook.
     * Mapping: `minimal` → off; `low`/`medium`/`high` → on.
     * When both `reasoning_effort` and `xinity.thinking` are set on the same
     * request, `reasoning_effort` wins.
     */
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  })
  .passthrough();

export type WireChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

const TopLogprobSchema = z.object({ token: z.string(), logprob: z.number(), bytes: z.array(z.number()).nullable().optional() });
const LogprobContentSchema = z.object({
  token: z.string(),
  logprob: z.number(),
  bytes: z.array(z.number()).nullable().optional(),
  top_logprobs: z.array(TopLogprobSchema).optional(),
});
const LogprobsSchema = z.object({
  content: z.array(LogprobContentSchema).nullable().optional(),
});

const ChoiceSchema = z.object({
  index: z.number().int(),
  message: MessageSchema,
  finish_reason: z.string().nullable().optional(),
  logprobs: LogprobsSchema.nullable().optional(),
});

const UsageSchema = z.object({
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  total_tokens: z.number().int(),
});

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    object: z.literal('chat.completion').optional(),
    created: z.number().int().nullish(),
    model: z.string().nullish(),
    choices: z.array(ChoiceSchema),
    usage: UsageSchema.nullish(),
    system_fingerprint: z.string().nullish(),
  })
  .passthrough();

export type WireChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;

const DeltaSchema = z.object({
  role: RoleSchema.optional(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(z.object({
    index: z.number().int(),
    id: z.string().optional(),
    type: z.literal('function').optional(),
    function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
  })).optional(),
});

const ChunkChoiceSchema = z.object({
  index: z.number().int(),
  delta: DeltaSchema,
  finish_reason: z.string().nullable().optional(),
  logprobs: LogprobsSchema.nullable().optional(),
});

export const ChatCompletionChunkSchema = z
  .object({
    id: z.string(),
    object: z.literal('chat.completion.chunk').optional(),
    created: z.number().int().nullish(),
    model: z.string().nullish(),
    choices: z.array(ChunkChoiceSchema),
    usage: UsageSchema.nullish(),
  })
  .passthrough();

export type WireChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;

// =============================================================================
// Internal normalized types — camelCase. Techniques and plugins use these.
// =============================================================================

export type Role = z.infer<typeof RoleSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type Usage = z.infer<typeof UsageSchema>;

export type Message = {
  role: Role;
  content?: string | ContentPart[] | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type XinityTechniqueRef = string | { name: string; options?: unknown };

export type XinityAutoMode = z.infer<typeof XinityAutoSchema>;

export type XinityConfig = {
  techniques?: XinityTechniqueRef[];
  plugins?: XinityTechniqueRef[];
  modelProfile?: string;
  disabled?: string[];
  auto?: XinityAutoMode;
  thinking?: boolean;
};

export type ChatRequest = {
  model: string;
  messages: Message[];
  temperature?: number;
  topP?: number;
  n?: number;
  stream?: boolean;
  stop?: string[];
  maxTokens?: number;
  maxCompletionTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  logprobs?: boolean;
  topLogprobs?: number;
  responseFormat?: ResponseFormat;
  tools?: Tool[];
  toolChoice?: ToolChoice;
  seed?: number;
  user?: string;
  xinity?: XinityConfig;
  /**
   * Arbitrary vendor-specific wire fields forwarded verbatim to the upstream
   * (e.g. `top_k`, `chat_template_kwargs`). Captured from unknown top-level
   * fields on the wire, and shallow-merged back on the way out — known
   * {@link ChatRequest} fields take precedence on overlap. Note: OpenAI-style
   * `reasoning_effort` is NOT a passthrough — it's consumed at the gateway
   * boundary and translated to the profile's thinking toggle.
   */
  extraBody?: Record<string, unknown>;
};

export type Logprob = {
  token: string;
  logprob: number;
  bytes?: number[] | null;
  topLogprobs?: { token: string; logprob: number; bytes?: number[] | null }[];
};

export type Logprobs = { content?: Logprob[] | null };

export type Choice = {
  index: number;
  message: Message;
  finishReason?: string | null;
  logprobs?: Logprobs | null;
};

export type ChatResponse = {
  id: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Choice[];
  usage?: Usage;
  systemFingerprint?: string;
  /** Per-response metadata Xinity attaches at the upstream boundary. Not on the wire. */
  xinityMeta: { hadLogprobs: boolean };
};

export type ChunkDelta = {
  role?: Role;
  content?: string | null;
  toolCalls?: {
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }[];
};

export type ChunkChoice = {
  index: number;
  delta: ChunkDelta;
  finishReason?: string | null;
  logprobs?: Logprobs | null;
};

export type ChatChunk = {
  id: string;
  object?: string;
  created?: number;
  model?: string;
  choices: ChunkChoice[];
  usage?: Usage;
  xinityMeta?: { hadLogprobs: boolean };
};

// =============================================================================
// Wire <-> internal conversions
// =============================================================================

/** Wire field names the schema explicitly models; anything else flows through `extraBody`. */
const KNOWN_WIRE_REQUEST_KEYS = new Set([
  'model', 'messages', 'temperature', 'top_p', 'n', 'stream', 'stop',
  'max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty',
  'logprobs', 'top_logprobs', 'response_format', 'tools', 'tool_choice',
  'seed', 'user', 'xinity', 'reasoning_effort',
]);

export function fromWireRequest(wire: WireChatCompletionRequest): ChatRequest {
  const extraBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wire)) {
    if (KNOWN_WIRE_REQUEST_KEYS.has(key)) continue;
    extraBody[key] = value;
  }
  return {
    model: wire.model,
    messages: wire.messages.map(fromWireMessage),
    temperature: wire.temperature,
    topP: wire.top_p,
    n: wire.n,
    stream: wire.stream,
    stop: typeof wire.stop === 'string' ? [wire.stop] : wire.stop,
    maxTokens: wire.max_tokens,
    maxCompletionTokens: wire.max_completion_tokens,
    presencePenalty: wire.presence_penalty,
    frequencyPenalty: wire.frequency_penalty,
    logprobs: wire.logprobs,
    topLogprobs: wire.top_logprobs,
    responseFormat: wire.response_format,
    tools: wire.tools,
    toolChoice: wire.tool_choice,
    seed: wire.seed,
    user: wire.user,
    xinity: wire.xinity,
    ...(Object.keys(extraBody).length > 0 && { extraBody }),
  };
}

export function toWireRequest(req: ChatRequest): WireChatCompletionRequest {
  // Spread extras first so known fields below win on overlap.
  const out: Record<string, unknown> = { ...(req.extraBody ?? {}) };
  out.model = req.model;
  out.messages = req.messages.map(toWireMessage);
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.topP !== undefined) out.top_p = req.topP;
  if (req.n !== undefined) out.n = req.n;
  if (req.stream !== undefined) out.stream = req.stream;
  if (req.stop !== undefined) out.stop = req.stop;
  if (req.maxTokens !== undefined) out.max_tokens = req.maxTokens;
  if (req.maxCompletionTokens !== undefined) out.max_completion_tokens = req.maxCompletionTokens;
  if (req.presencePenalty !== undefined) out.presence_penalty = req.presencePenalty;
  if (req.frequencyPenalty !== undefined) out.frequency_penalty = req.frequencyPenalty;
  if (req.logprobs !== undefined) out.logprobs = req.logprobs;
  if (req.topLogprobs !== undefined) out.top_logprobs = req.topLogprobs;
  if (req.responseFormat !== undefined) out.response_format = req.responseFormat;
  if (req.tools !== undefined) out.tools = req.tools;
  if (req.toolChoice !== undefined) out.tool_choice = req.toolChoice;
  if (req.seed !== undefined) out.seed = req.seed;
  if (req.user !== undefined) out.user = req.user;
  return out as WireChatCompletionRequest;
}

function fromWireMessage(m: z.infer<typeof MessageSchema>): Message {
  const msg: Message = { role: m.role };
  if (m.content !== undefined) msg.content = m.content;
  if (m.name !== undefined) msg.name = m.name;
  if (m.tool_call_id !== undefined) msg.toolCallId = m.tool_call_id;
  if (m.tool_calls !== undefined) msg.toolCalls = m.tool_calls;
  return msg;
}

function toWireMessage(m: Message): z.infer<typeof MessageSchema> {
  const out: Record<string, unknown> = { role: m.role };
  if (m.content !== undefined) out.content = m.content;
  if (m.name !== undefined) out.name = m.name;
  if (m.toolCallId !== undefined) out.tool_call_id = m.toolCallId;
  if (m.toolCalls !== undefined) out.tool_calls = m.toolCalls;
  return out as z.infer<typeof MessageSchema>;
}

export function fromWireResponse(wire: WireChatCompletionResponse): ChatResponse {
  const hadLogprobs = wire.choices.some(c => c.logprobs != null && c.logprobs.content != null && c.logprobs.content.length > 0);
  return {
    id: wire.id,
    object: wire.object,
    created: wire.created ?? undefined,
    model: wire.model ?? undefined,
    choices: wire.choices.map(c => ({
      index: c.index,
      message: fromWireMessage(c.message),
      finishReason: c.finish_reason ?? null,
      logprobs: c.logprobs ? fromWireLogprobs(c.logprobs) : null,
    })),
    usage: wire.usage ?? undefined,
    systemFingerprint: wire.system_fingerprint ?? undefined,
    xinityMeta: { hadLogprobs },
  };
}

export function toWireResponse(resp: ChatResponse): WireChatCompletionResponse {
  return {
    id: resp.id,
    object: resp.object ?? 'chat.completion',
    ...(resp.created !== undefined && { created: resp.created }),
    ...(resp.model !== undefined && { model: resp.model }),
    choices: resp.choices.map(c => ({
      index: c.index,
      message: toWireMessage(c.message),
      finish_reason: c.finishReason ?? null,
      ...(c.logprobs !== undefined && { logprobs: c.logprobs ? toWireLogprobs(c.logprobs) : null }),
    })),
    ...(resp.usage !== undefined && { usage: resp.usage }),
    ...(resp.systemFingerprint !== undefined && { system_fingerprint: resp.systemFingerprint }),
  } as WireChatCompletionResponse;
}

export function fromWireChunk(wire: WireChatCompletionChunk): ChatChunk {
  const hadLogprobs = wire.choices.some(c => c.logprobs != null && c.logprobs.content != null);
  return {
    id: wire.id,
    object: wire.object,
    created: wire.created ?? undefined,
    model: wire.model ?? undefined,
    choices: wire.choices.map(c => ({
      index: c.index,
      delta: {
        ...(c.delta.role !== undefined && { role: c.delta.role }),
        ...(c.delta.content !== undefined && { content: c.delta.content }),
        ...(c.delta.tool_calls !== undefined && {
          toolCalls: c.delta.tool_calls.map(tc => ({
            index: tc.index,
            ...(tc.id !== undefined && { id: tc.id }),
            ...(tc.type !== undefined && { type: tc.type }),
            ...(tc.function !== undefined && { function: tc.function }),
          })),
        }),
      },
      finishReason: c.finish_reason ?? null,
      logprobs: c.logprobs ? fromWireLogprobs(c.logprobs) : null,
    })),
    usage: wire.usage ?? undefined,
    xinityMeta: { hadLogprobs },
  };
}

export function toWireChunk(chunk: ChatChunk): WireChatCompletionChunk {
  return {
    id: chunk.id,
    object: chunk.object ?? 'chat.completion.chunk',
    ...(chunk.created !== undefined && { created: chunk.created }),
    ...(chunk.model !== undefined && { model: chunk.model }),
    choices: chunk.choices.map(c => ({
      index: c.index,
      delta: {
        ...(c.delta.role !== undefined && { role: c.delta.role }),
        ...(c.delta.content !== undefined && { content: c.delta.content }),
        ...(c.delta.toolCalls !== undefined && {
          tool_calls: c.delta.toolCalls.map(tc => ({
            index: tc.index,
            ...(tc.id !== undefined && { id: tc.id }),
            ...(tc.type !== undefined && { type: tc.type }),
            ...(tc.function !== undefined && { function: tc.function }),
          })),
        }),
      },
      finish_reason: c.finishReason ?? null,
      ...(c.logprobs !== undefined && { logprobs: c.logprobs ? toWireLogprobs(c.logprobs) : null }),
    })),
    ...(chunk.usage !== undefined && { usage: chunk.usage }),
  } as WireChatCompletionChunk;
}

function fromWireLogprobs(lp: z.infer<typeof LogprobsSchema>): Logprobs {
  return {
    content: lp.content
      ? lp.content.map(t => ({
          token: t.token,
          logprob: t.logprob,
          bytes: t.bytes ?? null,
          ...(t.top_logprobs !== undefined && {
            topLogprobs: t.top_logprobs.map(tl => ({ token: tl.token, logprob: tl.logprob, bytes: tl.bytes ?? null })),
          }),
        }))
      : null,
  };
}

function toWireLogprobs(lp: Logprobs): z.infer<typeof LogprobsSchema> {
  return {
    content: lp.content
      ? lp.content.map(t => ({
          token: t.token,
          logprob: t.logprob,
          bytes: t.bytes ?? null,
          ...(t.topLogprobs !== undefined && {
            top_logprobs: t.topLogprobs.map(tl => ({ token: tl.token, logprob: tl.logprob, bytes: tl.bytes ?? null })),
          }),
        }))
      : null,
  };
}

// =============================================================================
// UpstreamClient, Logger, ModelProfile
// =============================================================================

export interface UpstreamClient {
  complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
  /** Pass-through fast path: returns the raw upstream Response so the server
   *  can pipe its body unchanged. Never used by techniques. */
  raw(req: ChatRequest, signal: AbortSignal): Promise<Response>;
}

export interface Logger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
  error(event: Record<string, unknown> | Error): void;
  child(context: Record<string, unknown>): Logger;
}

export type ModelProfile = {
  /** Optional friendly name for explicit selection via `xinity.modelProfile`. */
  name?: string;
  /** Pattern matched against request.model. First match wins. */
  match: RegExp | string;
  /** Model has internal CoT/thinking. Adjusts default k, skips subsumed techniques. */
  thinkingMode: boolean;
  /** Upstream returns logprobs reliably. */
  supportsLogprobs: boolean;
  /** Optional context window (in tokens). Used by Memory to decide when to chunk. */
  contextWindow?: number;
  /**
   * Translate a per-request thinking toggle into provider-specific wire fields
   * merged into the request's `extraBody`. Lets a generic `xinity.thinking: true`
   * become e.g. `chat_template_kwargs: { enable_thinking: true }` (Qwen3/vLLM)
   * or `reasoning_effort: 'high'` (gpt-5). Return `undefined` when nothing to add.
   *
   * Required when the profile claims `thinkingModeToggleable: true`. A request
   * with `xinity.thinking` set against a profile without this hook (and not
   * explicitly toggleable) is rejected with `thinking_not_supported` rather
   * than silently no-ops — see {@link thinkingModeToggleable}.
   */
  thinkingParams?: (on: boolean) => Record<string, unknown> | undefined;
  /**
   * Whether `xinity.thinking` may be toggled per-request for this profile.
   *
   *   - `true` (or omitted, when `thinkingParams` is defined): the gateway
   *     calls `thinkingParams(on)` and merges its output.
   *   - `false`: requests with `xinity.thinking` are rejected with a 400
   *     `thinking_not_supported` error, even if `thinkingParams` exists.
   *     Use this for models where thinking is hard-coded by the training
   *     recipe and cannot be turned off (e.g. some pure-reasoning checkpoints).
   *
   * The failure-mode this guards is silent corruption: a profile without
   * `thinkingParams` accepting `xinity.thinking: false` would flip the pipeline
   * gate (techniques skipped, K dropped) while the upstream still thinks,
   * because nothing in the wire payload told it not to. Ablation studies and
   * thinking-vs-non-thinking benchmarks rely on the loud-failure semantics.
   */
  thinkingModeToggleable?: boolean;
};

// =============================================================================
// Technique / Transform / ProgressEvent
// =============================================================================

export type TechniqueCapabilities = {
  requiresLogprobs: boolean;
  supportsStreaming: boolean;
  addsLatency: 'low' | 'medium' | 'high';
  tokenMultiplier: number;
  worksWithThinkingMode: boolean;
  subsumedByThinkingMode: boolean;
};

export type ProgressEvent =
  | { event: 'xinity.sample.complete'; index: number; of: number; tokens?: number }
  | { event: 'xinity.scores'; scores: number[] }
  | { event: 'xinity.voting'; distribution: Record<string, number>; winner: string }
  | { event: 'xinity.plan.generated'; index: number; of: number; plan: string }
  | { event: 'xinity.chunk.processed'; index: number; of: number }
  | { event: 'xinity.round-trip.score'; score: number; threshold: number; attempt: number }
  | { event: 'xinity.deep-conf.kept'; kept: number; of: number; confidences: number[] }
  | { event: 'xinity.deep-conf.aborted'; reason: 'low-confidence' | 'budget'; position: number }
  | { event: 'xinity.technique.skipped'; name: string; reason: 'subsumed-by-thinking-mode' | 'capability-mismatch' }
  | { event: 'xinity.warning'; message: string };

export type TechniqueContext = {
  request: ChatRequest;
  upstream: UpstreamClient;
  next: (req: ChatRequest) => Promise<ChatResponse>;
  modelProfile: ModelProfile;
  signal: AbortSignal;
  logger: Logger;
  progress: (event: ProgressEvent) => void;
};

export type Technique = {
  readonly name: string;
  readonly capabilities: TechniqueCapabilities;
  apply(ctx: TechniqueContext): Promise<ChatResponse>;
};

export type TransformState = {
  store: Map<string, unknown>;
  logger: Logger;
  signal: AbortSignal;
  upstream: UpstreamClient;
  modelProfile: ModelProfile;
};

export type Transform = {
  readonly name: string;
  pre?(request: ChatRequest, state: TransformState): Promise<ChatRequest>;
  post?(response: ChatResponse, state: TransformState): Promise<ChatResponse>;
  postChunk?(chunk: ChatChunk, state: TransformState): Promise<ChatChunk>;
};

// =============================================================================
// Verifiers, voters, equivalence scorers (used by techniques)
// =============================================================================

export type Verifier = {
  readonly name: string;
  score(candidate: ChatResponse, request: ChatRequest, signal: AbortSignal): Promise<number>;
};

export type EquivalenceScorer = {
  readonly name: string;
  score(a: string, b: string, signal: AbortSignal): Promise<number>;
};

export type Voter = {
  readonly name: string;
  vote(candidates: ChatResponse[]): { winner: ChatResponse; distribution: Record<string, number> };
};

// =============================================================================
// Errors
// =============================================================================

export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
