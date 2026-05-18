export const OBSERVATIONS_PROMPT = (problem: string, numObservations: number) =>
  `You will be given a problem. Return ${numObservations} useful, non-obvious observations that would help someone solve it. ` +
  `Be specific. Do not solve the problem yet. Write each observation as a single bullet starting with "- ".\n\n` +
  `Problem:\n${problem}`;

export const PLAN_PROMPT = (problem: string, observations: string[]) =>
  `You will be given a problem and a set of observations. Write ONE concrete plan (3-7 steps) for solving the problem. ` +
  `Use the observations as guidance, but the plan should be a coherent natural-language strategy, not a list of observations.\n\n` +
  `Problem:\n${problem}\n\nObservations:\n${observations.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nPlan:`;

export const SOLVE_WITH_PLAN_PROMPT = (problem: string, plan: string) =>
  `Solve the following problem by following the plan exactly. Produce only the answer, not the plan.\n\n` +
  `Problem:\n${problem}\n\nPlan:\n${plan}\n\nAnswer:`;
