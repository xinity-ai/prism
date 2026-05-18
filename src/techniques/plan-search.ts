import { defaultVoter } from '../internal/voting.ts';
import { OBSERVATIONS_PROMPT, PLAN_PROMPT, SOLVE_WITH_PLAN_PROMPT } from './plan-search.prompts.ts';
import type {
  ChatRequest, ChatResponse, Message, Technique, TechniqueContext, UpstreamClient, Verifier, Voter,
} from '../types.ts';

export type PlanSearchOptions = {
  /** Number of diverse plans to generate. Default 5. */
  numPlans?: number;
  /** Samples per plan when running the solver. Default 1. */
  samplesPerPlan?: number;
  /** Number of observations to generate in stage 1. Default 6. */
  numObservations?: number;
  /** Verifier for selection. When absent, falls back to majority vote. */
  verifier?: Verifier;
  /** Custom voter when no verifier. Defaults to the same majority voter SC uses. */
  voter?: Voter;
  /** Sampling temperature for the solve step. Default 0.7 for diversity. */
  temperature?: number;
};

export function planSearch(options: PlanSearchOptions = {}): Technique {
  const numPlans = options.numPlans ?? 5;
  const samplesPerPlan = options.samplesPerPlan ?? 1;
  const numObservations = options.numObservations ?? 6;
  const voter = options.voter ?? defaultVoter();
  const solveTemp = options.temperature ?? 0.7;

  return {
    name: 'plan-search',
    capabilities: {
      requiresLogprobs: false,
      supportsStreaming: false,
      addsLatency: 'high',
      tokenMultiplier: 2 + numPlans * samplesPerPlan,
      worksWithThinkingMode: true,
      subsumedByThinkingMode: false,
    },

    async apply(ctx: TechniqueContext): Promise<ChatResponse> {
      const problem = extractUserInput(ctx.request);

      const observations = await generateObservations(ctx.upstream, ctx.request.model, problem, numObservations, ctx.signal);
      const plans = await generatePlans(ctx.upstream, ctx.request.model, problem, observations, numPlans, ctx.signal);
      plans.forEach((plan, i) => ctx.progress({ event: 'xinity.plan.generated', index: i, of: plans.length, plan }));

      const tasks: Promise<ChatResponse>[] = [];
      for (const plan of plans) {
        for (let s = 0; s < samplesPerPlan; s++) {
          tasks.push(sampleWithPlan(ctx, problem, plan, solveTemp).then(r => {
            ctx.progress({ event: 'xinity.sample.complete', index: tasks.length - 1, of: plans.length * samplesPerPlan });
            return r;
          }));
        }
      }
      const completions = await Promise.all(tasks);

      if (options.verifier) {
        const scored = await Promise.all(completions.map(async c => ({ c, score: await options.verifier!.score(c, ctx.request, ctx.signal) })));
        scored.sort((a, b) => b.score - a.score);
        ctx.progress({ event: 'xinity.scores', scores: scored.map(s => s.score) });
        return scored[0]!.c;
      }

      const { winner, distribution } = voter.vote(completions);
      const winnerKey = Object.entries(distribution).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      ctx.progress({ event: 'xinity.voting', distribution, winner: winnerKey });
      return winner;
    },
  };
}

function extractUserInput(request: ChatRequest): string {
  const parts: string[] = [];
  for (const m of request.messages) {
    if (m.role !== 'user' || m.content == null) continue;
    if (typeof m.content === 'string') parts.push(m.content);
    else for (const p of m.content) { if (p.type === 'text') parts.push(p.text); }
  }
  return parts.join('\n\n');
}

async function generateObservations(
  upstream: UpstreamClient, model: string, problem: string, n: number, signal: AbortSignal,
): Promise<string[]> {
  const resp = await upstream.complete({
    model,
    messages: [{ role: 'user', content: OBSERVATIONS_PROMPT(problem, n) }],
    temperature: 0.7,
    stream: false,
  }, signal);
  const content = resp.choices[0]?.message.content;
  if (typeof content !== 'string') return [];
  return content.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- ') || /^\d+\.\s+/.test(l))
    .map(l => l.replace(/^- |^\d+\.\s+/, '').trim())
    .filter(Boolean);
}

async function generatePlans(
  upstream: UpstreamClient, model: string, problem: string, observations: string[], numPlans: number, signal: AbortSignal,
): Promise<string[]> {
  // Generate diverse plans by sampling at higher temperature with the same prompt.
  // The optillm reference samples subsets of observations; doing that here adds noise
  // without measurable gain when the model already varies under temperature.
  const plans = await Promise.all(Array.from({ length: numPlans }, () => upstream.complete({
    model,
    messages: [{ role: 'user', content: PLAN_PROMPT(problem, observations) }],
    temperature: 0.9,
    stream: false,
  }, signal)));
  return plans
    .map(p => p.choices[0]?.message.content)
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
}

async function sampleWithPlan(
  ctx: TechniqueContext, problem: string, plan: string, temperature: number,
): Promise<ChatResponse> {
  const planMessage: Message = { role: 'user', content: SOLVE_WITH_PLAN_PROMPT(problem, plan) };
  // Preserve any system messages from the original request so persona/instructions still apply.
  const systemMessages = ctx.request.messages.filter(m => m.role === 'system');
  const solveReq: ChatRequest = {
    ...ctx.request,
    messages: [...systemMessages, planMessage],
    temperature,
    n: 1,
    stream: false,
  };
  return ctx.next(solveReq);
}
