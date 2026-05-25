# Prism (`@xinity/prism`) — Design

**Status:** Draft v1
**Audience:** Reviewer (Alex), Claude Code (reference)
**Scope:** v1 only. Anything not listed here is explicitly out of scope.

---

## 1. Purpose

An OpenAI-compatible reverse proxy that applies inference-time optimization techniques on top of any OpenAI-compatible upstream (vLLM, Ollama, SGLang, llama.cpp, hosted APIs). Sits between client applications and self-hosted reasoning models in Xinity's sovereign deployments.

Two modes of use:
- **HTTP server:** drop-in OpenAI replacement at `http://localhost:4000/v1/...`
- **Programmatic client:** import a function, get an optimized response

When no techniques are active, the proxy is byte-for-byte transparent — including streaming, tool calls, and logprobs.

## 2. Design principles

1. **Techniques are middleware.** Composition over configuration. A pipeline is a function, not a class.
2. **One way to call upstream.** Every model call goes through `UpstreamClient`. This is the only `fetch` to a model endpoint.
3. **Wire format ≠ internal format.** OpenAI uses `snake_case` on the wire; we use `camelCase` internally and translate at the edges.
4. **Capabilities are typed.** A technique declares whether it needs logprobs, breaks streaming, multiplies tokens, works with thinking-mode. The runtime checks these before executing.
5. **Plugins ≠ techniques.** Plugins (`Transform`) operate on I/O around the pipeline. Techniques (`Technique`) own the reasoning process.
6. **Transparent by default.** No techniques, no plugins, no behavior change. Pass-through must be tested as a first-class case.
7. **No framework.** Bun's primitives are enough. The total dependency count target is three.

## 3. Public API surface

### 3.1 Top-level exports (`index.ts`)

```typescript
// Server
export { createGateway } from './server';
export type { GatewayConfig } from './server';

// Programmatic client
export { createClient } from './client';
export type { Client, ClientOptions } from './client';

// Technique and Transform types (for users writing custom ones)
export type {
  Technique,
  TechniqueContext,
  TechniqueCapabilities,
  Transform,
  TransformState,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  UpstreamClient,
  ModelProfile,
  Logger,
} from './types';

// Built-in techniques (named exports, not a registry)
export { selfConsistency } from './techniques/self-consistency';
export { bestOfN } from './techniques/best-of-n';
export { memory } from './techniques/memory';
export { planSearch } from './techniques/plan-search';
export { roundTrip } from './techniques/round-trip';
export { deepConf } from './techniques/deep-conf';

// Built-in plugins
export { privacy } from './plugins/privacy';
export { readUrls } from './plugins/read-urls';
export { json } from './plugins/json';
export { executeCode } from './plugins/execute-code';

// Built-in verifiers (used with bestOfN) — each from its own module, no barrel
export { regexVerifier } from './verifiers/regex';
export { jsonSchemaVerifier } from './verifiers/json-schema';
export { judgeVerifier } from './verifiers/judge';
export { unitTestVerifier } from './verifiers/unit-test';
```

### 3.2 Server API

```typescript
import { createGateway, selfConsistency, privacy } from '@xinity/prism';

const gateway = createGateway({
  upstream: {
    baseUrl: 'http://localhost:11434/v1',
    apiKey: process.env.UPSTREAM_API_KEY,
    timeoutMs: 120_000,
  },
  defaults: {
    techniques: [selfConsistency({ k: 5 })],
    plugins: [privacy()],
  },
  modelProfiles: [
    { match: /deepseek-r1|qwen3.*thinking/i, thinkingMode: true, supportsLogprobs: true },
    { match: /llama-3\.3|qwen3(?!.*thinking)/i, thinkingMode: false, supportsLogprobs: true },
  ],
  logger: console,
});

await gateway.serve({ port: 4000, hostname: '0.0.0.0' });
// Bun.serve under the hood; returns { server, stop() }
```

### 3.3 Programmatic client API

```typescript
import { createClient, selfConsistency, planSearch, privacy } from '@xinity/prism';

const client = createClient({
  upstream: { baseUrl: 'http://localhost:11434/v1' },
});

// Non-streaming
const response = await client.chat.completions.create({
  model: 'deepseek-r1-distill-llama-70b',
  messages: [{ role: 'user', content: 'Why is the sky blue?' }],
  xinity: {
    techniques: [selfConsistency({ k: 5 })],
    plugins: [privacy()],
  },
});

// Streaming
const stream = await client.chat.completions.create({
  model: 'qwen3-32b',
  messages: [...],
  stream: true,
  xinity: { techniques: [roundTrip()] }, // streaming-compatible
});
for await (const chunk of stream) { ... }
```

The shape mirrors the OpenAI SDK deliberately. The `xinity` field is the only extension.

## 4. Directory structure

```
src/
  index.ts                    # Top-level re-exports
  types.ts                    # All shared types and Zod schemas
  server.ts                   # createGateway, HTTP routing
  client.ts                   # createClient, programmatic API
  upstream.ts                 # UpstreamClient (the only fetch-to-model)
  pipeline.ts                 # Compose Transforms + Techniques into a request handler
  config.ts                   # Parse Xinity config from header / body / model-name fallback
  streaming.ts                # SSE parser/encoder, chunk merging helpers
  logging.ts                  # Minimal structured logger interface
  model-profile.ts            # ModelProfile resolution
  techniques/
    self-consistency.ts
    best-of-n.ts
    memory.ts
    plan-search.ts
    round-trip.ts
    deep-conf.ts
  plugins/
    privacy.ts
    read-urls.ts
    json.ts
    execute-code.ts
  verifiers/
    regex.ts
    json-schema.ts
    judge.ts
    unit-test.ts
  internal/
    voting.ts                 # Majority vote, weighted vote (used by SC + DeepConf)
    chunking.ts               # Token-aware chunking (used by Memory)
    diff.ts                   # Semantic equivalence scoring (used by RTO)
tests/
  unit/
    ...                       # Mock UpstreamClient, test each technique
  integration/
    ...                       # Real upstream, env-gated via XINITY_TEST_UPSTREAM
  evals/
    ...                       # Mini benchmarks per technique
examples/
  programmatic.ts
  server.ts
  composition.ts
bin/
  prism.ts                    # CLI entry
package.json
tsconfig.json
bunfig.toml
DESIGN.md
README.md
```

