import { describe, expect, test } from 'bun:test';
import { memory } from '../../src/techniques/memory.ts';
import { chunkText, approximateTokens } from '../../src/internal/chunking.ts';
import { pipelineRun } from '../../src/pipeline.ts';
import { silentLogger } from '../../src/logging.ts';
import { createMockUpstream, fakeResponse } from '../../src/internal/mock-upstream.ts';
import type { ChatRequest, ModelProfile } from '../../src/types.ts';

const tinyProfile: ModelProfile = { match: /.*/, thinkingMode: false, supportsLogprobs: false, contextWindow: 4000 };

describe('chunkText', () => {
  test('returns the input unchanged when it fits', () => {
    expect(chunkText('short text', { chunkTokens: 100 })).toEqual(['short text']);
  });

  test('splits at paragraph boundaries when available', () => {
    const text = 'A'.repeat(100) + '\n\n' + 'B'.repeat(100) + '\n\n' + 'C'.repeat(100);
    const chunks = chunkText(text, { chunkTokens: 30, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should contain at most one paragraph's content given the chunk size.
    expect(chunks[0]!.length).toBeLessThan(text.length);
  });

  test('applies overlap between chunks', () => {
    const text = 'word '.repeat(500);
    const chunks = chunkText(text, { chunkTokens: 50, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // The end of chunk[0] should appear at the start of chunk[1].
    const tail = chunks[0]!.slice(-20);
    expect(chunks[1]!.startsWith(tail.slice(-10))).toBe(true);
  });
});

describe('memory technique', () => {
  test('passes through when the document fits within the context budget', async () => {
    let marginCalls = 0;
    const upstream = createMockUpstream({
      complete: async (r) => {
        if (r.messages.length === 2 && typeof r.messages[0]?.content === 'string' && r.messages[0].content.startsWith('Extract')) {
          marginCalls += 1;
        }
        return fakeResponse('answer');
      },
    });
    const shortDoc = 'A small document.';
    const req: ChatRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: shortDoc },
        { role: 'user', content: 'What is the main point?' },
      ],
    };
    await pipelineRun({
      request: req,
      techniques: [memory()],
      transforms: [],
      upstream,
      modelProfile: tinyProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });
    expect(marginCalls).toBe(0);
    expect(upstream.completeCalls).toHaveLength(1);
  });

  test('chunks long docs, calls upstream per chunk, keeps YES# margins and synthesizes', async () => {
    // Document larger than threshold * contextWindow (0.7 * 4000 = 2800 tokens ≈ 11200 chars).
    const longDoc = 'paragraph A about apples. '.repeat(800) + '\n\n' + 'paragraph B about bananas. '.repeat(800);
    expect(approximateTokens(longDoc)).toBeGreaterThan(2800);

    let marginCallCount = 0;
    let synthesisCall = '';
    const upstream = createMockUpstream({
      complete: async (r) => {
        const system = r.messages.find(m => m.role === 'system');
        if (typeof system?.content === 'string' && system.content.startsWith('Extract')) {
          marginCallCount += 1;
          // Alternate YES/NO so we exercise both code paths.
          return fakeResponse(marginCallCount % 2 === 0 ? 'NO#' : `YES#fact ${marginCallCount}`);
        }
        const userText = r.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
        synthesisCall = userText;
        return fakeResponse('apples');
      },
    });
    const req: ChatRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: longDoc },
        { role: 'user', content: 'What is the main point?' },
      ],
    };
    const result = await pipelineRun({
      request: req,
      techniques: [memory({ chunkTokens: 500, overlapTokens: 20 })],
      transforms: [],
      upstream,
      modelProfile: tinyProfile,
      logger: silentLogger,
      signal: new AbortController().signal,
    });

    expect(marginCallCount).toBeGreaterThan(1);
    expect(synthesisCall).toContain('margin notes');
    expect(synthesisCall).toContain('fact 1');
    expect(result.choices[0]!.message.content).toBe('apples');
  });
});
