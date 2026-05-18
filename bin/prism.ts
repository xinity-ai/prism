#!/usr/bin/env bun
import { createGateway } from '../src/index.ts';

const VERSION = '0.1.0';

type Args = {
  port: number;
  hostname: string;
  upstream: string;
  apiKey?: string;
  defaultModel?: string;
};

function usage(): string {
  return [
    'prism — OpenAI-compatible optimizing inference proxy',
    '',
    'Usage:',
    '  prism serve [options]',
    '',
    'Options:',
    '  --port <port>            Port to listen on (default 4000)',
    '  --hostname <host>        Bind address (default 0.0.0.0)',
    '  --upstream <url>         Upstream base URL, e.g. http://localhost:11434/v1',
    '  --api-key <key>          Upstream bearer token',
    '  --model <name>           Default model for clients that omit one (info only — passed through)',
    '  -h, --help               Show this message',
    '  -v, --version            Print version',
    '',
    'Environment variables (loaded from .env automatically by Bun):',
    '  LLM_BASE_URL             Default for --upstream',
    '  LLM_API_KEY              Default for --api-key',
    '  LLM_MODEL_SPECIFIER      Default for --model',
    '  XINITY_PORT              Default for --port',
    '',
    'Examples:',
    '  prism serve --port 4000 --upstream http://localhost:11434/v1',
    '  prism serve                       # uses env vars',
  ].join('\n');
}

function parseArgs(argv: string[]): Args | { help: true } | { version: true } {
  const args: Args = {
    port: Number.parseInt(process.env.XINITY_PORT ?? '4000', 10),
    hostname: '0.0.0.0',
    upstream: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
    ...(process.env.LLM_API_KEY !== undefined && { apiKey: process.env.LLM_API_KEY }),
    ...(process.env.LLM_MODEL_SPECIFIER !== undefined && { defaultModel: process.env.LLM_MODEL_SPECIFIER }),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'serve') continue;
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '-v' || arg === '--version') return { version: true };
    const next = () => {
      const value = argv[++i];
      if (value === undefined) { console.error(`missing value for ${arg}`); process.exit(2); }
      return value;
    };
    if (arg === '--port') { args.port = Number.parseInt(next(), 10); continue; }
    if (arg === '--hostname') { args.hostname = next(); continue; }
    if (arg === '--upstream') { args.upstream = next(); continue; }
    if (arg === '--api-key') { args.apiKey = next(); continue; }
    if (arg === '--model') { args.defaultModel = next(); continue; }
    console.error(`unknown argument: ${arg}\n\n${usage()}`);
    process.exit(2);
  }
  return args;
}

const parsed = parseArgs(process.argv.slice(2));
if ('help' in parsed) { console.log(usage()); process.exit(0); }
if ('version' in parsed) { console.log(VERSION); process.exit(0); }

const gateway = createGateway({
  upstream: {
    baseUrl: parsed.upstream,
    ...(parsed.apiKey !== undefined && { apiKey: parsed.apiKey }),
  },
});

const { url, stop } = await gateway.serve({ port: parsed.port, hostname: parsed.hostname });
console.error(`prism ${VERSION} listening on ${url}`);
console.error(`  upstream: ${parsed.upstream}`);
if (parsed.defaultModel) console.error(`  default model: ${parsed.defaultModel}`);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.error(`\nreceived ${signal}, shutting down…`);
  await stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
