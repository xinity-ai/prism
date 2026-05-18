import type { ModelProfile } from './types.ts';

const DEFAULT_PROFILE: ModelProfile = {
  match: /.*/,
  thinkingMode: false,
  supportsLogprobs: false,
};

export function resolveModelProfile(
  model: string,
  profiles: ModelProfile[],
  explicitName?: string,
): ModelProfile {
  if (explicitName) {
    const byName = profiles.find(p => p.name === explicitName);
    if (byName) return byName;
  }
  for (const profile of profiles) {
    const m = profile.match;
    if (typeof m === 'string') {
      if (m === model) return profile;
    } else if (m.test(model)) {
      return profile;
    }
  }
  return DEFAULT_PROFILE;
}
