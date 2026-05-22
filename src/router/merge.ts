import type { Technique, Transform } from '../types.ts';

/**
 * Inputs to {@link mergePluginSources}. Mirror layout for techniques in
 * {@link mergeTechniqueSources}.
 *
 * Precedence is documented in `src/router/types.ts` and the v0.2 design
 * notes; the short version is:
 *
 *   1. `explicit` — parsed from `xinity.plugins` on the request. If
 *      present (even an empty array), it REPLACES `router` and
 *      `serverDefaults`. The user said "exactly this set."
 *   2. `opts` — programmatic per-call list. Behaves the same as
 *      `explicit`; used by callers that build the final list themselves
 *      (e.g. the v0.1 wire path that pre-resolves config in `server.ts`).
 *      `explicit` wins on conflict with `opts`.
 *   3. `router` ∪ `serverDefaults` — additive base, deduplicated by name
 *      with `serverDefaults` keeping precedence on conflict (the server
 *      operator's choice over the router's heuristic).
 *   4. `disabled` — names removed from the final merged set regardless
 *      of source.
 */
export type MergePluginSources = {
  /** Parsed `xinity.plugins` from the request. Undefined = not provided. */
  explicit?: Transform[] | undefined;
  /** Programmatic per-call transforms. Undefined = not provided. */
  opts?: Transform[] | undefined;
  /** Router output. Always an array; empty when no router or no matches. */
  router?: Transform[] | undefined;
  /** Server-level defaults from `createGateway({ defaults })`. */
  serverDefaults?: Transform[] | undefined;
  /** Names to drop from the final list. */
  disabled?: string[] | undefined;
};

export type MergeTechniqueSources = {
  explicit?: Technique[] | undefined;
  opts?: Technique[] | undefined;
  router?: Technique[] | undefined;
  serverDefaults?: Technique[] | undefined;
  disabled?: string[] | undefined;
};

/** Merge plugin sources per the precedence model above. Pure function. */
export function mergePluginSources(sources: MergePluginSources): Transform[] {
  return mergeByName<Transform>(sources);
}

/** Merge technique sources per the same precedence as plugins. */
export function mergeTechniqueSources(sources: MergeTechniqueSources): Technique[] {
  return mergeByName<Technique>(sources);
}

type Named = { readonly name: string };

function mergeByName<T extends Named>(sources: {
  explicit?: T[] | undefined;
  opts?: T[] | undefined;
  router?: T[] | undefined;
  serverDefaults?: T[] | undefined;
  disabled?: string[] | undefined;
}): T[] {
  const disabled = new Set(sources.disabled ?? []);

  // Replace mode: explicit (request-level) or opts (programmatic) wins.
  // An empty array is still an explicit signal — "no plugins, on purpose".
  if (sources.explicit !== undefined) {
    return applyDisabled(sources.explicit, disabled);
  }
  if (sources.opts !== undefined) {
    return applyDisabled(sources.opts, disabled);
  }

  // Additive mode: serverDefaults first (operator intent), then router
  // recommendations. Dedupe by name keeping the first occurrence so an
  // operator-configured `privacy()` with specific options is preserved
  // even when the router also wants `privacy()`.
  const base: T[] = [];
  const seen = new Set<string>();
  for (const item of sources.serverDefaults ?? []) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    base.push(item);
  }
  for (const item of sources.router ?? []) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    base.push(item);
  }
  return applyDisabled(base, disabled);
}

function applyDisabled<T extends Named>(items: T[], disabled: Set<string>): T[] {
  if (disabled.size === 0) return items;
  return items.filter(i => !disabled.has(i.name));
}