**Hard rules:**
- One barrel export: `src/index.ts`. No other `index.ts` files anywhere in `src/`.
- No `src/utils/` dumping ground. Utilities live in `internal/` with specific filenames.
- Tests mirror source structure.

## 5. Core types

### 5.1 Wire format (OpenAI-compatible)

Defined as Zod schemas in `types.ts`, with `snake_case` field names matching OpenAI exactly. These are validated at the HTTP boundary. Internal code does NOT pass these around — it uses the camelCase normalized form below.

```typescript
const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  n: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),
  response_format: z.object({ type: z.enum(['text', 'json_object', 'json_schema']), /* ... */ }).optional(),
  tools: z.array(ToolSchema).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  seed: z.number().int().optional(),
  // Xinity extension
  xinity: XinityConfigSchema.optional(),
});
```

Response and Chunk schemas similarly mirror OpenAI.

`ChatCompletionRequestSchema` is declared `.passthrough()`. Unknown top-level
fields — `top_k`, `chat_template_kwargs`, `reasoning_effort`, and other
vendor-specific extensions that OpenAI SDKs flatten out of their `extra_body`
parameter — survive validation and land on the internal `ChatRequest` under
`extraBody` (§5.2). On the way out, `toWireRequest` spreads `extraBody` back
into the wire payload before typed fields, so typed fields win on overlap.
This is the gateway's generic forward-compatibility hatch: callers can pass
arbitrary upstream params without a schema change.

### 5.2 Internal normalized format

```typescript
type ChatRequest = {
  model: string;
  messages: Message[];
  temperature?: number;
  topP?: number;
  n?: number;
  stream?: boolean;
  stop?: string[];
  maxTokens?: number;
  logprobs?: boolean;
  topLogprobs?: number;
  responseFormat?: ResponseFormat;
  tools?: Tool[];
  toolChoice?: ToolChoice;
  seed?: number;
  // Non-OpenAI fields (used internally only)
  xinity?: XinityConfig;
  /** Vendor-specific wire fields passed through verbatim — `top_k`,
   *  `chat_template_kwargs`, `reasoning_effort`, etc. Populated by
   *  `fromWireRequest` from any top-level field outside the OpenAI schema,
   *  re-emitted by `toWireRequest` before typed fields. Typed fields win on
   *  overlap; caller-supplied fields win over `ModelProfile.thinkingParams`
   *  output (server.ts merge order). */
  extraBody?: Record<string, unknown>;
};
```

Conversion functions: `toWire(req: ChatRequest): ChatCompletionRequest` and `fromWire(req: ChatCompletionRequest): ChatRequest` live in `types.ts`.

### 5.3 Technique type (the most important type in the codebase)

```typescript
type TechniqueCapabilities = {
  /** Requires logprobs from upstream. Runtime check before applying. */
  requiresLogprobs: boolean;
  /** Can produce a streaming response. If false and client requested stream, we emit progress events + final chunk. */
  supportsStreaming: boolean;
  /** Rough cost class. Used by router/cost-estimator (out of v1 scope, but the field is reserved). */
  addsLatency: 'low' | 'medium' | 'high';
  /** Approximate output-token multiplier vs single call. Used for cost estimation. */
  tokenMultiplier: number;
  /** Whether this technique remains valuable when the upstream model has internal thinking mode. */
  worksWithThinkingMode: boolean;
  /** If true, the runtime will skip this technique when the resolved ModelProfile.thinkingMode === true. */
  subsumedByThinkingMode: boolean;
};

type TechniqueContext = {
  /** Normalized request as received (after Transforms.pre have run). */
  request: ChatRequest;
  /** The upstream client. Use this for every model call. Never `fetch` directly. */
  upstream: UpstreamClient;
  /** The next technique in the chain, or the bare upstream call if this is the innermost. */
  next: (req: ChatRequest) => Promise<ChatResponse>;
  /** Resolved profile for `request.model`. Use to gate behavior on thinking mode etc. */
  modelProfile: ModelProfile;
  /** Cancellation. Every fetch and every loop must respect this. */
  signal: AbortSignal;
  /** Structured logger. */
  logger: Logger;
  /** Emit a progress event to streaming clients. No-op if stream === false. */
  progress: (event: ProgressEvent) => void;
};

type Technique = {
  readonly name: string;
  readonly capabilities: TechniqueCapabilities;
  apply(ctx: TechniqueContext): Promise<ChatResponse>;
};

type ProgressEvent =
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
```

`ProgressEvent` is a closed union. Adding a new event type is a deliberate API
change, not a free-form emission. Techniques compile against the union;
SSE-encoding lives in `streaming.ts`.

The `next` parameter in `TechniqueContext` deviates from the literal closure-
composition style sketched in the project prompt (`selfConsistency(planSearch(rto(baseCall)))`).
Semantics are identical, but passing `next` via context lets a technique invoke
it K times (SC needs this) without K closures or manual recursion. The pipeline
is still built by honest function composition in `pipeline.ts` — see §11.

Techniques are constructed by factory functions that accept config and return `Technique`:

```typescript
function selfConsistency(opts?: { k?: number; voter?: Voter }): Technique;
function bestOfN(opts: { n: number; verifier: Verifier }): Technique;
function memory(opts?: { chunkTokens?: number; overlapTokens?: number; synthesisModel?: string }): Technique;
function planSearch(opts?: { numPlans?: number; samplesPerPlan?: number; verifier?: Verifier }): Technique;
function roundTrip(opts?: { scorer?: EquivalenceScorer }): Technique;
function deepConf(opts?: { mode: 'offline' | 'online'; threshold?: number; budget?: number }): Technique;
```

### 5.4 Transform type (plugins)

