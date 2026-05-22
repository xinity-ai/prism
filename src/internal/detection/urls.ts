import type { ChatRequest } from '../../types.ts';
import type { RequestFeatures, TaskSignal } from './types.ts';

// Same pattern the `read-urls` plugin uses; kept in sync intentionally so
// detection and fetching agree on what is and isn't a URL.
const URL_RE = /https?:\/\/[^\s'"<>)\]]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]'"`]+$/;

/**
 * Detect HTTP(S) URLs anywhere in the request's text content.
 *
 * Mirrors the `read-urls` plugin's extraction logic: same regex, same
 * trailing-punctuation trim, same de-duplication. If any URL survives,
 * `match: true`.
 */
export function detectUrls(_request: ChatRequest, features: RequestFeatures): TaskSignal {
  const seen = new Set<string>();
  const urls: string[] = [];
  URL_RE.lastIndex = 0;
  for (const m of features.text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING_PUNCT_RE, '');
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  if (urls.length === 0) {
    return { name: 'urls', match: false, reason: 'no URLs detected' };
  }
  const first = urls[0]!;
  const reason = urls.length === 1
    ? `1 URL: ${first}`
    : `${urls.length} URLs (first: ${first})`;
  return { name: 'urls', match: true, reason, details: { count: urls.length, urls } };
}
