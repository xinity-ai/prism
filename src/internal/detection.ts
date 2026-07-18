/**
 * Prompt-shape detection helpers for the rule-based router.
 *
 * Each helper is a pure, synchronous, regex-based predicate over the user-role
 * messages of a ChatRequest. They are deliberately small and honest: regexes
 * cover the obvious cases multilingually (EN, DE, FR, IT, ES) and the test
 * corpus in `tests/unit/detection.test.ts` documents the edge cases.
 *
 * If you change a regex, run the corpus. Don't add helpers without a corpus.
 */

import { approximateTokens } from './chunking.ts';
import type { ChatRequest, Message } from '../types.ts';

// =============================================================================
// Generic text extraction
// =============================================================================

function messageText(m: Message): string {
  if (m.content == null) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.map(p => (p.type === 'text' ? p.text : '')).join('\n');
}

function userText(messages: readonly Message[]): string {
  // Concatenate user-role messages. System prompts often contain boilerplate
  // (PII rules, JSON instructions) that would create false positives.
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push(messageText(m));
  }
  return out.join('\n');
}

function allText(messages: readonly Message[]): string {
  return messages.map(messageText).join('\n');
}

// =============================================================================
// estimateTokens — request-level wrapper around approximateTokens
// =============================================================================

/**
 * Approximate total tokens in a ChatRequest, counting all message content
 * (user + system + assistant + tool). Uses `approximateTokens` (length / 4).
 * Used by the router's `memory-for-long-input` rule.
 */
export function estimateTokens(request: ChatRequest): number {
  return approximateTokens(allText(request.messages));
}

// =============================================================================
// hasUrlsInMessages — light URL presence check
// =============================================================================

// Matches http(s) URLs. Same shape as the regex in src/plugins/read-urls.ts;
// kept separate so detection.ts has no dependency on plugin internals.
const URL_RE = /https?:\/\/[^\s'"<>)\]]+/i;

/**
 * True if any user-role message contains an http(s) URL.
 * Used by the auto-activation predicate for the read-urls plugin.
 */
export function hasUrlsInMessages(messages: readonly Message[]): boolean {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (URL_RE.test(messageText(m))) return true;
  }
  return false;
}

// =============================================================================
// looksLikeCodeGeneration
// =============================================================================

