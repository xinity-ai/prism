import { defaultDetector, type Detector, type PiiEntityType, type PiiMatch } from '../internal/pii-detector.ts';
import type { ChatChunk, ChatRequest, ChatResponse, Message, Transform, TransformState } from '../types.ts';

function containsPii(messages: readonly Message[], detect: Detector): boolean {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (m.content == null) continue;
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.map(p => (p.type === 'text' ? p.text : '')).join('\n');
    if (text && detect(text).length > 0) return true;
  }
  return false;
}

export type PrivacyOptions = {
  /** Override the default regex-based detector. */
  detector?: Detector;
  /** Override the placeholder format. Default: `[XINITY_PII_<TYPE>_<INDEX>]` */
  placeholder?: (type: PiiEntityType, index: number) => string;
};

type Mapping = {
  /** placeholder string -> original value */
  toOriginal: Map<string, string>;
  /** original value -> placeholder (used for de-dup within a request) */
  fromOriginal: Map<string, string>;
};

const STORE_KEY = 'xinity.privacy.mapping';

export function privacy(options: PrivacyOptions = {}): Transform {
  const detect = options.detector ?? defaultDetector;
  const placeholder = options.placeholder ?? defaultPlaceholder;

  return {
    name: 'privacy',

    shouldActivate(request) {
      return containsPii(request.messages, detect);
    },

    async pre(request, state) {
      const mapping = ensureMapping(state);
      const counters = new Map<PiiEntityType, number>();
      const newMessages = request.messages.map(m => redactMessage(m, detect, mapping, counters, placeholder));
      return { ...request, messages: newMessages };
    },

    async post(response, state) {
      const mapping = stateMapping(state);
      if (!mapping) return response;
      return restoreResponse(response, mapping);
    },

    async postChunk(chunk, state) {
      const mapping = stateMapping(state);
      if (!mapping) return chunk;
      return restoreChunk(chunk, mapping);
    },
  };
}

function defaultPlaceholder(type: PiiEntityType, index: number): string {
  return `[XINITY_PII_${type}_${index}]`;
}

function ensureMapping(state: TransformState): Mapping {
  let m = state.store.get(STORE_KEY) as Mapping | undefined;
  if (!m) {
    m = { toOriginal: new Map(), fromOriginal: new Map() };
    state.store.set(STORE_KEY, m);
  }
  return m;
}

function stateMapping(state: TransformState): Mapping | undefined {
  return state.store.get(STORE_KEY) as Mapping | undefined;
}

function redactMessage(
  m: Message,
  detect: Detector,
  mapping: Mapping,
  counters: Map<PiiEntityType, number>,
  placeholder: (t: PiiEntityType, i: number) => string,
): Message {
  if (m.content == null) return m;
  if (typeof m.content === 'string') {
    return { ...m, content: redactString(m.content, detect, mapping, counters, placeholder) };
  }
  const parts = m.content.map(part => {
    if (part.type === 'text') {
      return { ...part, text: redactString(part.text, detect, mapping, counters, placeholder) };
    }
    return part;
  });
  return { ...m, content: parts };
}

function redactString(
  text: string,
  detect: Detector,
  mapping: Mapping,
  counters: Map<PiiEntityType, number>,
  placeholder: (t: PiiEntityType, i: number) => string,
): string {
  const matches = detect(text);
  if (matches.length === 0) return text;
  matches.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start);
    out += placeholderFor(match, mapping, counters, placeholder);
    cursor = match.end;
  }
  out += text.slice(cursor);
  return out;
}

function placeholderFor(
  match: PiiMatch,
  mapping: Mapping,
  counters: Map<PiiEntityType, number>,
  placeholder: (t: PiiEntityType, i: number) => string,
): string {
  const existing = mapping.fromOriginal.get(match.value);
  if (existing) return existing;
  const index = counters.get(match.type) ?? 0;
  counters.set(match.type, index + 1);
  const token = placeholder(match.type, index);
  mapping.toOriginal.set(token, match.value);
  mapping.fromOriginal.set(match.value, token);
  return token;
}

function restoreResponse(response: ChatResponse, mapping: Mapping): ChatResponse {
  return {
    ...response,
    choices: response.choices.map(c => ({
      ...c,
      message: {
        ...c.message,
        content: restoreContent(c.message.content, mapping),
      },
    })),
  };
}

function restoreChunk(chunk: ChatChunk, mapping: Mapping): ChatChunk {
  return {
    ...chunk,
    choices: chunk.choices.map(c => ({
      ...c,
      delta: c.delta.content != null
        ? { ...c.delta, content: restoreText(c.delta.content, mapping) }
        : c.delta,
    })),
  };
}

function restoreContent(content: Message['content'], mapping: Mapping): Message['content'] {
  if (content == null) return content;
  if (typeof content === 'string') return restoreText(content, mapping);
  return content.map(part => part.type === 'text' ? { ...part, text: restoreText(part.text, mapping) } : part);
}

function restoreText(text: string, mapping: Mapping): string {
  // Straight string replace per placeholder. Placeholders are unique tokens,
  // so a linear scan over the (typically small) mapping is fine.
  let out = text;
  for (const [placeholder, original] of mapping.toOriginal) {
    if (out.includes(placeholder)) {
      out = out.split(placeholder).join(original);
    }
  }
  return out;
}

// Internal re-exports for tests that want to drive the redactor directly.
export const __internal = { redactString, restoreText };

// Help the type system: ChatRequest is referenced in the public signature.
export type { ChatRequest, ChatResponse, ChatChunk };