```typescript
type TransformState = {
  /** Per-request scratch space, shared between pre and post. */
  store: Map<string, unknown>;
  logger: Logger;
  signal: AbortSignal;
  /** The same UpstreamClient techniques use. Plugins that need a model call
   *  (e.g. `json` reformatting, `judge` verifier inside a Transform) go through
   *  this — never `fetch` directly. */
  upstream: UpstreamClient;
  /** Resolved model profile for the request. */
  modelProfile: ModelProfile;
};

type Transform = {
  readonly name: string;
  pre?(request: ChatRequest, state: TransformState): Promise<ChatRequest>;
  post?(response: ChatResponse, state: TransformState): Promise<ChatResponse>;
  /** Streaming postprocess. Called per chunk. If absent and `post` is defined, streaming is converted to non-streaming. */
  postChunk?(chunk: ChatChunk, state: TransformState): Promise<ChatChunk>;
};
```

### 5.5 UpstreamClient

```typescript
interface UpstreamClient {
  /** Non-streaming call. Always returns a single response. */
  complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  /** Streaming call. Returns an async iterable of chunks. */
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
  /** Optional escape hatch for the transparent pass-through fast path (§11).
   *  Returns the raw upstream Response so the server can pipe its body without
   *  parsing. Never used by techniques. */
  raw(req: ChatRequest, signal: AbortSignal): Promise<Response>;
}
```

Per-response logprobs availability is carried on the response itself, not on the
client — a single client serves N concurrent technique calls (SC, BoN,
PlanSearch all fan out), so a client-scoped "last response had logprobs" flag
would be racy. The signal lives where it can't race:

```typescript
type ChatResponse = {
  id: string;
  choices: Choice[];
  usage?: Usage;
  /** Per-response metadata Xinity attaches at the upstream boundary. Not on the wire. */
  xinityMeta: { hadLogprobs: boolean };
};

type ChatChunk = {
  id: string;
  choices: ChunkChoice[];
  /** Streaming logprobs land here when present; DeepConf-online consumes this. */
  xinityMeta?: { hadLogprobs: boolean };
};
```

`HttpUpstreamClient` populates `xinityMeta.hadLogprobs` from the parsed payload
(`choices[*].logprobs != null`). DeepConf's capability gate now reads
`response.xinityMeta.hadLogprobs` after the first call and aborts the run if
it is false despite `request.logprobs === true`.

Implemented by `HttpUpstreamClient` in `upstream.ts`. Tests use `MockUpstreamClient`.

### 5.6 ModelProfile

```typescript
type ModelProfile = {
  /** Pattern matched against request.model. First match wins. */
  match: RegExp | string;
  /** Model has internal CoT/thinking. Adjusts default k, skips subsumed techniques. */
  thinkingMode: boolean;
  /** Upstream returns logprobs reliably. */
  supportsLogprobs: boolean;
  /** Optional context window (in tokens). Used by Memory to decide when to chunk. */
  contextWindow?: number;
  /** Optional override for default tokenizer (for chunk sizing). Defaults to tiktoken cl100k. */
  tokenizer?: 'cl100k' | 'o200k' | 'llama3';
  /** Translate a per-request `xinity.thinking` toggle into provider-specific
   *  wire fields. `server.ts` merges the return value into `request.extraBody`
   *  before techniques run, and (when `on === true`) flips the request's
   *  effective `thinkingMode` so the pipeline subsumption gate fires. Return
   *  `undefined` when nothing needs to be added. */
  thinkingParams?: (on: boolean) => Record<string, unknown> | undefined;
  /** Whether `xinity.thinking` may be toggled per-request. Set to `false` for
   *  models whose thinking behavior is hard-coded by training and cannot be
   *  disabled. When `thinkingParams` is absent or this flag is `false`, a
   *  request carrying `xinity.thinking` is rejected with 400
   *  `thinking_not_supported` — see §16.5. */
  thinkingModeToggleable?: boolean;
};
```

Resolution happens once per request in `model-profile.ts` and is passed via `TechniqueContext.modelProfile`.

`thinkingMode` on the profile is the **default** for matched models. When a
request sets `xinity.thinking`, `server.ts` shallow-clones the resolved profile
with `thinkingMode = staged.thinking` for the lifetime of that request — the
subsumption check at `pipeline.ts:96` and `selfConsistency`'s K-default at
`techniques/self-consistency.ts:28` see the per-request value. The clone is
local to the request; the registered profile is never mutated.

### 5.7 Verifier and EquivalenceScorer

```typescript
type Verifier = {
  readonly name: string;
  /** Score a candidate response. Higher is better. Implementations may call models, run tests, etc. */
  score(candidate: ChatResponse, request: ChatRequest, signal: AbortSignal): Promise<number>;
};

type EquivalenceScorer = {
  readonly name: string;
  /** Score equivalence between two strings. 0..1. Used by RTO. */
  score(a: string, b: string, signal: AbortSignal): Promise<number>;
};

type Voter = {
  readonly name: string;
  /** Pick a winner from N candidate responses. */
  vote(candidates: ChatResponse[]): ChatResponse;
};
```

## 6. Streaming behavior

The single most error-prone area. Documented per technique up front so Claude Code does not have to guess.

| Technique | `supportsStreaming` | Behavior when `stream: true` |
|---|---|---|
| Self-Consistency | false | Run K samples in parallel (non-streaming). Emit `xinity.sample.complete` SSE events as each finishes. Emit final voted answer as a single `delta` chunk + `[DONE]`. |
| Best-of-N | false | Same as SC. Additionally emit `xinity.score` events with verifier results. |
| Plan-Search | false | Emit `xinity.plan.generated` per plan, then sample-complete events, then final. |
| Memory | partial | Chunk processing is non-streaming. Final synthesis pass IS streamed transparently. Emit `xinity.chunk.processed` per chunk for progress. |
| RTO | true | Forward pass can stream. Round-trip verification happens after; if it fails the threshold, we cannot un-stream. v1 behavior: emit a warning event and trust the forward pass. Document this limitation. |
| DeepConf offline | false | Identical to Self-Consistency. |
| DeepConf online | true | Stream the chosen trace. Concurrently sample backup traces non-streaming; if confidence drops below threshold mid-stream, switch to a higher-confidence backup. (v1: implement the simpler variant — single trace with early termination if confidence drops; full multi-trace online is v1.1.) |

Progress events use a custom SSE event type so OpenAI SDK clients that ignore unknown events are unaffected:

