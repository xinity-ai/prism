import { htmlToText } from '../internal/html-to-text.ts';
import type { FetchLike } from '../upstream.ts';
import type { ChatRequest, Message, Transform } from '../types.ts';

export type ReadUrlsOptions = {
  maxBytes?: number;
  maxUrls?: number;
  fetchTimeoutMs?: number;
  userAgent?: string;
  /** Inject a custom fetch impl. Tests use this. */
  fetchImpl?: FetchLike;
};

type FetchedDoc = {
  url: string;
  status: 'ok' | 'error';
  contentType?: string;
  text?: string;
  error?: string;
};

const URL_RE = /https?:\/\/[^\s'"<>)\]]+/g;
const SUPPORTED_TEXT_MIMES = [
  'text/html', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/xml', 'text/xml', 'application/xhtml+xml',
];

export function readUrls(options: ReadUrlsOptions = {}): Transform {
  const maxBytes = options.maxBytes ?? 1_000_000;
  const maxUrls = options.maxUrls ?? 5;
  const timeoutMs = options.fetchTimeoutMs ?? 10_000;
  const userAgent = options.userAgent ?? '@xinity/prism readurls/0.1';
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: 'read-urls',
    async pre(request, state) {
      const urls = extractUrls(request.messages).slice(0, maxUrls);
      if (urls.length === 0) return request;

      const fetched = await Promise.all(urls.map(u => fetchAndExtract(u, {
        maxBytes, timeoutMs, userAgent, fetchImpl, signal: state.signal,
      })));

      const ok = fetched.filter(f => f.status === 'ok');
      state.logger.info({ event: 'read-urls.fetched', urls: urls.length, ok: ok.length });
      if (ok.length === 0) return request;

      const contextMessage: Message = {
        role: 'system',
        content: formatContext(ok),
      };
      return { ...request, messages: [contextMessage, ...request.messages] };
    },
  };
}

function extractUrls(messages: Message[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    if (m.content == null) continue;
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.map(p => p.type === 'text' ? p.text : '').join('\n');
    URL_RE.lastIndex = 0;
    for (const match of text.matchAll(URL_RE)) {
      const url = trimTrailingPunct(match[0]);
      if (!seen.has(url)) { seen.add(url); out.push(url); }
    }
  }
  return out;
}

function trimTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)\]'"`]+$/, '');
}

async function fetchAndExtract(
  url: string,
  opts: {
    maxBytes: number;
    timeoutMs: number;
    userAgent: string;
    fetchImpl: FetchLike;
    signal: AbortSignal;
  },
): Promise<FetchedDoc> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const abortListener = () => controller.abort();
  opts.signal.addEventListener('abort', abortListener, { once: true });
  try {
    const response = await opts.fetchImpl(url, {
      headers: { 'User-Agent': opts.userAgent, Accept: SUPPORTED_TEXT_MIMES.join(', ') },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      return { url, status: 'error', error: `HTTP ${response.status}` };
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!SUPPORTED_TEXT_MIMES.some(m => contentType.includes(m))) {
      return { url, status: 'error', contentType, error: `unsupported content-type: ${contentType || 'unknown'}` };
    }
    const text = await readWithCap(response, opts.maxBytes);
    const extracted = contentType.includes('html') || contentType.includes('xhtml') ? htmlToText(text) : text;
    return { url, status: 'ok', contentType, text: extracted };
  } catch (err) {
    return { url, status: 'error', error: (err as Error).message ?? String(err) };
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', abortListener);
  }
}

async function readWithCap(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        accumulated += decoder.decode(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))), { stream: false });
        await reader.cancel();
        break;
      }
      accumulated += decoder.decode(value, { stream: true });
    }
    accumulated += decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return accumulated;
}

function formatContext(docs: FetchedDoc[]): string {
  const sections = docs.map(d => `--- ${d.url} ---\n${d.text ?? ''}`.trim());
  return [
    'The following web pages were fetched from URLs mentioned in the conversation. Use them as context for your answer:',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

export const __internal = { extractUrls, htmlToText, trimTrailingPunct };
