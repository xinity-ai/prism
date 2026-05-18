import type { Verifier } from '../types.ts';

export type RegexVerifierOptions = {
  pattern: RegExp;
  /** Score returned on match. Default 1. */
  matchScore?: number;
  /** Score returned on no match. Default 0. */
  missScore?: number;
};

export function regexVerifier(options: RegexVerifierOptions): Verifier {
  const matchScore = options.matchScore ?? 1;
  const missScore = options.missScore ?? 0;
  return {
    name: 'regex',
    async score(candidate) {
      const content = candidate.choices[0]?.message.content;
      if (typeof content !== 'string') return missScore;
      return options.pattern.test(content) ? matchScore : missScore;
    },
  };
}