```
event: xinity.sample.complete
data: {"index": 2, "of": 5, "tokens": 487}

event: xinity.voting
data: {"distribution": {"42": 3, "43": 2}, "winner": "42"}

data: {"id":"...","choices":[{"delta":{"content":"The answer is 42."},"index":0}]}

data: [DONE]
```

## 7. Configuration parsing

Three sources, merged with this precedence (highest first):

1. **HTTP headers** — readable, `curl`-friendly, fits any client:
   - `X-Xinity-Techniques: self-consistency:k=5,round-trip` — comma-separated list. Each entry is `name` or `name:k1=v1;k2=v2` (semicolon-separated key=value options). Values parse as JSON literals (`5`, `"foo"`, `true`); bare strings are accepted for ergonomics.
   - `X-Xinity-Plugins: privacy,read-urls`
   - `X-Xinity-Disabled: <name>,<name>` — server-default opt-outs
   - `X-Xinity-Model-Profile: <name>` — override profile resolution
   - `X-Xinity-Auto: plugins|none` — opt into the rules router for this request
   - `X-Xinity-Thinking: true|false` — same effect as `xinity.thinking` in the body (§16.5). Strict, case-sensitive; `1`, `0`, `True`, `yes` etc. produce a 400 `invalid_xinity_header` rather than silent coercion.
   Escape hatch: `X-Xinity-Config: <base64 JSON>` is accepted for cases the mini-grammar can't express (deeply nested options). If both forms are present on the same request, the base64 form wins.
2. **Body field** `xinity: {...}` — most ergonomic for SDK users
3. **Model-name suffix** `model: "deepseek-r1@self-consistency:k=5"` — compat with OpenAI-SDK clients that can't add fields or headers
4. **Server defaults** — set in `createGateway({ defaults })`

The merged config schema:

```typescript
const XinityConfigSchema = z.object({
  techniques: z.array(z.union([
    z.string(),                                          // "self-consistency"
    z.object({ name: z.string(), options: z.unknown() }) // { name: "self-consistency", options: { k: 5 } }
  ])).optional(),
  plugins: z.array(z.union([z.string(), z.object({ name: z.string(), options: z.unknown() })])).optional(),
  modelProfile: z.string().optional(),                   // override profile resolution by name
  disabled: z.array(z.string()).optional(),              // server defaults to disable for this request
  auto: z.enum(['plugins', 'none']).optional(),          // rules-router opt-in
  thinking: z.boolean().optional(),                      // see §16.5
}).strict();
```

`auto`, `thinking`, `modelProfile`, and `disabled` use the same last-wins
layering across all four sources (defaults < model-suffix < body < headers).
`techniques` and `plugins` don't cross layers — a request layer that sets
either field overrides the merged set wholesale.

Outside of `xinity`, any non-OpenAI top-level field on the request body is
captured into `ChatRequest.extraBody` by `fromWireRequest` (§5.1) and forwarded
to the upstream verbatim. This is the path OpenAI SDK callers use when they
pass `extra_body={...}`: the SDK flattens it into top-level JSON fields, the
gateway captures, and the upstream sees them.

When `techniques` is specified as bare strings, they're resolved against the techniques registered in `createGateway({ techniques })` map; this is the only "registry" in the system, and it's per-gateway-instance, not global.

**Scope of server defaults.** The gateway exposes a single route (`POST /v1/chat/completions`) in v1, so server defaults are a single `defaults: { techniques, plugins }` object on `GatewayConfig`. Per-route defaults are out of v1 scope; if/when a second route is added (e.g. `/v1/completions` for legacy text completions) the config will grow to `{ defaults, routes?: Record<string, RouteDefaults> }` at that point — not before.

Programmatic client usage skips parsing entirely — users pass Technique instances directly via `xinity.techniques`.

## 8. Worked example: end-to-end trace

**Request:**
```http
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "qwen3-32b-thinking",
  "messages": [
    { "role": "user", "content": "Summarize the document at https://example.com/report.pdf in 3 bullet points." }
  ],
  "stream": false,
  "xinity": {
    "techniques": [{ "name": "self-consistency", "options": { "k": 3 } }, { "name": "round-trip" }],
    "plugins": ["privacy", "read-urls"]
  }
}
```

**Server flow:**

