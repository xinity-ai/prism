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

<p align="center"><strong>Get started:</strong> <code>bun add <a href="https://www.npmjs.com/package/@xinity/prism">@xinity/prism</a></code></p>

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

> Requires **Bun ≥ 1.3**. Node compatibility is on the v0.3 roadmap.

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

## Routing (v0.2)

By default Prism still runs only what you ask it to. v0.2 adds two opt-in mechanisms for automatic selection, deliberately kept independent:

1. **A `Router`** that picks **techniques** based on the request shape.
2. **Auto-activating plugins** whose own `shouldActivate` predicate decides whether they belong in the chain.

The two mechanisms don't share state and don't talk to each other. Plugins self-activate on structural triggers (PII present, URLs present, schema present). The Router makes a judgmental decision about which inference-time techniques to apply. Both can be on, off, or mixed per request.

### Rule-based router

The shipped router is a simple `Router` over a list of `Rule`s. Each rule is a name, a sync predicate, and a decision-producer:

```typescript
import { createGateway, rulesRouter, defaultRules } from '@xinity/prism';

createGateway({
  upstream: { baseUrl: 'http://localhost:11434/v1' },
  router: rulesRouter(defaultRules),
});
```

The four `defaultRules` cover the obvious cases:

| Rule | Fires when | Adds |
|---|---|---|
| `memory-for-long-input` | input > 70% of the model's context window | `memory({})` |
| `plan-search-for-code` | code-generation prompt detected AND `effortBudget ≥ 0.4` | `planSearch({ numPlans: 5 })`, paired with the `unit-test` verifier if registered |
| `round-trip-for-translation-or-summary` | translate/summarize intent detected (EN/DE/FR/IT/ES) | `roundTrip({})` |
| `self-consistency-default` | `effortBudget ≥ 0.3` | `selfConsistency({ k })` — `k` adapts: low budget → 2, thinking-mode → 3, otherwise 5 |

Rules compose **additively**. A long-document code request matches three rules and gets `[memory, planSearch, selfConsistency]`. There are no priorities, no rule-disables-rule mechanic, no async predicates — the simplicity is deliberate (see `DESIGN.md` §17.4.1).

You can extend or replace the default set:

```typescript
import { rulesRouter, defaultRules, rule, bestOfN } from '@xinity/prism';

router: rulesRouter([
  ...defaultRules,
  rule({
    name: 'medical-domain-best-of-n',
    when: ({ request }) => /\b(patient|diagnosis|dosage)\b/i.test(JSON.stringify(request.messages)),
    apply: ({ verifiers }) => ({ techniques: [bestOfN({ n: 5, verifier: verifiers.get('medical-judge')! })] }),
  }),
]);
```

The optional per-request `xinity.effortBudget` (0..1) is forwarded to the router as `RouterContext.effortBudget`. The default rules use it to gate the more expensive techniques.

### Merge semantics — explicit beats router

```
xinity.techniques in request?    router configured?    behavior              log event
─────────────────────────────────────────────────────────────────────────────────────────
yes (incl. empty array)          yes                   explicit used          router.bypassed
yes (incl. empty array)          no                    explicit used          (none)
no                               yes                   router decides         router.decision
no                               no                    server defaults used   router.fallback
```

If you set `xinity.techniques` on a request, the router never runs for it. Period. The same applies to `xinity.plugins`: explicit plugins always bypass auto-activation.

### Auto-activating plugins

```typescript
createGateway({
  upstream: { baseUrl: 'http://localhost:11434/v1' },
  autoActivatePlugins: true,
  defaults: { plugins: ['privacy', 'read-urls', 'json'] },
});
```

When `autoActivatePlugins: true` AND the request did not supply its own plugin list, each default plugin's `shouldActivate(request, modelProfile)` is consulted. Plugins without a `shouldActivate` predicate are always included. Per-request explicit plugins are never gated.

The three core plugins ship with these predicates:

| Plugin | Activates when |
|---|---|
| `privacy()` | the PII detector finds matches in any user-role message |
| `readUrls()` | a user-role message contains an `http(s)://` URL |
| `json({ schema })` | `response_format` is `json_schema`/`json_object`, or a schema was provided at construction (the typical case → effectively always on) |

Every decision emits a structured log line: `plugin.auto-activated` / `plugin.auto-skipped` per plugin, `router.decision` / `router.bypassed` / `router.fallback` per request, plus `router.init` / `router.close` for lifecycle.

### Composition — `composeRouters`

Hybrid routing is just a combinator:

```typescript
import { composeRouters, rulesRouter, rule, memory } from '@xinity/prism';

router: composeRouters([
  someOtherRouter,
  rulesRouter([
    // Always wrap in memory for long inputs, regardless of what the primary said
    rule({
      name: 'memory-override',
      when: ({ request, modelProfile }) =>
        request.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
        > 0.7 * (modelProfile.contextWindow ?? 32_000),
      apply: () => ({ techniques: [memory({})] }),
    }),
  ]),
]);
```

Composed routers run their children in parallel, concatenate techniques in order, join reason strings, and take the minimum confidence across any children that report one. `init` and `close` propagate to all children.

### Coming in v0.3: semantic router

A separately published package, **`@xinity/prism-router-semantic`**, will implement the same `Router` interface with a ModernBERT-based classifier. ONNX Runtime and tokenizer dependencies live in that package so core `@xinity/prism` users don't pay for them. It will compose with the rule-based router via `composeRouters` — no breaking change to v0.2 code expected.

```typescript
// v0.3 preview (not yet published)
import { semanticRouter } from '@xinity/prism-router-semantic';
import { composeRouters, rulesRouter, defaultRules } from '@xinity/prism';

router: composeRouters([
  semanticRouter({ model: 'modernbert-large' }),
  rulesRouter(defaultRules), // structural overrides on top of the classifier
]);
```

## What this is not

This package is a focused proxy. It is intentionally **not**:

- A UI or dashboard
- An auth, rate-limiting, or quota system
- An observability backend (it writes structured JSON to stderr; pipe it where you want)
- A multi-tenant control plane
- A reimplementation of every optillm technique, only the v1 set above (MCTS, MoA, CoT-Decoding, AutoThink, rStar, CePO and friends are out of scope; see *Why only six techniques* above)
- A code sandbox (the `executeCode` slot is a v1 stub awaiting a sandbox runner)

If you need any of these on top, build them as separate layers, the gateway speaks plain HTTP and accepts external transforms. Contributions welcome :)

## About Xinity

Prism is built and maintained by [Xinity](https://xinity.ai/), the sovereign on-premise AI infrastructure platform for European enterprises in regulated industries, media, healthcare, finance, legal, public sector. We extracted Prism from real customer deployments and ship it under Apache 2.0 because the gateway layer should be auditable code, not a vendor lock-in. It stands alone, runs anywhere Bun runs, and has no Xinity dependency.

If you would rather not run, monitor, and tune this yourself, [Xinity Control Center](https://github.com/xinity-ai/xinity-ai) is the managed product around it: model serving, fleet management, multi-tenant isolation, audit logging, regulatory reporting, and ongoing technique tuning against your benchmarks. The relationship is the standard open-core one, the gateway is fully usable on its own, and the commercial product is the rest of the stack around it.

Reach out at [xinity.ai](https://xinity.ai/)

## License

[Apache License 2.0](LICENSE). Use it commercially, fork it, embed it in proprietary products — the license covers all of that. See `LICENSE` for the full text.