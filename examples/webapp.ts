/**
 * Comparison webapp — pure upstream vs. prism-proxied side-by-side.
 *
 * Run with:
 *   bun run examples/webapp.ts
 *
 * Then open http://localhost:4100 in a browser. Loads LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL_SPECIFIER from .env.
 */
import {
  createHttpUpstreamClient,
  pipelineRun,
  selfConsistency,
  bestOfN,
  roundTrip,
  planSearch,
  memory,
  deepConf,
  privacy,
  readUrls,
  regexVerifier,
  rulesRouter,
  defaultRules,
  verifierRegistry,
  createJsonLogger,
  resolveModelProfile,
} from '../src/index.ts';
import type {
  ChatRequest,
  Logger,
  ModelProfile,
  Technique,
  Transform,
} from '../src/index.ts';

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL_SPECIFIER;
if (!baseUrl || !apiKey || !model) {
  console.error('Set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL_SPECIFIER in .env.');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4100);

const upstream = createHttpUpstreamClient({ baseUrl, apiKey, timeoutMs: 180_000 });
const logger = createJsonLogger({ component: 'webapp' });

const modelProfiles: ModelProfile[] = [
  { match: /qwen3|deepseek-r1|thinking/i, thinkingMode: true, supportsLogprobs: false, contextWindow: 32_000 },
  { match: /.*/, thinkingMode: false, supportsLogprobs: false },
];

const techniqueFactory: Record<string, () => Technique> = {
  'self-consistency': () => selfConsistency({}),
  'round-trip':       () => roundTrip({}),
  'plan-search':      () => planSearch({}),
  'memory':           () => memory({}),
  'deep-conf':        () => deepConf({ mode: 'offline' }),
  'best-of-n':        () => bestOfN({ n: 3, verifier: regexVerifier({ pattern: /.+/ }) }),
};

const pluginFactory: Record<string, () => Transform> = {
  'privacy':   () => privacy(),
  'read-urls': () => readUrls(),
};

// unit-test verifier needs a runner+tests; pair-with-verifier is optional for
// the plan-search rule, so an empty registry is fine here.
const verifiers = verifierRegistry({});
const router = rulesRouter([...defaultRules]);

// ----------------------------------------------------------------------------
// Comparison handlers
// ----------------------------------------------------------------------------

type CompareBody = {
  prompt: string;
  mode: string;         // 'auto' | technique name | 'plugin:<name>'
  effortBudget?: number;
};

async function callPureUpstream(prompt: string, signal: AbortSignal): Promise<
  { ok: true; content: string; ms: number } | { ok: false; error: string }