1. **`server.ts`** receives the request. Bun.serve handler.
2. **Validation** via Zod (`ChatCompletionRequestSchema`).
3. **`fromWire()`** converts to `ChatRequest`.
4. **`config.ts`** merges body `xinity` config with server defaults. Resolves technique/plugin names to instances.
5. **`model-profile.ts`** matches `qwen3-32b-thinking` against registered profiles → `{ thinkingMode: true, supportsLogprobs: true, contextWindow: 32000 }`.
6. **Subsumption check:** for each requested technique, check `technique.capabilities.subsumedByThinkingMode && modelProfile.thinkingMode`. Neither SC nor RTO is subsumed (SC is orthogonal to thinking; RTO is verification). Both pass. Logger emits: `info: thinking mode detected, default k for SC would be 3 (already specified)`.
7. **Capability check:** does any technique require logprobs that aren't available? No. Does any technique break streaming when stream=true? Stream is false here. Pass.
8. **`pipeline.ts`** builds the composed request handler:
   - Pre-transforms applied to request in registration order: `privacy.pre` → `readUrls.pre`
   - `privacy.pre` scans message content with a PII regex/NER pass, replaces detected PII with placeholders `[XINITY_PII_001]`, stores mapping in `state.store`.
   - `readUrls.pre` extracts URLs (now `https://example.com/report.pdf` survived privacy since it's not PII), fetches each via native `fetch` with a size limit, extracts text (PDF goes through a minimal extractor; v1 supports HTML and PDF), injects as `system` message before the user message.
   - Technique chain composed: `selfConsistency.apply(ctx where next = roundTrip.apply(ctx where next = upstream.complete))`
9. **Execution:**
   - SC enters `apply`. It calls `ctx.next` K=3 times in parallel with temperature 0.7 (overriding the request).
   - Each `next` call enters RTO. RTO calls `ctx.next` once for the forward pass. Then calls `ctx.upstream.complete` with a reverse prompt ("given this output, what was the input?"). Scores equivalence via the default scorer (model-as-judge against the upstream model itself). If score >= threshold, return the forward response; if below threshold, retry up to maxRetries=1.
   - 3 candidate responses bubble back up to SC.
   - SC's `Voter` (default: extract final-line answer, normalize whitespace, majority vote on hash) picks a winner.
10. **Post-transforms applied in reverse order:** `readUrls.post` (no-op) → `privacy.post` un-redacts PII in the response content using the stored mapping.
11. **`toWire()`** converts back to OpenAI format.
12. **Response sent.**

**What gets logged (structured JSON):**
```
{ level: "info", event: "request.received", model: "qwen3-32b-thinking", techniques: ["self-consistency", "round-trip"], plugins: ["privacy", "read-urls"] }
{ level: "info", event: "model.profile.resolved", thinkingMode: true }
{ level: "info", event: "transform.pre", name: "privacy", piiCount: 0 }
{ level: "info", event: "transform.pre", name: "read-urls", urlsFetched: 1, totalBytes: 184302 }
{ level: "info", event: "technique.enter", name: "self-consistency", k: 3 }
{ level: "info", event: "technique.enter", name: "round-trip", iteration: 0 }
{ level: "info", event: "upstream.call", durationMs: 4218, inputTokens: 1842, outputTokens: 487 }
{ level: "info", event: "round-trip.score", score: 0.91, threshold: 0.8 }
... (×3 in parallel)
{ level: "info", event: "self-consistency.vote", distribution: { "hash_a": 2, "hash_b": 1 }, winner: "hash_a" }
{ level: "info", event: "transform.post", name: "privacy", restoredCount: 0 }
{ level: "info", event: "response.sent", durationMs: 13402, totalUpstreamCalls: 9 }
```

## 9. Per-technique sketches

These are the algorithmic specs Claude Code uses to implement each technique. Full implementations live in `src/techniques/`.

### 9.1 Self-Consistency

```
function selfConsistency({ k = 5, voter = defaultVoter() }): Technique {
  capabilities: { requiresLogprobs: false, supportsStreaming: false, addsLatency: 'medium',
                  tokenMultiplier: k, worksWithThinkingMode: true, subsumedByThinkingMode: false }
  apply(ctx):
    // Self-Consistency owns the sampling strategy. We override `n` to 1 and issue
    // K independent calls, then vote. Rationale: native `n` is single-prompt
    // multi-sampling on the same trajectory; SC wants K independent trajectories
    // with elevated temperature. A future optimization could issue ceil(K/n) calls
    // with n=min(K, server-cap) on backends that support it cheaply, but the
    // saving is backend-specific and not worth the complexity in v1.
    sampledReq = { ...ctx.request, temperature: ctx.request.temperature ?? 0.7, n: 1 }
    if (ctx.request.n && ctx.request.n > 1) {
      ctx.logger.warn({ event: 'self-consistency.n-overridden', requested: ctx.request.n, k })
    }
    promises = []
    for i in 0..k-1:
      promises.push(ctx.next(sampledReq).then(r => { ctx.progress({ event: 'xinity.sample.complete', index: i, of: k }); return r }))
    candidates = await Promise.all(promises)
    winner = voter.vote(candidates)
    ctx.progress({ event: 'xinity.voting', distribution: voter.distribution })
    return winner
}
```

Default voter: extract final answer block (last code/math/JSON block, or last sentence), normalize, hash, count, return original response of most-common hash.

Adjustment for thinking mode: if `modelProfile.thinkingMode === true` and user didn't specify k, use k=3 instead of 5.

### 9.2 Best-of-N + Verifier

```
function bestOfN({ n, verifier }): Technique {
  capabilities: { requiresLogprobs: false, supportsStreaming: false, addsLatency: 'high',
                  tokenMultiplier: n, worksWithThinkingMode: true, subsumedByThinkingMode: false }
  apply(ctx):
    candidates = await Promise.all([0..n-1].map(() => ctx.next({ ...ctx.request, temperature: 0.7 })))
    scored = await Promise.all(candidates.map(async c => ({ c, score: await verifier.score(c, ctx.request, ctx.signal) })))
    scored.sort((a, b) => b.score - a.score)
    ctx.progress({ event: 'xinity.scores', scores: scored.map(s => s.score) })
    return scored[0].c
}
```

Built-in verifiers in `src/verifiers/index.ts`:
- `regexVerifier(pattern, score?)` — score 1 if match, else 0 (or custom).
- `jsonSchemaVerifier(schema)` — uses Zod to validate JSON in the response; score = (valid ? 1 : 0).
- `judgeVerifier({ model, prompt })` — model-as-judge. Calls a (possibly different) upstream with a scoring prompt. Returns parsed number in [0, 1].
- `unitTestVerifier({ language, tests })` — runs language-specific code in a sandbox (v1: stub that integrates with `executeCode` plugin).

### 9.3 Memory (Writing in the Margins)

```
function memory({ chunkTokens = 4000, overlapTokens = 200, synthesisModel? }): Technique {
  capabilities: { requiresLogprobs: false, supportsStreaming: true, addsLatency: 'medium',
                  tokenMultiplier: ~2, worksWithThinkingMode: true, subsumedByThinkingMode: false }
  apply(ctx):
    // Find the document. Heuristic v1: longest content block in messages, OR a message with role 'system' tagged via metadata.
    doc = extractDocument(ctx.request.messages)
    if (tokensOf(doc) <= ctx.modelProfile.contextWindow * 0.7) return ctx.next(ctx.request) // no need
    chunks = chunkByTokens(doc, chunkTokens, overlapTokens)
    margins = []
    for (chunk of chunks):
      noteReq = buildMarginPrompt(chunk, ctx.request.messages[last_user])
      note = await ctx.upstream.complete(noteReq, ctx.signal)
      margins.push(note.choices[0].message.content)
      ctx.progress({ event: 'xinity.chunk.processed', index: margins.length, of: chunks.length })
    synthReq = buildSynthesisPrompt(margins, ctx.request)
    // Final pass can stream — pass through transparently
    if (ctx.request.stream) return streamSynthesis(synthReq) else return ctx.next(synthReq)
}
```

Chunking uses a tokenizer-aware splitter (`internal/chunking.ts`). Default tokenizer is cl100k via a lightweight library or hand-rolled approximate counter for v1 (be honest in code comments).

### 9.4 PlanSearch

```
function planSearch({ numPlans = 5, samplesPerPlan = 1, verifier? }): Technique {
  capabilities: { requiresLogprobs: false, supportsStreaming: false, addsLatency: 'high',
                  tokenMultiplier: numPlans * samplesPerPlan + 1, worksWithThinkingMode: true, subsumedByThinkingMode: false }
  apply(ctx):
    // Stage 1: generate observations (5-10 short bullet points about the problem)
    obs = await generateObservations(ctx.upstream, ctx.request, ctx.signal)
    // Stage 2: generate diverse plans by sampling subsets of observations
    plans = await generatePlans(ctx.upstream, ctx.request, obs, numPlans, ctx.signal)
    // Stage 3: for each plan, sample a completion
    completions = await Promise.all(
      plans.flatMap(plan => range(samplesPerPlan).map(() => sampleWithPlan(ctx.next, ctx.request, plan)))
    )
    // Stage 4: select. If verifier provided, BoN-style. Otherwise SC-style majority on extracted answer.
    if (verifier) return await bestByVerifier(completions, verifier, ctx)
    else return defaultVoter().vote(completions)
}
```

Prompts for observations and plans live in `src/techniques/plan-search.prompts.ts` (separated for easy iteration).

### 9.5 Round-Trip Optimization

```
function roundTrip({ scorer = modelJudgeScorer(), threshold = 0.8, maxRetries = 1 }): Technique {
  capabilities: { requiresLogprobs: false, supportsStreaming: true, addsLatency: 'medium',
                  tokenMultiplier: 2, worksWithThinkingMode: true, subsumedByThinkingMode: false }
  apply(ctx):
    for (attempt of 0..maxRetries):
      forward = await ctx.next(ctx.request)
      reverseReq = buildReversePrompt(ctx.request, forward)
      reverse = await ctx.upstream.complete(reverseReq, ctx.signal)
      score = await scorer.score(extractInput(ctx.request), reverse.choices[0].message.content, ctx.signal)
      ctx.progress({ event: 'xinity.round-trip.score', score, threshold, attempt })
      if (score >= threshold) return forward
    return forward // best-effort on last attempt
}
```

For streaming requests, v1 forwards the stream and emits the round-trip score as a trailing event without blocking the stream. Documented as a known limitation.

### 9.6 DeepConf

```
function deepConf({ mode, threshold = 0.5, budget = 16, voter? = confidenceWeightedVoter() }): Technique {
  capabilities: { requiresLogprobs: true,
                  supportsStreaming: mode === 'online',
                  addsLatency: mode === 'online' ? 'low' : 'high',
                  tokenMultiplier: mode === 'offline' ? budget : 1,
                  worksWithThinkingMode: true, subsumedByThinkingMode: false }
  apply(ctx):
    if (!ctx.modelProfile.supportsLogprobs) throw new Error('DeepConf requires upstream logprobs')
    if (mode === 'offline'):
      // Sample `budget` traces with logprobs, score each via sliding-window confidence, weighted vote
      reqWithLP = { ...ctx.request, logprobs: true, topLogprobs: 5, n: undefined }
      candidates = await Promise.all(range(budget).map(() => ctx.next({ ...reqWithLP, temperature: 0.7 })))
      scored = candidates.map(c => ({ c, conf: bottomDecileGroupConfidence(c) }))
      // Keep top η% by confidence (η defaults to 50%)
      kept = scored.sort((a,b) => b.conf - a.conf).slice(0, Math.ceil(budget * 0.5))
      return voter.vote(kept.map(s => s.c)) // confidence-weighted
    else:
      // Online: stream a single trace, monitor confidence per sliding window, abort if drops below threshold
      // v1: simple variant — single trace + early termination signal. Backup traces are v1.1.
      stream = ctx.upstream.stream({ ...ctx.request, logprobs: true, topLogprobs: 5 }, ctx.signal)
      return monitorAndForward(stream, threshold, ctx)
}
```

`internal/confidence.ts` implements:
- `tokenConfidence(logprobs)` — mean negative log of top-k as in the paper.
- `slidingWindowConfidence(tokens, windowSize=2048)` — group confidence within a window.
- `bottomDecileGroupConfidence(response)` — the worst 10% of windows; this is the trace-level score per the paper.

## 10. Plugin sketches

### 10.1 privacy

```
function privacy({ detector = defaultPiiDetector() }): Transform {
  pre(req, state):
    mapping = new Map() // placeholder -> original
    counter = 0
    newMessages = req.messages.map(m => ({ ...m, content: replacePii(m.content, detector, mapping, () => `[XINITY_PII_${++counter}]`) }))
    state.store.set('privacy.mapping', mapping)
    return { ...req, messages: newMessages }
  post(resp, state):
    const mapping = state.store.get('privacy.mapping') as Map<string,string>
    return restoreContent(resp, mapping)
  postChunk(chunk, state):
    // Restore PII in streaming chunks — naive replacement is fine since placeholders are unique tokens
    return restoreChunk(chunk, state.store.get('privacy.mapping'))
}
```

Default detector: a regex set for emails, phone numbers (E.164 + common national formats), IBANs, credit card numbers (Luhn-verified), Austrian SVN, German Steuer-ID. Document the detector's limitations honestly; this is a defense-in-depth layer, not a compliance certification.

### 10.2 readUrls

```
function readUrls({ maxBytes = 1_000_000, maxUrls = 5, fetchTimeout = 10_000 }): Transform {
  pre(req, state):
    urls = extractUrls(req.messages)
    if (urls.length === 0) return req
    fetched = await Promise.all(urls.slice(0, maxUrls).map(u => fetchAndExtract(u, maxBytes, fetchTimeout, state.signal)))
    contextMessage = { role: 'system', content: formatFetchedContent(fetched) }
    return { ...req, messages: [contextMessage, ...req.messages] }
}
```

Content extraction: v1 supports `text/html` (strip tags, preserve text), `application/pdf` (use a minimal extractor; if heavy, defer to v1.1), `text/plain`, `application/json`, `text/markdown`. Refuse other MIME types.

### 10.3 json (two-pass structured output)

```
function json({ schema, retries = 1 }): Transform {
  // No pre. Only post.
  post(resp, state):
    candidate = resp.choices[0].message.content
    try:
      parsed = schema.parse(JSON.parse(extractJsonBlock(candidate)))
      return resp // already valid
    catch:
      // Reformatting pass: ask the upstream to convert prose to schema-conforming JSON
      reformatted = await reformatToSchema(state.upstream, candidate, schema, state.signal)
      return { ...resp, choices: [{ ...resp.choices[0], message: { ...resp.choices[0].message, content: reformatted } }] }
}
```

`reformatToSchema` calls `state.upstream.complete` with a fixed prompt. To do this, `TransformState` carries `upstream` and `signal` (added to the type).

`json` cannot post-process streaming responses meaningfully (would need to buffer and re-stream). v1: when active, force `stream: false` server-side and document this.

### 10.4 executeCode (v1 stub)

```
function executeCode({ languages = ['python', 'javascript'], timeoutMs = 5000 }): Transform {
  pre(req, state):
    // Register code-execution as a tool the model can call.
    // Actual sandbox impl is a v1 stub: log a warning, return mock results.
    return { ...req, tools: [...(req.tools ?? []), executeCodeToolSpec(languages)] }
  post:
    // Detect tool_calls to execute-code, run them through the sandbox stub, inject results.
    // v1 ships with a Docker-based sandbox runner spec but the runner itself is a separate package (out of v1 scope).
}
```

Documented honestly: this plugin is a scaffold in v1. Real sandbox integration is v1.1.

## 11. Pipeline composition

```typescript
// src/pipeline.ts
export function buildPipeline(
  techniques: Technique[],
  transforms: Transform[],
  upstream: UpstreamClient,
  modelProfile: ModelProfile,
  logger: Logger,
): RequestHandler {
  return async (req: ChatRequest, signal: AbortSignal): Promise<ChatResponse | AsyncIterable<ChatChunk>> => {
    const state: TransformState = { store: new Map(), logger, signal };
    // Capability gate
    for (const t of techniques) {
      if (t.capabilities.requiresLogprobs && !modelProfile.supportsLogprobs) {
        throw new GatewayError(400, `Technique ${t.name} requires logprobs, but model ${req.model} does not support them.`);
      }
      if (t.capabilities.subsumedByThinkingMode && modelProfile.thinkingMode) {
        logger.info({ event: 'technique.skipped.subsumed', name: t.name });
        continue;
      }
    }
    // Pre-transforms
    let transformed = req;
    for (const tr of transforms) {
      if (tr.pre) transformed = await tr.pre(transformed, state);
    }
    // Compose techniques: inner-most calls upstream, outer wraps inner
    const base = (r: ChatRequest) => upstream.complete(r, signal);
    const chain = techniques.reduceRight<(r: ChatRequest) => Promise<ChatResponse>>(
      (next, technique) => (r) => technique.apply({
        request: r, upstream, next, modelProfile, signal, logger, progress: noopProgress(state),
      }),
      base,
    );
    let response = await chain(transformed);
    // Post-transforms (reverse order)
    for (let i = transforms.length - 1; i >= 0; i--) {
      const tr = transforms[i];
      if (tr?.post) response = await tr.post(response, state);
    }
    return response;
  };
}
```

Streaming variant of `buildPipeline` is similar but the innermost `base` returns `AsyncIterable<ChatChunk>` and the technique chain is only built if all techniques have `supportsStreaming: true`; otherwise fall back to non-streaming + emit progress events + emit final response as a single chunk.

### 11.1 Transparent pass-through fast path

When `techniques.length === 0 && transforms.length === 0`, the server skips
`fromWire`, `buildPipeline`, and `toWire` entirely and pipes the upstream
`Response` body straight through:

```typescript
// server.ts request handler (sketch)
if (resolved.techniques.length === 0 && resolved.transforms.length === 0) {
  const raw = await upstream.raw(req, signal);
  // Headers: forward content-type (application/json or text/event-stream),
  // strip hop-by-hop headers, preserve status code.
  return new Response(raw.body, {
    status: raw.status,
    headers: forwardHeaders(raw.headers),
  });
}
```

This guarantees success criterion #3 (byte-for-byte equivalent to the upstream,
streaming included). The integration test suite includes a `pass-through.diff.test.ts`
that issues the same request twice — once direct to the upstream, once via the
gateway — and asserts byte-equality of both the response body and SSE stream.

