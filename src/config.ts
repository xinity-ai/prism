import { GatewayError, XinityConfigSchema } from './types.ts';
import type { Technique, Transform, XinityConfig, XinityTechniqueRef } from './types.ts';

/**
 * Per-gateway registry of technique/transform factories. The only "registry"
 * in the system. Lives on `GatewayConfig`, not in a module-level singleton.
 */
export type Registry = {
  techniques: Map<string, (options?: unknown) => Technique>;
  transforms: Map<string, (options?: unknown) => Transform>;
};

export type ResolvedConfig = {
  techniques: Technique[];
  transforms: Transform[];
  modelProfileName?: string;
  /** The base model name with any @-suffix stripped. */
  resolvedModel: string;
  /**
   * v0.2 — true when techniques came from a per-request source (body,
   * headers, or model-suffix). False when they came only from server defaults
   * (or there are none). Server uses this to decide whether to consult the
   * Router: explicit beats router.
   */
  techniquesFromRequest: boolean;
  /**
   * v0.2 — true when plugins came from a per-request source. False when only
   * server defaults supplied them. Server uses this to decide whether to apply
   * `shouldActivate` filtering: explicit plugins are never gated.
   */
  pluginsFromRequest: boolean;
  /**
   * v0.2 — merged effortBudget value (per-request layers override defaults).
   * Undefined when no layer supplied it.
   */
  effortBudget?: number;
};

export type ConfigSources = {
  /** Body `xinity` field (already JSON-parsed). */
  body?: XinityConfig;
  /** Raw HTTP headers (lowercased keys). */
  headers?: Record<string, string | undefined>;
  /** Server-level defaults. */
  defaults?: XinityConfig;
  /** Original model string from the request body (may carry an @-suffix). */
  model: string;
};

/**
 * Resolve the Xinity configuration for a single request.
 *
 * Precedence (highest first): headers > body > model-suffix > server defaults.
 * `disabled` lists from any layer subtract names from the merged result.
 */
export function resolveConfig(sources: ConfigSources, registry: Registry): ResolvedConfig {
  const fromModel = parseModelSuffix(sources.model);
  const fromHeaders = parseHeaders(sources.headers ?? {});
  // Per-request layers, in precedence order (last wins on conflict).
  const requestLayers: XinityConfig[] = [fromModel.config, sources.body ?? {}, fromHeaders];
  const layers: XinityConfig[] = [sources.defaults ?? {}, ...requestLayers];

  const merged: XinityConfig = {};
  for (const layer of layers) {
    if (layer.techniques !== undefined) merged.techniques = layer.techniques;
    if (layer.plugins !== undefined) merged.plugins = layer.plugins;
    if (layer.modelProfile !== undefined) merged.modelProfile = layer.modelProfile;
    if (layer.disabled !== undefined) merged.disabled = layer.disabled;
    if (layer.effortBudget !== undefined) merged.effortBudget = layer.effortBudget;
  }

  const disabled = new Set(merged.disabled ?? []);
  const techniques = (merged.techniques ?? [])
    .filter(ref => !disabled.has(refName(ref)))
    .map(ref => instantiate(ref, registry.techniques, 'technique'));
  const transforms = (merged.plugins ?? [])
    .filter(ref => !disabled.has(refName(ref)))
    .map(ref => instantiate(ref, registry.transforms, 'plugin'));

  // Origin flags: any per-request source that supplied a non-empty list
  // means the user was explicit. Empty arrays count as "supplied an explicit
  // empty selection" — also explicit.
  const techniquesFromRequest = requestLayers.some(l => l.techniques !== undefined);
  const pluginsFromRequest = requestLayers.some(l => l.plugins !== undefined);

  return {
    techniques,
    transforms,
    modelProfileName: merged.modelProfile,
    resolvedModel: fromModel.baseModel,
    techniquesFromRequest,
    pluginsFromRequest,
    ...(merged.effortBudget !== undefined && { effortBudget: merged.effortBudget }),
  };
}

function refName(ref: XinityTechniqueRef): string {
  return typeof ref === 'string' ? splitNameOpts(ref).name : ref.name;
}

function instantiate<T>(
  ref: XinityTechniqueRef,
  factories: Map<string, (options?: unknown) => T>,
  kind: 'technique' | 'plugin',
): T {
  let name: string;
  let options: unknown;
  if (typeof ref === 'string') {
    const parsed = splitNameOpts(ref);
    name = parsed.name;
    options = parsed.options;
  } else {
    name = ref.name;
    options = ref.options;
  }
  const factory = factories.get(name);
  if (!factory) {
    throw new GatewayError(400, 'unknown_' + kind, `unknown ${kind} '${name}'`);
  }
  return factory(options);
}

/**
 * Parse a header-style entry: `name` or `name:k1=v1;k2=v2`.
 * Values parse as JSON literals (numbers, booleans, quoted strings) and fall
 * back to the raw string for bare tokens.
 */
function splitNameOpts(entry: string): { name: string; options: Record<string, unknown> | undefined } {
  const trimmed = entry.trim();
  const colon = trimmed.indexOf(':');
  if (colon === -1) return { name: trimmed, options: undefined };
  const name = trimmed.slice(0, colon).trim();
  const optsRaw = trimmed.slice(colon + 1);
  const options: Record<string, unknown> = {};
  for (const pair of optsRaw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key) continue;
    options[key] = parseLiteral(value);
  }
  return { name, options };
}

function parseLiteral(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  // Quoted JSON string
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function parseHeaders(headers: Record<string, string | undefined>): XinityConfig {
  // The base64-JSON escape hatch wins over the mini-grammar.
  const b64 = headers['x-xinity-config'];
  if (b64) {
    try {
      const decoded = atob(b64);
      const parsed = JSON.parse(decoded);
      return XinityConfigSchema.parse(parsed);
    } catch (cause) {
      throw new GatewayError(400, 'invalid_xinity_header', 'X-Xinity-Config must be base64-encoded JSON', cause);
    }
  }
  const result: XinityConfig = {};
  const techs = headers['x-xinity-techniques'];
  if (techs) result.techniques = parseList(techs);
  const plugs = headers['x-xinity-plugins'];
  if (plugs) result.plugins = parseList(plugs);
  const disabled = headers['x-xinity-disabled'];
  if (disabled) result.disabled = disabled.split(',').map(s => s.trim()).filter(Boolean);
  const profile = headers['x-xinity-model-profile'];
  if (profile) result.modelProfile = profile.trim();
  return result;
}

function parseList(raw: string): XinityTechniqueRef[] {
  const out: XinityTechniqueRef[] = [];
  // Top-level separator is comma; options use semicolons internally.
  for (const item of raw.split(',')) {
    const entry = item.trim();
    if (!entry) continue;
    const { name, options } = splitNameOpts(entry);
    out.push(options ? { name, options } : name);
  }
  return out;
}

/**
 * Parse model-name suffix: `model@technique1:k=5,technique2`.
 * The base model is everything before the first `@`.
 */
function parseModelSuffix(model: string): { baseModel: string; config: XinityConfig } {
  const at = model.indexOf('@');
  if (at === -1) return { baseModel: model, config: {} };
  const baseModel = model.slice(0, at);
  const suffix = model.slice(at + 1);
  return { baseModel, config: { techniques: parseList(suffix) } };
}
