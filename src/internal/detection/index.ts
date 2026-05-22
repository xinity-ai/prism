import type { ChatRequest } from '../../types.ts';
import { extractFeatures } from './features.ts';
import { detectPii, type DetectPiiOptions } from './pii.ts';
import { detectUrls } from './urls.ts';
import { detectContextOverflow, type DetectContextOverflowOptions } from './context-overflow.ts';
import type { RequestFeatures, TaskSignal } from './types.ts';

export { extractFeatures } from './features.ts';
export { detectPii } from './pii.ts';
export { detectUrls } from './urls.ts';
export { detectContextOverflow } from './context-overflow.ts';
export type { TaskSignal, RequestFeatures } from './types.ts';
export type { DetectPiiOptions } from './pii.ts';
export type { DetectContextOverflowOptions } from './context-overflow.ts';

export type DetectAllOptions = {
  pii?: DetectPiiOptions;
  contextOverflow?: DetectContextOverflowOptions;
};

/**
 * Run every detector against a request and return all signals — both firing
 * and non-firing. Callers (the rules router) typically `.filter(s => s.match)`
 * to pick winners; downstream consumers (the future semantic router) read
 * every signal as a classifier feature.
 */
export function detectAll(
  request: ChatRequest,
  features: RequestFeatures = extractFeatures(request),
  options: DetectAllOptions = {},
): TaskSignal[] {
  return [
    detectPii(request, features, options.pii ?? {}),
    detectUrls(request, features),
    detectContextOverflow(request, features, options.contextOverflow ?? {}),
  ];
}
