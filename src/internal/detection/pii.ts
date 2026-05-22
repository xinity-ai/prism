import { defaultDetector, type Detector, type PiiEntityType } from '../pii-detector.ts';
import type { ChatRequest } from '../../types.ts';
import type { RequestFeatures, TaskSignal } from './types.ts';

export type DetectPiiOptions = {
  /** Override the regex-based detector. Defaults to {@link defaultDetector}. */
  detector?: Detector;
};

/**
 * Detect personally identifying information in the request's text content.
 *
 * Thin wrapper around the existing `pii-detector` that converts the list of
 * regex matches into a {@link TaskSignal}. Binary outcome — if any match
 * survives overlap resolution, `match: true`.
 */
export function detectPii(
  _request: ChatRequest,
  features: RequestFeatures,
  options: DetectPiiOptions = {},
): TaskSignal {
  const detect = options.detector ?? defaultDetector;
  const matches = detect(features.text);
  if (matches.length === 0) {
    return { name: 'pii', match: false, reason: 'no PII detected' };
  }
  const counts = new Map<PiiEntityType, number>();
  for (const m of matches) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([type, count]) => count > 1 ? `${count}×${type.toLowerCase()}` : type.toLowerCase())
    .join(', ');
  return {
    name: 'pii',
    match: true,
    reason: `${matches.length === 1 ? '1 entity' : `${matches.length} entities`} detected: ${summary}`,
    details: { count: matches.length, types: Object.fromEntries(counts) },
  };
}
