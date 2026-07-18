import { describe, expect, test } from 'bun:test';
import {
  estimateTokens,
  hasUrlsInMessages,
  looksLikeCodeGeneration,
  looksLikeSummary,
  looksLikeTranslation,
} from '../../src/internal/detection.ts';
import type { ChatRequest, Message } from '../../src/types.ts';

const req = (content: string, messages: Message[] = []): ChatRequest => ({
  model: 'm',
  messages: messages.length > 0 ? messages : [{ role: 'user', content }],
});

// =============================================================================
// estimateTokens — sanity
// =============================================================================

describe('estimateTokens', () => {
  test('counts all message roles', () => {
    const r: ChatRequest = {
      model: 'm',
      messages: [
        { role: 'system', content: 'aaaa' }, // 1 token
        { role: 'user', content: 'bbbbbbbb' }, // 2 tokens
        { role: 'assistant', content: 'cc' }, // 1 token (ceil)
      ],
    };
    // Joined: "aaaa\nbbbbbbbb\ncc" = 16 chars → 4 tokens
    expect(estimateTokens(r)).toBe(4);
  });

  test('handles structured ContentPart arrays', () => {
    const r: ChatRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' },
          ],
        },
      ],
    };
    // "hello\nworld" = 11 chars → 3 tokens
    expect(estimateTokens(r)).toBe(3);
  });

  test('empty request', () => {
    expect(estimateTokens(req(''))).toBe(0);
  });
});

// =============================================================================
// hasUrlsInMessages
// =============================================================================

describe('hasUrlsInMessages', () => {
  test('detects http URL', () => {
    expect(hasUrlsInMessages([{ role: 'user', content: 'check http://example.com' }])).toBe(true);
  });

  test('detects https URL', () => {
    expect(hasUrlsInMessages([{ role: 'user', content: 'see https://example.com/path' }])).toBe(true);
  });

  test('ignores URLs in system messages', () => {
    expect(hasUrlsInMessages([{ role: 'system', content: 'docs at https://example.com' }])).toBe(false);
  });

  test('no URL', () => {
    expect(hasUrlsInMessages([{ role: 'user', content: 'just text' }])).toBe(false);
  });

  test('handles structured content', () => {
    expect(hasUrlsInMessages([
      { role: 'user', content: [{ type: 'text', text: 'visit https://x.io' }] },
    ])).toBe(true);
  });
});

// =============================================================================
// looksLikeCodeGeneration
// =============================================================================

describe('looksLikeCodeGeneration — positive corpus (10)', () => {
  const positives: { name: string; prompt: string }[] = [
    { name: 'EN write + function', prompt: 'Write a Python function that returns the nth Fibonacci number.' },
    { name: 'EN implement + tree', prompt: 'Implement a binary search tree in Rust.' },
    { name: 'fenced code block', prompt: '```python\ndef foo():\n    pass\n```\nWhat is wrong with this snippet?' },
    { name: 'EN refactor', prompt: 'Refactor this codebase to use async/await throughout.' },
    { name: 'EN debug', prompt: 'Help me debug why my unit tests are failing intermittently.' },
    { name: 'EN optimize', prompt: 'Optimize the following algorithm for better time complexity.' },
    { name: 'DE imperative', prompt: 'Schreibe eine Funktion, die die Fibonacci-Zahlen berechnet.' },
    { name: 'FR imperative', prompt: 'Écris une fonction Python qui trie une liste.' },
    { name: 'IT imperative + noun', prompt: 'Scrivi una classe in Java per gestire utenti.' },
    { name: 'ES imperative + noun', prompt: 'Escribe un programa en bash para listar archivos.' },
  ];
  for (const c of positives) {
    test(c.name, () => expect(looksLikeCodeGeneration(req(c.prompt))).toBe(true));
  }
});

describe('looksLikeCodeGeneration — negative corpus (10)', () => {
  const negatives: { name: string; prompt: string }[] = [
    { name: 'definitional', prompt: 'Explain how recursion works in computer science.' },
    { name: 'what is X', prompt: 'What is a closure?' },
    { name: 'history of lang', prompt: 'Tell me about the history of Python and its creator.' },
    { name: 'paradigm prose', prompt: 'Compare functional and object-oriented programming paradigms.' },
    { name: 'why prose', prompt: 'Why are dynamically typed languages popular among beginners?' },
    { name: 'write a poem', prompt: 'Write a poem about the ocean at sunset.' },
    { name: 'summarize prog article', prompt: 'Summarize this article about software engineering practices.' },
    { name: 'DE translation request', prompt: 'Übersetze diesen Satz ins Englische.' },
    { name: 'FR prose question', prompt: 'Quel est le meilleur livre sur les algorithmes pour débutants?' },
    { name: 'acronym question', prompt: 'What does TCP/IP stand for and why is it important?' },
  ];
  for (const c of negatives) {
    test(c.name, () => expect(looksLikeCodeGeneration(req(c.prompt))).toBe(false));
  }
});

