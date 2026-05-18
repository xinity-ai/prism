# Prism · `@xinity/prism`

An OpenAI-compatible optimizing inference proxy for self-hosted reasoning models. Sits between your applications and a vLLM / Ollama / SGLang / llama.cpp endpoint, applies inference-time techniques (self-consistency, plan-search, round-trip, best-of-n, memory, deep-conf), and exposes the same `/v1/chat/completions` surface your existing OpenAI SDK clients already speak.

The name fits the job: a prism splits a single ray into its component spectrum, and Prism splits a single user query into K parallel samples, diverse plans, or confidence-ranked traces — recombining them into one answer that's better than the original ray.

```
clients (OpenAI SDK) ─► prism ─► vLLM / Ollama / SGLang
                              │
                              ├── self-consistency
                              ├── plan-search
                              ├── memory (writing-in-the-margins)
                              ├── best-of-n + verifier
                              ├── round-trip
                              ├── deep-conf (logprobs)
                              └── plugins: privacy, read-urls, json
```

## What problem this solves

Reasoning models hosted on your own infrastructure are great until you discover that the techniques shown to lift their accuracy on math, code, and structured-output benchmarks — self-consistency, best-of-n, plan-search, deep-conf — aren't in any of the popular TypeScript inference stacks. You end up either rebuilding them in application code or routing everything through a Python service just to get majority voting.

Prism puts those techniques behind a drop-in OpenAI endpoint. Your application keeps using the OpenAI SDK; you toggle techniques per request with a header or per deployment with server defaults. No code changes in the client. When no techniques are active, it is byte-for-byte transparent — same status codes, same streaming chunks, same tool-call shape.

## Why TypeScript + Bun

There is a thriving Python project for this — [`codelion/optillm`](https://github.com/codelion/optillm) — and we cite it as the algorithmic reference for every technique here. The Python ecosystem doesn't need another. What it lacks is a clean equivalent inside the TypeScript stack: applications written in TS/Bun increasingly run alongside self-hosted models on the same infrastructure, and bridging back to Python just to get majority voting is operationally painful.

Bun specifically gives us native `fetch`, `Bun.serve`, native SQLite, and a built-in test runner — enough primitives to build a focused proxy without dragging in Express, axios, Vitest, or a framework. Production dependencies are capped at three: `zod`, `rxjs`, `eventsource-parser`. The whole `src/` is around 3,500 lines, and a new technique fits in under 100 lines.

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
| `selfConsistency({ k })` | K parallel samples, majority vote on the extracted final answer (`\boxed{...}`, last fenced block, GSM8K `####`, or trim fallback) | Math, structured Q&A, anywhere ground truth is checkable | No — emits SSE progress, then final chunk |
| `bestOfN({ n, verifier })` | N parallel samples, scored by a pluggable verifier, highest wins | Tasks with a programmatic correctness signal (regex, JSON schema, unit tests, judge model) | No — same shape as SC |
| `roundTrip({ threshold })` | Forward call → reverse-prompt to reconstruct the input → score equivalence → retry on low score | Translation, summarization, code-from-spec where a coherent answer should round-trip | Yes (N=1 case) |
| `planSearch({ numPlans, samplesPerPlan })` | Generate observations → diverse plans → sample per plan → verifier-pick or vote | Open-ended reasoning where diverse approaches improve coverage | No |
| `memory({ chunkTokens })` | Detect long docs, chunk, extract relevant margin notes per chunk, re-issue with condensed context | Long-context Q&A on documents larger than 70% of the context window | Final synthesis streams |
| `deepConf({ mode })` | `offline`: sample N traces with logprobs, rank by bottom-decile group confidence, weighted majority vote. `online`: stream a single trace, abort if confidence drops | Reasoning models with logprobs (self-hosted vLLM / SGLang) | Online: yes. Offline: no |

### Plugins (request/response transforms — not reasoning techniques)

| Plugin | What it does |
|---|---|
| `privacy()` | Regex-based PII detection (emails, phones, IBANs, Luhn-verified cards, Austrian SVN, German Steuer-ID, IPv4). Replaces with stable typed placeholders before upstream; restores in the response. GDPR-aware defense-in-depth — not a compliance certificate. |
| `readUrls()` | Detects URLs in messages, fetches with size and timeout caps, extracts text from HTML / JSON / markdown / plain, prepends as a system context message. |
| `json({ schema })` | Two-pass structured output. Validates the response against a Zod schema; on failure, asks the upstream to reformat. Forces `stream: false` while active. |

## Configuration

Three sources, merged with this precedence (highest first):

1. **HTTP headers** — `X-Xinity-Techniques`, `X-Xinity-Plugins`, `X-Xinity-Disabled`, `X-Xinity-Model-Profile`
2. **Body field** — `xinity: { techniques: [...], plugins: [...] }` in the JSON body
3. **Model-name suffix** — `model: "deepseek-r1@self-consistency:k=5"` (for OpenAI SDK clients that can't add fields or headers)
4. **Server defaults** — `createGateway({ defaults })`

Header mini-grammar: comma-separated entries, each `name` or `name:k1=v1;k2=v2`. Values parse as JSON literals.

```
X-Xinity-Techniques: self-consistency:k=5,round-trip
X-Xinity-Plugins: privacy,read-urls
```

For nested option payloads the mini-grammar can't express, send a base64-encoded JSON config in `X-Xinity-Config`.

## What this is not

This package is a focused proxy. It is intentionally **not**:

- A UI or dashboard
- An auth, rate-limiting, or quota system
- An observability backend (it writes structured JSON to stderr; pipe it where you want)
- A multi-tenant control plane
- A router that picks techniques for you
- A reimplementation of every optillm technique — only the v1 set above (MCTS, MoA, CoT-Decoding, AutoThink, rStar, CePO and friends are out of scope)
- A code sandbox (the `executeCode` slot is a v1 stub awaiting a sandbox runner)

If you need any of these on top, build them as separate layers — the gateway speaks plain HTTP and accepts external transforms. Contributions are welcome :)

## About Xinity

This package is built by [Xinity](https://xinity.ai/), which provides sovereign on-premise AI infrastructure for European enterprises in regulated industries — media, healthcare, finance, legal, public sector. The gateway is the open layer of a broader stack: it stands alone, runs anywhere Bun runs, and was extracted from real customer deployments rather than designed in a vacuum. Use it freely.

---

If you'd rather not run, monitor, and tune this yourself — and want an end-to-end deployment that includes the model serving infrastructure, fleet management, multi-tenant isolation, audit logging, and ongoing technique tuning against your benchmarks — Xinity Control Center provides that as a managed product [github:xinity-ai](https://github.com/xinity-ai/xinity-ai). Reach out at [xinity.ai](https://xinity.ai/).