## 12. Error handling

A single `GatewayError` class with `statusCode` and `code` fields. Conversion to OpenAI-format error responses happens at the HTTP edge only.

Upstream errors bubble up unchanged (status code preserved, body wrapped in `{ error: { ... } }` if needed).

`AbortSignal` triggers immediate cleanup: all in-flight upstream calls are aborted, pipeline returns 499 (Client Closed Request).

## 13. Logging

Minimal interface:

```typescript
interface Logger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
  error(event: Record<string, unknown> | Error): void;
  child(context: Record<string, unknown>): Logger;
}
```

Default impl writes JSON-per-line to stderr via `Bun.write(Bun.stderr, ...)`. Compatible with structured log collectors (the existing Xinity stack already expects JSON logs).

A `requestId` is generated per request (UUID v7 if Bun supports natively, else v4) and propagated through `logger.child({ requestId })`.

## 14. Testing strategy

### 14.1 Unit (per file)
- `MockUpstreamClient` is the only mock. It accepts a script of `(request) => response` and replays it.
- Each technique has unit tests asserting the *call pattern* (e.g., SC calls upstream K times in parallel with elevated temperature), not the *accuracy*.
- Each plugin has unit tests asserting the I/O transformation.
- The pipeline has tests for composition order, capability gating, and abort propagation.