> {
  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey!}`,
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      signal,
    });
    const ms = Math.round(performance.now() - start);
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `upstream ${res.status}: ${text.slice(0, 500)}` };
    }
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { ok: true, content: j.choices?.[0]?.message?.content ?? '', ms };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

type TraceEntry = { level: 'info' | 'warn' | 'error'; event: Record<string, unknown> };

function captureLogger(into: TraceEntry[]): Logger {
  const make = (): Logger => ({
    info: (event) => { into.push({ level: 'info', event }); logger.info(event); },
    warn: (event) => { into.push({ level: 'warn', event }); logger.warn(event); },
    error: (event) => {
      const e = event instanceof Error ? { error: event.message } : event;
      into.push({ level: 'error', event: e });
      logger.error(event);
    },
    child: () => make(),
  });
  return make();
}

async function callPrism(prompt: string, mode: string, effortBudget: number | undefined, signal: AbortSignal): Promise<
  { ok: true; content: string; ms: number; techniques: string[]; plugins: string[]; routerReason?: string; trace: TraceEntry[] }
  | { ok: false; error: string; trace: TraceEntry[] }
> {
  const start = performance.now();
  const trace: TraceEntry[] = [];
  const reqLogger = captureLogger(trace);
  const request: ChatRequest = {
    model: model!,
    messages: [{ role: 'user', content: prompt }],
  };
  const modelProfile = resolveModelProfile(model!, modelProfiles);

  let techniques: Technique[] = [];
  let transforms: Transform[] = [];
  let routerReason: string | undefined;

  try {
    if (mode === 'auto') {
      // Run the rule-based router for technique selection.
      const decision = await router.decide(request, {
        modelProfile,
        ...(effortBudget !== undefined && { effortBudget }),
        signal,
        logger: reqLogger,
        verifiers,
      });
      techniques = [...decision.techniques];
      routerReason = decision.reason;
      // Auto-activate the three core plugins based on their shouldActivate.
      for (const [name, factory] of Object.entries(pluginFactory)) {
        const t = factory();
        if (!t.shouldActivate || t.shouldActivate(request, modelProfile)) {
          transforms.push(t);
        }
      }
    } else if (mode.startsWith('plugin:')) {
      const name = mode.slice('plugin:'.length);
      const factory = pluginFactory[name];
      if (!factory) return { ok: false, error: `unknown plugin: ${name}`, trace };
      transforms = [factory()];
    } else {
      const factory = techniqueFactory[mode];
      if (!factory) return { ok: false, error: `unknown technique: ${mode}`, trace };
      techniques = [factory()];
    }
  } catch (err) {
    return { ok: false, error: `setup: ${(err as Error).message}`, trace };
  }

  try {
    const response = await pipelineRun({
      request,
      techniques,
      transforms,
      upstream,
      modelProfile,
      logger: reqLogger,
      signal,
    });
    const ms = Math.round(performance.now() - start);
    const raw = response.choices[0]?.message.content;
    const content = typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map(p => p.type === 'text' ? p.text : '').join('')
        : '';
    return {
      ok: true,
      content,
      ms,
      techniques: techniques.map(t => t.name),
      plugins: transforms.map(t => t.name),
      ...(routerReason !== undefined && { routerReason }),
      trace,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message, trace };
  }
}

// ----------------------------------------------------------------------------
// HTML
// ----------------------------------------------------------------------------

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Prism — pure vs. proxy</title>
  <style>
    :root {
      --bg: #0e1116;
      --panel: #161b22;
      --border: #2a313a;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #7aa2f7;
      --err: #f85149;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header.top { padding: 14px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 16px; }
    header.top h1 { font-size: 16px; margin: 0; font-weight: 600; }
    header.top .model { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
    main { padding: 24px; max-width: 1400px; margin: 0 auto; }
    .controls { display: grid; grid-template-columns: 1fr 260px 140px auto; gap: 12px; margin-bottom: 16px; align-items: end; }
    label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    textarea, select, input, button {
      background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px;
      padding: 10px 12px; font: inherit; outline: none; width: 100%;
    }
    textarea { resize: vertical; min-height: 90px; font-family: ui-monospace, monospace; font-size: 13px; }
    button { background: var(--accent); color: #0e1116; font-weight: 600; cursor: pointer; border-color: transparent; padding: 10px 18px; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .panes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .pane { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; min-height: 320px; }
    .pane-head { padding: 10px 14px; background: #11161d; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .pane-head strong { font-size: 13px; }
    .pane-head .meta { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; }
    .pane .body { padding: 14px; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 13px; line-height: 1.6; flex: 1; overflow: auto; }
    .pane .body.empty { color: var(--muted); font-style: italic; }
    .pane .body.err { color: var(--err); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 14px; border-top: 1px solid var(--border); background: #11161d; font-size: 11px; min-height: 36px; align-items: center; }
    .chip { background: #2a313a; color: var(--text); padding: 3px 8px; border-radius: 999px; font-family: ui-monospace, monospace; }
    .chip.tech { background: #1f3a52; color: #9cc3ff; }
    .chip.plug { background: #2c2347; color: #c4b1ff; }
    .reason { color: var(--muted); font-size: 11px; padding: 6px 14px 10px; border-top: 1px solid var(--border); background: #11161d; font-family: ui-monospace, monospace; }
    details.trace { border-top: 1px solid var(--border); background: #11161d; font-size: 11px; font-family: ui-monospace, monospace; }
    details.trace > summary { padding: 8px 14px; cursor: pointer; color: var(--muted); user-select: none; }
    details.trace > summary:hover { color: var(--text); }
    details.trace pre { margin: 0; padding: 10px 14px 14px; max-height: 280px; overflow: auto; color: var(--text); }
    .trace-line { white-space: pre; }
    .trace-line .ev { color: #9cc3ff; }
    .trace-line .warn { color: #f0c674; }
    .trace-line .err { color: var(--err); }
    .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--muted); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <header class="top">
    <h1>Prism — pure vs. proxy</h1>
    <span class="model" id="modelName"></span>
  </header>
  <main>
    <div class="controls">
      <div>
        <label for="prompt">Prompt</label>
        <textarea id="prompt" placeholder="Enter a prompt...">A farmer has 17 sheep. All but 9 run away. How many remain?</textarea>
      </div>
      <div>
        <label for="mode">Prism mode</label>
        <select id="mode">
          <optgroup label="Routing">
            <option value="auto">auto — rules router + auto plugins</option>
          </optgroup>
          <optgroup label="Techniques (forced)">
            <option value="self-consistency">self-consistency (k=5)</option>
            <option value="best-of-n">best-of-n (n=3, permissive)</option>
            <option value="round-trip">round-trip</option>
            <option value="plan-search">plan-search</option>
            <option value="memory">memory</option>
            <option value="deep-conf">deep-conf (offline)</option>
          </optgroup>
          <optgroup label="Plugins (transforms)">
            <option value="plugin:privacy">privacy</option>
            <option value="plugin:read-urls">read-urls</option>
          </optgroup>
        </select>
      </div>
      <div>
        <label for="effort">effortBudget</label>
        <input id="effort" type="number" min="0" max="1" step="0.1" value="0.6" />
      </div>
      <div>
        <button id="run">Run</button>
      </div>
    </div>

    <div class="panes">
      <section class="pane">
        <div class="pane-head"><strong>Pure Qwen (direct upstream)</strong><span class="meta" id="pureMeta">—</span></div>
        <div class="body empty" id="pureBody">Awaiting run.</div>
        <div class="chips" id="pureChips"></div>
      </section>
      <section class="pane">
        <div class="pane-head"><strong>Prism (proxied)</strong><span class="meta" id="prismMeta">—</span></div>
        <div class="body empty" id="prismBody">Awaiting run.</div>
        <div class="chips" id="prismChips"></div>
        <div class="reason" id="prismReason" style="display:none"></div>
        <details class="trace" id="prismTraceWrap" style="display:none">
          <summary>Trace (router decisions, vote distribution, technique events)</summary>
          <pre id="prismTrace"></pre>
        </details>
      </section>
    </div>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    fetch('/api/info').then(r => r.json()).then(j => $('modelName').textContent = j.model + ' @ ' + j.upstream);

    async function run() {
      const prompt = $('prompt').value.trim();
      if (!prompt) return;
      const mode = $('mode').value;
      const effortBudget = Number($('effort').value);
      const btn = $('run');
      btn.disabled = true;
      $('pureBody').className = 'body empty'; $('pureBody').innerHTML = '<span class="spinner"></span>running...';
      $('prismBody').className = 'body empty'; $('prismBody').innerHTML = '<span class="spinner"></span>running...';
      $('pureMeta').textContent = '—'; $('prismMeta').textContent = '—';
      $('pureChips').innerHTML = ''; $('prismChips').innerHTML = '';
      $('prismReason').style.display = 'none'; $('prismReason').textContent = '';
      $('prismTraceWrap').style.display = 'none'; $('prismTrace').innerHTML = '';

      try {
        const res = await fetch('/api/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, mode, effortBudget }),
        });
        const data = await res.json();
        renderPane('pure', data.pure);
        renderPane('prism', data.prism);
        if (data.prism.ok) {
          const chips = [];
          for (const t of (data.prism.techniques || [])) chips.push('<span class="chip tech">technique: ' + t + '</span>');
          for (const p of (data.prism.plugins || [])) chips.push('<span class="chip plug">plugin: ' + p + '</span>');
          if (chips.length === 0) chips.push('<span class="chip">pass-through</span>');
          $('prismChips').innerHTML = chips.join('');
          if (data.prism.routerReason) {
            $('prismReason').textContent = 'router: ' + data.prism.routerReason;
            $('prismReason').style.display = 'block';
          }
        }
        const trace = data.prism.trace || [];
        if (trace.length) {
          const interesting = trace.filter(t => {
            const ev = t.event.event;
            if (typeof ev !== 'string') return false;
            return ev === 'router.decision' || ev === 'router.bypassed' || ev === 'router.fallback'
              || ev === 'plugin.auto-activated' || ev === 'plugin.auto-skipped'
              || ev === 'self-consistency.vote' || ev === 'best-of-n.scores' || ev === 'round-trip.score'
              || ev === 'plan-search.plans' || ev === 'memory.chunks' || ev === 'deep-conf.kept'
              || ev.startsWith('xinity.') || t.level !== 'info';
          });
          const lines = (interesting.length ? interesting : trace).map(t => {
            const cls = t.level === 'warn' ? 'warn' : t.level === 'error' ? 'err' : 'ev';
            const ev = t.event.event ?? '(event)';
            const rest = { ...t.event };
            delete rest.event;
            return '<div class="trace-line"><span class="' + cls + '">' + escapeHtml(String(ev)) + '</span> ' + escapeHtml(JSON.stringify(rest)) + '</div>';
          });
          $('prismTrace').innerHTML = lines.join('');
          $('prismTraceWrap').style.display = 'block';
        }
        $('pureChips').innerHTML = '<span class="chip">direct upstream</span>';
      } catch (e) {
        $('pureBody').className = 'body err'; $('pureBody').textContent = 'fetch failed: ' + e.message;
        $('prismBody').className = 'body err'; $('prismBody').textContent = 'fetch failed: ' + e.message;
      } finally {
        btn.disabled = false;
      }
    }

    function renderPane(which, result) {
      const meta = $(which + 'Meta');
      const body = $(which + 'Body');
      if (result.ok) {
        body.className = 'body';
        body.textContent = result.content || '(empty)';
        meta.textContent = result.ms + ' ms';
      } else {
        body.className = 'body err';
        body.textContent = result.error;
        meta.textContent = 'error';
      }
    }

    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    $('run').addEventListener('click', run);
    $('prompt').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run(); });
  </script>
</body>
</html>`;

// ----------------------------------------------------------------------------
// Bun.serve
// ----------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      return Response.json({ model, upstream: baseUrl });
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      let body: CompareBody;
      try {
        body = await req.json() as CompareBody;
      } catch {
        return Response.json({ error: 'invalid json' }, { status: 400 });
      }
      if (!body.prompt || typeof body.prompt !== 'string') {
        return Response.json({ error: 'prompt required' }, { status: 400 });
      }
      const mode = body.mode ?? 'auto';
      const ac = new AbortController();
      req.signal.addEventListener('abort', () => ac.abort(), { once: true });
      const [pure, prism] = await Promise.all([
        callPureUpstream(body.prompt, ac.signal),
        callPrism(body.prompt, mode, body.effortBudget, ac.signal),
      ]);
      return Response.json({ pure, prism });
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`webapp listening on http://localhost:${server.port}`);
console.log(`  upstream: ${baseUrl}`);
console.log(`  model:    ${model}`);

const shutdown = async () => {
  await server.stop();
  if (router.close) await router.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
