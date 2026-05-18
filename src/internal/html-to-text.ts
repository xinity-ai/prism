/**
 * Minimal HTML → text extractor.
 *
 * Removes script/style/noscript blocks, strips all other tags, decodes the
 * five XML entities plus &nbsp;, and collapses runs of whitespace. Intentionally
 * not a DOM parser — for v1, this is good enough to give a language model a
 * readable view of typical web pages without pulling in 100KB of dependencies.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? _match;
  });
}

export function htmlToText(html: string): string {
  // Drop script/style/noscript entirely.
  let out = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Replace block-level closers with newlines so paragraphs survive.
  out = out.replace(/<\/(p|div|li|h[1-6]|tr|article|section|header|footer|nav|aside|blockquote|pre)>/gi, '\n');
  out = out.replace(/<br\s*\/?\s*>/gi, '\n');
  // Strip everything else.
  out = out.replace(/<[^>]+>/g, '');
  out = decodeEntities(out);
  // Collapse whitespace: drop tabs, collapse spaces, condense blank-line runs.
  out = out.replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}
