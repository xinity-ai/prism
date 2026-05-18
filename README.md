<p align="center">
  <img src="docs/assets/prism-logo.png" alt="Prism" width="320" />
</p>

<h3 align="center">Sharpen any LLM, without changing it.</h3>

<p align="center">
  The open-source npm inference gateway that adds intelligence and safety to any OpenAI-compatible endpoint.
</p>

<p align="center">
  <strong><code>@xinity/prism</code> >> inspired by <a href="https://github.com/codelion/optillm"><code>codelion/optillm</code></a></strong>
</p>

---

An OpenAI-compatible optimizing inference proxy for self-hosted reasoning models. Sits between your applications and a Xinity / vLLM / Ollama / SGLang / llama.cpp endpoint, applies inference-time techniques (self-consistency, plan-search, round-trip, best-of-n, memory, deep-conf), and exposes the same `/v1/chat/completions` surface your existing OpenAI SDK clients already speak.

The name fits the job: a prism splits a single ray into its component spectrum. Prism splits a single user query into K parallel samples, diverse plans, or confidence-ranked traces, then recombines them into one answer that is better than the original ray.

```
clients (OpenAI SDK) ─► prism ─► Xinity / vLLM / Ollama / SGLang
                          │
                          ├── self-consistency
                          ├── plan-search
                          ├── memory (writing-in-the-margins)
                          ├── best-of-n + verifier
                          ├── round-trip
                          ├── deep-conf (logprobs)
                          └── plugins: privacy, read-urls, json
```

## Why this exists

**Closed LLM APIs are black boxes you cannot audit.** Frontier providers can run any inference-time strategy they want behind their `/v1/chat/completions` endpoint: route your query to a smaller distilled variant, rewrite your prompt before it reaches the model, apply self-consistency at K=8 for some queries and K=1 for others, swap in a reasoning-tuned model on hard prompts. You see only the output. There is no API surface that tells you *which* model answered, *which* sampling strategy was applied, or *which* system prompt was injected on top of yours. This is not a flaw in the products, it is the product. The provider's freedom to route invisibly is the source of the perceived quality.

**Open-weight models give you the weights but not the recipe.** When you deploy Llama, Qwen, DeepSeek, or GPT-OSS on your own infrastructure, you get full control over the model, and zero of the inference-time machinery that makes the closed APIs feel sharper than the underlying weights would suggest. Self-consistency, best-of-n verification, plan-level search, confidence-based trace pruning: all of this is *outside* the model. It is the routing and sampling layer.

**Prism is that layer, open and inspectable.** Same `/v1/chat/completions` surface, same OpenAI SDK clients, same streaming. Every technique is auditable code in this repository. Every per-request decision is in your structured logs. When no technique is active, it is byte-for-byte transparent: same status codes, same chunks, same tool-call shape. You can run a closed-API-grade inference stack on your own hardware, and you can see exactly what it is doing.

## Why only six techniques

