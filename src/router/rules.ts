import { z } from 'zod';
import {
  detectContextOverflow,
  detectPii,
  detectUrls,
  extractFeatures,
  type TaskSignal,
} from '../internal/detection/index.ts';
import { json } from '../plugins/json.ts';
import { privacy } from '../plugins/privacy.ts';
import { readUrls } from '../plugins/read-urls.ts';
import { memory } from '../techniques/memory.ts';
import type { ChatRequest, Technique, Transform } from '../types.ts';
import type { Router, RouterContext, RouterDecision, RouterRationale } from './types.ts';

export type RulesRouterOptions = {
  /** Enable the privacy plugin when PII is detected. Default: true. */
  privacy?: boolean;
  /** Enable the readUrls plugin when URLs are present. Default: true. */
  readUrls?: boolean;
  /** Enable the json plugin when response_format is set. Default: true. */
  json?: boolean;
  /**
   * Enable the memory technique when input exceeds `ratio × contextWindow`.
   * `false` disables; an object overrides the ratio. Default: true (ratio 0.7).
   */
  memory?: boolean | { ratio?: number };
  /**
   * Override how plugin/technique instances are constructed when a rule fires.
   * Use this to pass non-default options to a plugin the router activates
   * (e.g. a custom PII detector, larger readUrls quota).
   *
   * For `json`, the `schema` argument is the raw `response_format.json_schema.schema`
   * value from the request when `type === 'json_schema'`, or `undefined` for
   * `type === 'json_object'`. The default factory uses `z.unknown()` regardless
   * — full JSON Schema → Zod conversion is out of v0.2 scope, so callers that
   * need strict structural validation should override via `customize.json`.
   */
  customize?: {
    privacy?: () => Transform;
    readUrls?: () => Transform;
    json?: (schema: unknown) => Transform;
    memory?: () => Technique;
  };
};

/**
 * The in-tree, rule-based router for `@xinity/prism`.
 *
 * Inspects a `ChatRequest` and activates four rules independently:
 *   - `privacy` when the PII detector fires
 *   - `readUrls` when HTTP(S) URLs are present
 *   - `json` when `response_format` is set
 *   - `memory` when the input exceeds `ratio × contextWindow`
 *
 * The router emits exactly one `router.decide` log event per call, regardless
 * of how many rules fire, and populates `decision.signals` with every detector
 * output (firing and non-firing) so a future semantic router can reuse the
 * rules layer's work as classifier features.
 *
 * Statelessness: the function returned closes over `opts` only; no state is
 * retained across requests, no caches are warmed.
 */
export function rulesRouter(opts: RulesRouterOptions = {}): Router {
  const enablePrivacy = opts.privacy !== false;
  const enableReadUrls = opts.readUrls !== false;
  const enableJson = opts.json !== false;
  const enableMemory = opts.memory !== false;
  const memoryRatio = typeof opts.memory === 'object' ? opts.memory.ratio : undefined;

  const buildPrivacy = opts.customize?.privacy ?? (() => privacy());
  const buildReadUrls = opts.customize?.readUrls ?? (() => readUrls());
  const buildJson = opts.customize?.json ?? ((_schema: unknown) => json({ schema: z.unknown() }));
  const buildMemory = opts.customize?.memory ?? (() => memory());

  return {
    name: 'rules',
    async decide(request: ChatRequest, ctx: RouterContext): Promise<RouterDecision> {
      const t0 = performance.now();
      const features = extractFeatures(request);

      const signals: TaskSignal[] = [];
      const plugins: Transform[] = [];
      const techniques: Technique[] = [];
      const rationale: RouterRationale[] = [];
      let consideredRules = 0;

      // Rule 1 — privacy / PII
      if (enablePrivacy) {
        consideredRules += 1;
        const sig = detectPii(request, features);
        signals.push(sig);
        if (sig.match) {
          plugins.push(buildPrivacy());
          rationale.push({ target: 'privacy', rule: 'pii-detected', reason: sig.reason });
        }
      }

      // Rule 2 — readUrls / URLs present
      if (enableReadUrls) {
        consideredRules += 1;
        const sig = detectUrls(request, features);
        signals.push(sig);
        if (sig.match) {
          plugins.push(buildReadUrls());
          rationale.push({ target: 'readUrls', rule: 'urls-present', reason: sig.reason });
        }
      }

      // Rule 3 — json / response_format set. Structural; no TaskSignal.
      if (enableJson) {
        consideredRules += 1;
        const rf = request.responseFormat;
        if (rf && (rf.type === 'json_schema' || rf.type === 'json_object')) {
          const schema = rf.type === 'json_schema' ? rf.json_schema.schema : undefined;
          plugins.push(buildJson(schema));
          rationale.push({
            target: 'json',
            rule: 'response-format-set',
            reason: `response_format=${rf.type}`,
          });
        }
      }

      // Rule 4 — memory / context overflow
      if (enableMemory) {
        consideredRules += 1;
        const sig = detectContextOverflow(request, features, {
          ...(ctx.modelProfile.contextWindow !== undefined && {
            contextWindow: ctx.modelProfile.contextWindow,
          }),
          ...(memoryRatio !== undefined && { ratio: memoryRatio }),
        });
        signals.push(sig);
        if (sig.match) {
          techniques.push(buildMemory());
          rationale.push({ target: 'memory', rule: 'context-overflow', reason: sig.reason });
        }
      }

      ctx.logger.info({
        event: 'router.decide',
        router: 'rules',
        durationMs: Math.max(0, Math.round((performance.now() - t0) * 100) / 100),
        activatedPlugins: plugins.map(p => p.name),
        activatedTechniques: techniques.map(t => t.name),
        consideredRules,
        firedRules: rationale.length,
        rationale,
      });

      return { plugins, techniques, signals, rationale };
    },
  };
}
