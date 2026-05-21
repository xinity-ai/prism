// Server
export { createGateway } from './server.ts';
export type { Gateway, GatewayConfig } from './server.ts';

// Upstream
export { createHttpUpstreamClient } from './upstream.ts';
export type { HttpUpstreamConfig } from './upstream.ts';

// Config / registry
export { resolveConfig } from './config.ts';
export type { Registry, ResolvedConfig, ConfigSources } from './config.ts';

// Model profiles
export { resolveModelProfile } from './model-profile.ts';

// Logging
export { createJsonLogger, silentLogger } from './logging.ts';

// Pipeline
export { pipelineRun } from './pipeline.ts';

// Core types
export {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ChatCompletionChunkSchema,
  XinityConfigSchema,
  GatewayError,
  fromWireRequest,
  toWireRequest,
  fromWireResponse,
  toWireResponse,
  fromWireChunk,
  toWireChunk,
} from './types.ts';

export type {
  Technique,
  TechniqueContext,
  TechniqueCapabilities,
  Transform,
  TransformState,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  Message,
  ContentPart,
  Choice,
  ChunkChoice,
  ChunkDelta,
  Usage,
  Tool,
  ToolCall,
  ToolChoice,
  ResponseFormat,
  Logprob,
  Logprobs,
  Role,
  UpstreamClient,
  ModelProfile,
  Logger,
  ProgressEvent,
  XinityConfig,
  XinityTechniqueRef,
  Verifier,
  EquivalenceScorer,
  Voter,
  WireChatCompletionRequest,
  WireChatCompletionResponse,
  WireChatCompletionChunk,
} from './types.ts';

// Built-in techniques
export { selfConsistency } from './techniques/self-consistency.ts';
export type { SelfConsistencyOptions } from './techniques/self-consistency.ts';
export { bestOfN } from './techniques/best-of-n.ts';
export type { BestOfNOptions } from './techniques/best-of-n.ts';
export { roundTrip, modelJudgeScorer } from './techniques/round-trip.ts';
export type { RoundTripOptions } from './techniques/round-trip.ts';
export { planSearch } from './techniques/plan-search.ts';
export type { PlanSearchOptions } from './techniques/plan-search.ts';
export { memory } from './techniques/memory.ts';
export type { MemoryOptions } from './techniques/memory.ts';
export { deepConf, confidenceWeightedVoter } from './techniques/deep-conf.ts';
export type { DeepConfOptions } from './techniques/deep-conf.ts';

// Built-in plugins (transforms)
export { privacy } from './plugins/privacy.ts';
export type { PrivacyOptions } from './plugins/privacy.ts';
export { readUrls } from './plugins/read-urls.ts';
export type { ReadUrlsOptions } from './plugins/read-urls.ts';
export { json } from './plugins/json.ts';
export type { JsonOptions } from './plugins/json.ts';

// Built-in verifiers — each from its own module, no barrel
export { regexVerifier } from './verifiers/regex.ts';
export type { RegexVerifierOptions } from './verifiers/regex.ts';
export { jsonSchemaVerifier } from './verifiers/json-schema.ts';
export type { JsonSchemaVerifierOptions } from './verifiers/json-schema.ts';
export { judgeVerifier } from './verifiers/judge.ts';
export type { JudgeVerifierOptions } from './verifiers/judge.ts';
export { unitTestVerifier } from './verifiers/unit-test.ts';
export type { UnitTestVerifierOptions } from './verifiers/unit-test.ts';

// Voting helpers
export { defaultVoter, extractFinalAnswer, normalizeAnswer } from './internal/voting.ts';

// Routing (v0.2)
export {
  rule,
  rulesRouter,
  composeRouters,
  defaultRules,
  assertRouterConformance,
  verifierRegistry,
} from './router.ts';
export type {
  Router,
  RouterContext,
  RouterDecision,
  Rule,
  RuleInput,
  PartialDecision,
} from './router.ts';
export type { VerifierRegistry } from './types.ts';
