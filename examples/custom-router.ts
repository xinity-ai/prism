/**
 * Custom router — plug a user-supplied `Router` into `createGateway`. Forward
 * compat check for the v0.2 router contract: nothing in `@xinity/prism` itself
 * has to change for a separate package (e.g. `@xinity/prism-router-semantic`)
 * to ship its own routing strategy.
 *
 * Run: LLM_BASE_URL=… LLM_API_KEY=… LLM_MODEL_SPECIFIER=… bun run examples/custom-router.ts
 */
import { createGateway, privacy } from '../src/index.ts';
import type { Router, RouterContext, RouterDecision } from '../src/index.ts';
import type { ChatRequest } from '../src/index.ts';

// A trivial custom router: activate privacy iff any message body mentions
// the word "confidential". Demonstrates that any object implementing the
// `Router` interface plugs straight into `createGateway`.
const confidentialRouter: Router = {
  name: 'confidential',
  async decide(request: ChatRequest, _ctx: RouterContext): Promise<RouterDecision> {
    const flagged = request.messages.some(m =>
      typeof m.content === 'string' && m.content.toLowerCase().includes('confidential'),
    );
    return {
      plugins: flagged ? [privacy()] : [],
      techniques: [],
      signals: [],
      rationale: flagged
        ? [{ target: 'privacy', rule: 'confidential-keyword', reason: 'message body mentions "confidential"' }]
        : [],
    };
  },
};

const gateway = createGateway({
  upstream: { baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY! },
  router: confidentialRouter,
});

const { url } = await gateway.serve({ port: 4000 });
console.log(`gateway listening on ${url} — send xinity.auto:'plugins' to opt in.`);