// =============================================================================
// looksLikeTranslation
// =============================================================================

describe('looksLikeTranslation — positive corpus (10)', () => {
  const positives: { name: string; prompt: string }[] = [
    { name: 'EN translate from-to', prompt: 'Translate this paragraph from English to French: the quick brown fox.' },
    { name: 'EN translate the following', prompt: 'Can you translate the following passage into German?' },
    { name: 'EN translate to', prompt: 'Please translate to Spanish: Hello world.' },
    { name: 'DE imperative', prompt: 'Übersetze diesen Satz ins Englische bitte.' },
    { name: 'DE formal', prompt: 'Übersetzen Sie das bitte auf Deutsch.' },
    { name: 'FR imperative', prompt: 'Traduis cette phrase en anglais.' },
    { name: 'FR formal', prompt: 'Traduisez le texte suivant en allemand.' },
    { name: 'IT imperative', prompt: 'Traduci questo testo in inglese.' },
    { name: 'ES imperative', prompt: 'Traduce este texto al inglés.' },
    { name: 'from-to pair only', prompt: 'I want this rendered from Spanish into Portuguese please.' },
  ];
  for (const c of positives) {
    test(c.name, () => expect(looksLikeTranslation(req(c.prompt))).toBe(true));
  }
});

describe('looksLikeTranslation — negative corpus (10)', () => {
  const negatives: { name: string; prompt: string }[] = [
    { name: 'translation noun question', prompt: 'What is the best translation tool for technical documents?' },
    { name: 'translation noun in prose', prompt: 'I read an excellent translation of Don Quixote last summer.' },
    { name: 'DE Übersetzung noun', prompt: 'Übersetzungen sind eine Kunst, die viel Erfahrung erfordert.' },
    { name: 'summarize foreign article', prompt: 'Summarize this French article about climate policy.' },
    { name: 'write code request', prompt: 'Write a Python function that reverses a string.' },
    { name: 'word for X', prompt: 'What is the German word for happy?' },
    { name: 'translation theory', prompt: 'Translation theory is a fascinating academic discipline.' },
    { name: 'history of translation', prompt: 'Tell me about the history of literary translation in Europe.' },
    { name: 'machine translation prose', prompt: 'Explain how machine translation algorithms have evolved.' },
    { name: 'greeting', prompt: 'Hello, how are you doing today?' },
  ];
  for (const c of negatives) {
    test(c.name, () => expect(looksLikeTranslation(req(c.prompt))).toBe(false));
  }
});

// =============================================================================
// looksLikeSummary
// =============================================================================

describe('looksLikeSummary — positive corpus (10)', () => {
  const positives: { name: string; prompt: string }[] = [
    { name: 'EN summarize', prompt: 'Summarize the following article in three sentences.' },
    { name: 'EN summarise (UK)', prompt: 'Can you summarise this PDF for me?' },
    { name: 'TL;DR', prompt: 'TL;DR please: this report is way too long.' },
    { name: 'summary of', prompt: 'Give me a summary of this quarterly report.' },
    { name: 'DE split imperative', prompt: 'Fasse den folgenden Text in drei Sätzen zusammen.' },
    { name: 'DE noun in request', prompt: 'Können Sie eine Zusammenfassung des Berichts erstellen?' },
    { name: 'FR imperative', prompt: 'Résume cet article en quelques phrases courtes.' },
    { name: 'FR noun in request', prompt: 'Fais un résumé du document ci-joint.' },
    { name: 'IT imperative', prompt: 'Riassumi questo testo per favore.' },
    { name: 'ES infinitive', prompt: '¿Puedes resumir este artículo en pocas frases?' },
  ];
  for (const c of positives) {
    test(c.name, () => expect(looksLikeSummary(req(c.prompt))).toBe(true));
  }
});

describe('looksLikeSummary — negative corpus (10)', () => {
  const negatives: { name: string; prompt: string }[] = [
    { name: 'what is summary', prompt: 'What is a summary in academic writing?' },
    { name: 'update my resume', prompt: 'I need to update my resume with my latest role.' },
    { name: 'brief explanation', prompt: 'Give me a brief explanation of TCP congestion control.' },
    { name: 'plot prose', prompt: 'Explain the plot of Don Quixote in detail.' },
    { name: 'translation request', prompt: 'Translate this article from English to French.' },
    { name: 'code request', prompt: 'Write a Python function to compute averages.' },
    { name: 'word for summary', prompt: 'What is the German word for summary?' },
    { name: 'FR generic prose', prompt: 'Ce livre est intéressant mais un peu long à lire.' },
    { name: 'DE zusammen without fass', prompt: 'Wir gehen heute zusammen ins Kino, oder?' },
    { name: 'joke request', prompt: 'Tell me a short joke about computers.' },
  ];
  for (const c of negatives) {
    test(c.name, () => expect(looksLikeSummary(req(c.prompt))).toBe(false));
  }
});