// A fenced code block with a language tag (``` followed by an ASCII letter)
// strongly signals code work — either the user is including code or wants code
// in that language back.
const FENCED_CODE_RE = /```[a-zA-Z]/;

// Imperative coding verbs (English) that are unambiguous on their own.
// "refactor", "debug", "optimize/optimise" rarely appear outside coding context.
const CODE_VERBS_EN_STRONG = /\b(refactor|refactors?|refactored|refactoring|debug|debugs|debugged|debugging|optimi[sz]e|optimi[sz]es|optimi[sz]ed|optimi[sz]ing)\b/i;

// Imperative verbs that need a code-noun nearby to confirm code intent.
// "write a poem" must NOT trigger; "write a function" must.
const CODE_VERB_PLUS_NOUN_EN = /\b(write|writes|wrote|writing|create|creates|created|creating|build|builds|built|building|fix|fixes|fixed|fixing|implement|implements|implemented|implementing)\b[\s\S]{0,40}?\b(function|functions|class|classes|method|methods|script|scripts|program|programs|module|modules|component|components|endpoint|endpoints|api|algorithm|algorithms|regex|loop|loops|snippet|snippets|code|query|queries|test|tests|cli|parser|parsers|server|servers|handler|handlers|controller|controllers|route|routes)\b/i;

// "in <programming language>" / "using <prog lang>" / "as a <prog lang> ...".
// Programming language list — only includes names unlikely to be ambiguous in
// natural prose. Bare "go", "java", "c", "r", "d" are NOT included on purpose;
// "python" / "rust" / "typescript" etc. carry the signal.
const PROG_LANG_SOURCE =
  'python|typescript|javascript|rust|golang|kotlin|scala|haskell|ruby|swift|c\\+\\+|c#|csharp|cpp|sql|bash|powershell|html|css|node\\.js|nodejs|react|vue|svelte|django|flask|fastapi';
const IN_PROG_LANG_RE = new RegExp(
  String.raw`\b(in|using|with|as\s+(?:a|an))\s+(?:${PROG_LANG_SOURCE})\b`,
  'i',
);

// "convert to <prog lang>" / "port to <prog lang>" / "translate to <prog lang>"
// (last one disambiguates from natural-language translation by requiring a
// programming-language target).
const CONVERT_TO_PROG_LANG_RE = new RegExp(
  String.raw`\b(convert|port|translate|rewrite|migrate)\b[\s\S]{0,30}?\b(?:to|into)\s+(?:${PROG_LANG_SOURCE})\b`,
  'i',
);

// Unicode-aware word boundaries. JS `\b` only sees ASCII word chars, so
// "Übersetze" / "Écris" / "résumé" fail with `\b` at the non-ASCII edge.
// These lookarounds treat any Unicode letter/digit/underscore as a word char.
const UWB_L = '(?<![\\p{L}\\p{N}_])';
const UWB_R = '(?![\\p{L}\\p{N}_])';

// Multilingual code verbs (DE/FR/IT/ES).
// Each language's pattern requires either an imperative verb alone (the verb is
// already a strong code signal in that language) or a verb + code noun.
const CODE_VERBS_DE = new RegExp(
  `${UWB_L}(schreibe?|implementiere|refaktoriere|refaktorisiere|debugge|optimiere|programmiere)${UWB_R}`,
  'iu',
);
const CODE_VERBS_FR = new RegExp(
  `${UWB_L}(écris|écrire|écrivez|implémente|implémenter|implémentez|refactorise|refactoriser|refactorisez|déboguer|optimise|optimiser|optimisez)${UWB_R}`,
  'iu',
);
const CODE_VERBS_IT = new RegExp(
  `${UWB_L}(scrivi|scrivere|implementa|implementare|ottimizza|ottimizzare|rifattorizza|rifattorizzare)${UWB_R}`,
  'iu',
);
const CODE_VERBS_ES = new RegExp(
  `${UWB_L}(escribe|escribir|implementa|implementar|optimiza|optimizar|refactoriza|refactorizar|depura|depurar|programa\\s+un[ao]?)${UWB_R}`,
  'iu',
);

// Code nouns in each language — used to confirm ambiguous verbs (e.g., FR
// "écris" alone is strong, but Spanish "escribe" alone could mean "write a
// letter"; pairing with a code noun adds precision).
const CODE_NOUNS_MULTI = new RegExp(
  `${UWB_L}(funktion|funktionen|klasse|klassen|skript|skripte|programm|programme|fonction|fonctions|classe|classes|méthode|méthodes|script|scripts|funzione|funzioni|classi|metodo|metodi|programma|programmi|función|funciones|clase|clases|método|métodos|programa|programas|algoritmo|algoritmos)${UWB_R}`,
  'iu',
);

/**
 * True if the request looks like a code-generation / code-modification task.
 *
 * Positive signals:
 *   - Fenced code block with a language tag (```python, ```ts, etc.)
 *   - Unambiguous English coding verbs: refactor, debug, optimize
 *   - English verb + code noun: "write a function", "implement a class"
 *   - "in/using <programming language>" patterns
 *   - "convert/port/migrate to <prog lang>" patterns
 *   - Multilingual coding verbs (DE/FR/IT/ES), optionally with code noun
 *
 * Negative cases that intentionally do NOT trigger:
 *   - "explain how recursion works" (no verb, no fence, no prog-lang prefix)
 *   - "what is a closure" (definitional question)
 *   - "tell me about the history of Python" (Python mentioned but not as
 *     "in/using Python")
 *   - "write a poem about Python" (write + non-code-noun)
 */
export function looksLikeCodeGeneration(request: ChatRequest): boolean {
  const text = userText(request.messages);
  if (!text) return false;

  if (FENCED_CODE_RE.test(text)) return true;
  if (CODE_VERBS_EN_STRONG.test(text)) return true;
  if (CODE_VERB_PLUS_NOUN_EN.test(text)) return true;
  if (IN_PROG_LANG_RE.test(text)) return true;
  if (CONVERT_TO_PROG_LANG_RE.test(text)) return true;

  // Multilingual: strong verbs alone in DE/FR are coding-specific enough
  // ("implementiere", "refactorise", "déboguer", etc.). The ambiguous verbs
  // ("scrivi", "escribe") need a code noun nearby.
  if (CODE_VERBS_DE.test(text)) return true;
  if (CODE_VERBS_FR.test(text)) return true;

  // IT/ES verbs are ambiguous between code and prose — require a code noun
  // OR a prog-lang reference somewhere in the text.
  const itEsVerb = CODE_VERBS_IT.test(text) || CODE_VERBS_ES.test(text);
  if (itEsVerb && (CODE_NOUNS_MULTI.test(text) || IN_PROG_LANG_RE.test(text))) {
    return true;
  }

  return false;
}

// =============================================================================
// looksLikeTranslation
// =============================================================================

// Verb forms only — noun forms (translation, traduction, traducción, Übersetzung)
// are excluded so "what is the best translation tool?" doesn't trigger.
//
// Per language:
//   EN: translate, translates, translated, translating
//   DE: übersetze, übersetzt, übersetzen, übersetz (imperative stem)
//   FR: traduis, traduisez, traduire, traduit, traduits
//   IT: traduci, tradurre, traduce (also matches ES; fine)
//   ES: traduce, traducir, traduzca, traduce
const TRANSLATE_VERB_RE = new RegExp(
  `${UWB_L}(translat(?:e|es|ed|ing)|überset[zs](?:e|en|t|st)|traduis(?:ez|e|ent)?|traduire|traduit|traduits|traduci|tradurre|traduce|traducir|traduzca)${UWB_R}`,
  'iu',
);

// Natural-language names, for "from X to Y" pair detection.
const NATURAL_LANG =
  'english|german|french|spanish|italian|portuguese|dutch|polish|russian|chinese|japanese|korean|arabic|hebrew|hindi|turkish|swedish|norwegian|danish|finnish|greek|czech|romanian|bulgarian|hungarian|ukrainian|deutsch|englisch|französisch|spanisch|italienisch|portugiesisch|anglais|allemand|espagnol|italien|inglés|alemán|francés|español|italiano|inglese|tedesco|francese|spagnolo|italiano';
const FROM_TO_LANG_RE = new RegExp(
  String.raw`\bfrom\s+(?:${NATURAL_LANG})\s+(?:to|into)\s+(?:${NATURAL_LANG})\b`,
  'i',
);

/**
 * True if the request looks like a translation task.
 *
 * Positive signals:
 *   - Imperative verb forms of "translate" (EN/DE/FR/IT/ES)
 *   - "from <natural language> to <natural language>" patterns
 *
 * Negative cases that intentionally do NOT trigger:
 *   - "What is the best translation tool?" (noun form excluded)
 *   - "I read a translation of Don Quixote." (noun form excluded)
 *   - "Translation theory is fascinating." (noun)
 *   - "What's the German word for 'happy'?" (mentions a language, no verb)
 */
export function looksLikeTranslation(request: ChatRequest): boolean {
  const text = userText(request.messages);
  if (!text) return false;

  if (TRANSLATE_VERB_RE.test(text)) return true;
  if (FROM_TO_LANG_RE.test(text)) return true;

  return false;
}

// =============================================================================
// looksLikeSummary
// =============================================================================

// Imperative/verb forms; avoid bare nouns ("summary", "résumé", "resumen")
// that frequently appear in unrelated prose ("update my resume", "what is a
// summary"). The DE multi-word imperative "fass(e) ... zusammen" needs a
// short-window scan because the two tokens are separated by content.
const SUMMARY_VERB_RE = new RegExp(
  `${UWB_L}(summari[sz]e|summari[sz]es|summari[sz]ed|summari[sz]ing|tl;?dr|zusammenfassen|zusammenfassung|zusammenfassungen|résume|résumer|résumez|résumé|résumés|riassumi|riassumere|riassunto|riassunti|resumir|resúmeme|resúmenos|resumirme)${UWB_R}`,
  'iu',
);

// German split-verb imperative: "fasse den Text zusammen", "fass das bitte
// zusammen". Allow up to ~120 characters between "fass(e)" and "zusammen" to
// catch realistic separations without matching unrelated sentences that happen
// to contain both words.
const DE_FASS_ZUSAMMEN_RE = /\bfasse?\b[^.!?\n]{0,120}\bzusammen\b/i;

// "Summary of <X>" / "a summary of" — noun form, but the "of" prepositional
// completion strongly signals a summarization request rather than reference to
// "the summary" as an artifact.
const SUMMARY_OF_RE = /\b(a |the )?\b(summary|summaries)\s+of\b/i;

/**
 * True if the request looks like a summarization task.
 *
 * Positive signals:
 *   - Verb forms: summarize, summarise, summarizing (EN); résume(r/z) (FR);
 *     riassumi/riassumere (IT); resumir (ES); zusammenfassen / Zusammenfassung
 *     (DE noun OK here — used only in request context); TL;DR
 *   - DE split imperative: "fass(e) ... zusammen"
 *   - "summary of <X>" noun-phrase request
 *
 * Negative cases that intentionally do NOT trigger:
 *   - "What is a summary?" (bare noun)
 *   - "I need to update my resume." (EN noun "resume", not matched)
 *   - "Translate this French article." (translation, not summary)
 */
export function looksLikeSummary(request: ChatRequest): boolean {
  const text = userText(request.messages);
  if (!text) return false;

  if (SUMMARY_VERB_RE.test(text)) return true;
  if (SUMMARY_OF_RE.test(text)) return true;
  if (DE_FASS_ZUSAMMEN_RE.test(text)) return true;

  return false;
}
