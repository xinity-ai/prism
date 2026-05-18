import type { Verifier } from '../types.ts';

export type UnitTestVerifierOptions = {
  language: 'python' | 'javascript' | 'typescript';
  tests: string;
  /** v1 ships a stub. Real sandbox integration is v1.1. */
  runner?: (args: { language: string; code: string; tests: string }) => Promise<{ passed: number; total: number }>;
};

/**
 * v1 stub. Extracts the first fenced code block from the candidate and either
 * forwards it to a user-supplied `runner` or scores 0 with a warning. Real
 * sandboxing is intentionally out of scope until the separate sandbox runner
 * package is built.
 */
export function unitTestVerifier(options: UnitTestVerifierOptions): Verifier {
  return {
    name: 'unit-test',
    async score(candidate) {
      const content = candidate.choices[0]?.message.content;
      if (typeof content !== 'string') return 0;
      const fence = content.match(/```(?:[\w-]+)?\s*([\s\S]+?)```/);
      const code = fence ? fence[1]!.trim() : content.trim();
      if (!options.runner) return 0;
      const { passed, total } = await options.runner({ language: options.language, code, tests: options.tests });
      if (total <= 0) return 0;
      return passed / total;
    },
  };
}