### 14.2 Integration (gated by `XINITY_TEST_UPSTREAM` env var)
- Skipped with a clear message if env var unset.
- Each technique has one happy-path integration test against the configured upstream.
- The HTTP server has end-to-end tests using `fetch` against a live `Bun.serve`.

### 14.3 Evals (gated by both `XINITY_TEST_UPSTREAM` and `XINITY_RUN_EVALS=1`)
- 5-10 prompts per technique chosen from public benchmarks where the technique is supposed to help:
  - SC and PlanSearch: a subset of GSM8K problems.
  - PlanSearch: 5 HumanEval-style problems.
  - Memory: 3 long-document QA pairs.
  - RTO: 5 translation pairs.
  - DeepConf: 5 AIME-style problems (if a reasoning model is available).
- Each eval reports baseline (technique disabled) vs treatment (technique enabled). No accuracy claims are made if the eval set is too small for significance — the script prints "n=5, treat as anecdotal" instead.

## 15. Out of scope for v1

- Routing / classifier-based technique selection
- MoA, MCTS, rStar, CoT-Decoding, Entropy decoding, CePO, AutoThink
- Authentication, rate limiting, quota management
- Observability backends (Prometheus, OpenTelemetry) — only stderr JSON logs
- A web UI / dashboard
- Persistence (no DB needed in v1)
- Multi-tenancy
- WebSocket transport
- The full `executeCode` sandbox (stub only)
- Real-time online DeepConf with multi-trace switching (only single-trace + early termination in v1)