The reference Python project, [`codelion/optillm`](https://github.com/codelion/optillm), ships roughly twenty techniques. Prism ships six. The cut is deliberate, and it tracks the most important shift in the field since 2024: **reasoning-tuned models have absorbed half of the inference-time technique catalogue into their training**.

Models like DeepSeek-R1, Qwen3-Thinking, GPT-OSS-120B, and o-series equivalents are trained with reinforcement learning to do chain-of-thought, self-reflection, and adaptive depth-of-thinking *inside the forward pass*. Techniques that exist to coax those behaviors out of non-reasoning models from the outside, CoT-Decoding, Re-Reading, explicit CoT-Reflection wrappers, AutoThink-style budget steering, rStar's MCTS-for-small-models, are largely obsolete on a reasoning-tuned backend. They were valuable in 2023. They are redundant in 2026.

Techniques that operate on dimensions thinking-mode cannot replicate, however, are *more* valuable on reasoning models, not less:

| Dimension | Why thinking-mode can't replace it | Prism technique |
|---|---|---|
| Breadth across independent traces | One thinking trace is one sample. Multiple traces filter idiosyncratic errors. | Self-Consistency |
| External verification | The model cannot grade itself against ground truth (tests, schemas, judges). | Best-of-N |
| Context beyond the window | Thinking happens *inside* the context. A 500K-token document doesn't fit. | Memory |
| Plan-level diversity | Thinking explores within a frame; PlanSearch varies the frame. | PlanSearch |
| Round-trip verification | The model can be confidently wrong in ways only composition catches. | RTO |
| Per-token confidence pruning | DeepConf reads logprobs *from* the thinking trace, it gets better the more the model thinks. | DeepConf |
| I/O transformation | PII anonymization, URL fetching, schema enforcement live outside reasoning. | Privacy, ReadURLs, JSON |

Everything Prism ships is in the "complementary to thinking" column. Everything it omits is either subsumed by thinking-mode training (CoT-Decoding, Re-Reading, AutoThink, rStar), incompatible with a proxy abstraction (raw-logits techniques that cannot work over arbitrary OpenAI-compatible endpoints), or has been independently shown to underperform a simpler variant (Mixed-MoA loses to Self-MoA on every published comparison since ICLR 2025). MCTS, CePO, and full MoA are not omitted because they are bad, they are omitted because their operational cost (10–30× tokens, multi-model orchestration) rarely pays off when the underlying model already reasons internally.

The honest claim: Prism does the things that still matter, and skips the things that were rendered redundant by the models it sits in front of.

## Why TypeScript + Bun

There is a thriving Python project for this, [`codelion/optillm`](https://github.com/codelion/optillm), and we cite it as the algorithmic reference for every technique here. The Python ecosystem does not need another. What it lacks is a clean equivalent inside the TypeScript stack: applications written in TS/Bun increasingly run alongside self-hosted models on the same infrastructure, and bridging back to Python just to get majority voting is operationally painful.

Bun gives us native `fetch`, `Bun.serve`, native SQLite, and a built-in test runner, enough primitives to build a focused proxy without dragging in Express, axios, Vitest, or a framework. Production dependencies are capped at three: `zod`, `rxjs`, `eventsource-parser`. The whole `src/` is around 3,500 lines, and a new technique fits in under 100 lines.

## Quickstart

### As a server

```bash
bun add @xinity/prism
bunx prism serve --port 4000 --upstream http://localhost:11434/v1
```

Point your OpenAI client at `http://localhost:4000/v1` and add per-request headers:

```bash
curl -H 'x-xinity-techniques: self-consistency:k=5' \
     -H 'content-type: application/json' \
     -d '{"model":"deepseek-r1-distill-llama-70b",
          "messages":[{"role":"user","content":"A farmer has 17 sheep. All but 9 run away. How many remain?"}]}' \
     http://localhost:4000/v1/chat/completions
```

The CLI loads `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL_SPECIFIER` from `.env` automatically (Bun loads `.env`), so for a typical setup you can just run `bunx prism serve`.

### Programmatically

```typescript
import { createHttpUpstreamClient, pipelineRun, selfConsistency, privacy } from '@xinity/prism';

const upstream = createHttpUpstreamClient({
  baseUrl: process.env.LLM_BASE_URL!,
  apiKey: process.env.LLM_API_KEY!,
});

const response = await pipelineRun({
  request: {
    model: process.env.LLM_MODEL_SPECIFIER!,
    messages: [{ role: 'user', content: 'Why is the sky blue?' }],
  },
  techniques: [selfConsistency({ k: 3 })],
  transforms: [privacy()],
  upstream,
  modelProfile: { match: /.*/, thinkingMode: true, supportsLogprobs: false },
  logger: console,
  signal: AbortSignal.timeout(60_000),
});

console.log(response.choices[0]?.message.content);
```

See `examples/programmatic.ts`, `examples/server.ts`, and `examples/composition.ts` for runnable end-to-end versions.

## Technique reference

| Technique | What it does | When to use it | Streams? |
|---|---|---|---|
| `selfConsistency({ k })` | K parallel samples, majority vote on the extracted final answer (`\boxed{...}`, last fenced block, GSM8K `####`, or trim fallback) | Math, structured Q&A, anywhere ground truth is checkable | No, emits SSE progress, then final chunk |
| `bestOfN({ n, verifier })` | N parallel samples, scored by a pluggable verifier, highest wins | Tasks with a programmatic correctness signal (regex, JSON schema, unit tests, judge model) | No, same shape as SC |
| `roundTrip({ threshold })` | Forward call → reverse-prompt to reconstruct the input → score equivalence → retry on low score | Translation, summarization, code-from-spec where a coherent answer should round-trip | Yes (N=1 case) |
| `planSearch({ numPlans, samplesPerPlan })` | Generate observations → diverse plans → sample per plan → verifier-pick or vote | Open-ended reasoning where diverse approaches improve coverage | No |
| `memory({ chunkTokens })` | Detect long docs, chunk, extract relevant margin notes per chunk, re-issue with condensed context | Long-context Q&A on documents larger than 70% of the context window | Final synthesis streams |
| `deepConf({ mode })` | `offline`: sample N traces with logprobs, rank by bottom-decile group confidence, weighted majority vote. `online`: stream a single trace, abort if confidence drops | Reasoning models with logprobs (self-hosted Xinity, vLLM, SGLang) | Online: yes. Offline: no |

### Plugins (request/response transforms, not reasoning techniques)

| Plugin | What it does |
|---|---|
| `privacy()` | Regex-based PII detection (emails, phones, IBANs, Luhn-verified cards, Austrian SVN, German Steuer-ID, IPv4). Replaces with stable typed placeholders before upstream; restores in the response. GDPR-aware defense-in-depth, not a compliance certificate. |
| `readUrls()` | Detects URLs in messages, fetches with size and timeout caps, extracts text from HTML / JSON / markdown / plain, prepends as a system context message. |
| `json({ schema })` | Two-pass structured output. Validates the response against a Zod schema; on failure, asks the upstream to reformat. Forces `stream: false` while active. |

## Configuration

Three sources, merged with this precedence (highest first):

1. **HTTP headers**, `X-Xinity-Techniques`, `X-Xinity-Plugins`, `X-Xinity-Disabled`, `X-Xinity-Model-Profile`
2. **Body field**, `xinity: { techniques: [...], plugins: [...] }` in the JSON body
3. **Model-name suffix**, `model: "deepseek-r1@self-consistency:k=5"` (for OpenAI SDK clients that can't add fields or headers)
4. **Server defaults**, `createGateway({ defaults })`

Header mini-grammar: comma-separated entries, each `name` or `name:k1=v1;k2=v2`. Values parse as JSON literals.

```
X-Xinity-Techniques: self-consistency:k=5,round-trip
X-Xinity-Plugins: privacy,read-urls
```

For nested option payloads the mini-grammar cannot express, send a base64-encoded JSON config in `X-Xinity-Config`.

## What this is not

This package is a focused proxy. It is intentionally **not**:

- A UI or dashboard
- An auth, rate-limiting, or quota system
- An observability backend (it writes structured JSON to stderr; pipe it where you want)
- A multi-tenant control plane
- A router that picks techniques for you
- A reimplementation of every optillm technique, only the v1 set above (MCTS, MoA, CoT-Decoding, AutoThink, rStar, CePO and friends are out of scope; see *Why only six techniques* above)
- A code sandbox (the `executeCode` slot is a v1 stub awaiting a sandbox runner)

If you need any of these on top, build them as separate layers, the gateway speaks plain HTTP and accepts external transforms. Contributions welcome :)

## About Xinity

Prism is built and maintained by [Xinity](https://xinity.ai/), the sovereign on-premise AI infrastructure platform for European enterprises in regulated industries, media, healthcare, finance, legal, public sector. We extracted Prism from real customer deployments and ship it under Apache 2.0 because the gateway layer should be auditable code, not a vendor lock-in. It stands alone, runs anywhere Bun runs, and has no Xinity dependency.

If you would rather not run, monitor, and tune this yourself, [Xinity Control Center](https://github.com/xinity-ai/xinity-ai) is the managed product around it: model serving, fleet management, multi-tenant isolation, audit logging, regulatory reporting, and ongoing technique tuning against your benchmarks. The relationship is the standard open-core one, the gateway is fully usable on its own, and the commercial product is the rest of the stack around it.

Reach out at [xinity.ai](https://xinity.ai/)