## 16. Resolved decisions

1. **Bun-only for v1.** No Node compat. Target users run vLLM/Ollama in Linux containers where Bun installs cleanly. Revisit only if a paying customer asks.
2. **No tokenizer dependency.** Memory chunking uses `text.length / 4` as an approximate token count — accurate enough for sizing chunks within a 70%-of-context budget. DeepConf consumes the upstream's own `logprobs` array (token-aligned by construction) and never needs a tokenizer. Config accepts an optional `tokenizer: (text: string) => number` injection point for users who want precision; default stays approximate.
3. **Streaming conflict → quiet degrade.** When `stream: true` and any active technique has `supportsStreaming: false`, the gateway runs non-streaming, emits `xinity.*` progress events as SSE, then emits the final response as a single delta chunk + `[DONE]`. No strict mode in v1.
4. **DeepConf upstream constraint.** Documented in the README. The capability gate (`requiresLogprobs && !modelProfile.supportsLogprobs → 400`) enforces it at request time; no further server-side handling needed.

5. **Thinking mode: two surfaces, profile-translated, request-dynamic gate.**
   Reasoning-server vendors disagree on the wire convention for thinking
   (`chat_template_kwargs.enable_thinking` for Qwen3/vLLM, `reasoning_effort`
   for gpt-5, a `thinking` block for Anthropic-compatible proxies). The
   gateway exposes:

   - **A typed flag:** `xinity.thinking: boolean` in the body, or
     `X-Xinity-Thinking: true|false|1|0` as a header. Layered across all four
     config sources like `auto`/`modelProfile`/`disabled` (defaults <
     model-suffix < body < headers, last-wins).
   - **A profile-side translator:** `ModelProfile.thinkingParams?: (on) =>
     Record<string, unknown> | undefined` (§5.6). The server invokes it once
     per request when `staged.thinking` is set, and merges the return value
     into `request.extraBody` with **request-supplied fields winning over
     profile output on overlap** — so a caller can override the profile's
     translation for a single request without changing server config.
   - **A request-dynamic pipeline gate:** when `staged.thinking === true`,
     the resolved profile is shallow-cloned with `thinkingMode: true` before
     the pipeline runs. This makes `pipeline.ts`'s `subsumedByThinkingMode`
     skip and `selfConsistency`'s K-default reactive to per-request toggles,
     not just static profile config.

   **Effective-profile pattern (non-obvious, do not skip).** The registered
   profile in `GatewayConfig.modelProfiles` is shared across all in-flight
   requests. Per-request overrides — the `thinkingMode` flip above, and any
   future request-scoped profile mutation — **must** be expressed as a
   shallow-cloned local copy (`modelProfile = { ...modelProfile, ... }`),
   not by mutating the registered object. Mutating the shared profile would
   race across concurrent requests (request A's `xinity.thinking: false`
   would leak into the in-flight request B that runs against the same
   profile). All current call sites do this; new contributors adding
   request-level profile derivations should follow the same pattern.

   **Capability enforcement is loud, not silent.** A request that sets
   `xinity.thinking` against a profile that cannot honor it — either because
   `thinkingParams` is undefined, or because the profile explicitly sets
   `thinkingModeToggleable: false` — is rejected with a 400
   `thinking_not_supported` error naming the profile and the missing
   capability. The failure-mode this guards is silent corruption in
   ablation studies: without the check, a profile lacking `thinkingParams`
   accepting `xinity.thinking: false` would flip the pipeline gate (subsumed
   techniques skipped, K dropped) while the upstream still produces
   thinking-on completions, because nothing in the wire payload told it
   otherwise. Loud failure is mandatory; silent fallback would invalidate
   benchmarks built on the assumption that thinking is controllable.

   **Strict boolean parsing.** Both surfaces accept booleans only.
   `xinity.thinking` in the body is `z.boolean()` — strings, numbers, and
   other coercion attempts are rejected at Zod validation. The
   `X-Xinity-Thinking` header accepts only `'true'` and `'false'`
   (case-sensitive); `1`, `0`, `True`, `yes` etc. produce a 400
   `invalid_xinity_header`. Strict over forgiving because different HTTP
   clients use different conventions and silent coercion produces hard-to-
   debug behavior asymmetric between header and body.

   The first-class flag isn't a replacement for the generic passthrough — both
   ship. Callers who want full control or whose vendor isn't covered by any
   profile use `extra_body` directly; callers who want to abstract over
   vendors set `xinity.thinking` and configure profiles once. Order of
   operations in `server.ts`: resolve staged config → `fromWireRequest`
   (captures wire passthrough into `extraBody`) → resolve profile → if
   `staged.thinking` set, run the capability check, then merge
   `profile.thinkingParams(on)` under `request.extraBody` (caller-supplied
   `extraBody` fields win on overlap) and shallow-clone the profile with
   `thinkingMode = true`. Fast-path passthrough preserves all of this
   because `upstream.raw` re-serializes via `toWireRequest`.

End of design.
