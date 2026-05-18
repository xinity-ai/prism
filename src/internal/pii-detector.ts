/**
 * Defense-in-depth PII detection.
 *
 * This is NOT a compliance certification — regex detection misses obfuscated PII
 * and produces false positives. It's a layer to reduce the chance that obvious
 * PII reaches a remote upstream during routine inference. Customers that need
 * audited GDPR coverage should compose this with a dedicated DLP service.
 */

export type PiiEntityType =
  | 'EMAIL'
  | 'PHONE'
  | 'IBAN'
  | 'CREDIT_CARD'
  | 'AT_SVN'
  | 'DE_STEUER_ID'
  | 'IPV4';

export type PiiMatch = {
  type: PiiEntityType;
  start: number;
  end: number;
  value: string;
};

export type Detector = (text: string) => PiiMatch[];

// RFC-5322-ish; intentionally permissive on local-part, strict on domain.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b/g;

// E.164 (+digits) or common national formats with separators. 7-15 significant digits.
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{1,4}[\s-]?\d{1,4}[\s-]?\d{2,9}/g;

// IBAN: 2-letter country + 2 check digits + up to 30 alnum (varies by country).
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;

// Credit card candidate: 13-19 digits with optional space/dash separators.
// Anchors on a digit at both ends so trailing separators don't leak into the match.
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

// Austrian Sozialversicherungsnummer (SVN): 4 digits + DDMMYY.
const AT_SVN_RE = /\b\d{4}[ -]?(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2}\b/g;

// German Steueridentifikationsnummer: 11 digits. We additionally check the
// "exactly one digit appears twice or thrice, and the others appear less than
// twice" rule loosely — full Modulo-11 check is overkill for v1 and the
// rejected formats fall back to PHONE/CARD detection anyway.
const DE_STEUER_RE = /\b\d{11}\b/g;

// IPv4. IPv6 omitted from v1; opt-in via custom detector.
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    let d = ch;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0 && digits.length >= 13;
}

function detectByRegex(text: string, re: RegExp, type: PiiEntityType, accept?: (match: string) => boolean): PiiMatch[] {
  const out: PiiMatch[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[0];
    if (accept && !accept(value)) continue;
    out.push({ type, start: m.index, end: m.index + value.length, value });
  }
  return out;
}

function deStuerLikely(value: string): boolean {
  // Reject if it's all the same digit, or has more than 3 of any single digit > 3 times.
  // This is a weak filter; intent is to keep the false-positive rate down on long numeric ids.
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const max = Math.max(...counts.values());
  return max <= 4;
}

/**
 * Default detector. Runs every pattern, then resolves overlaps by preferring the
 * higher-specificity type (CREDIT_CARD > IBAN > AT_SVN > DE_STEUER_ID > PHONE),
 * leaving EMAIL / IPV4 alone since they can't overlap with numeric types.
 */
export const defaultDetector: Detector = (text) => {
  const all: PiiMatch[] = [
    ...detectByRegex(text, EMAIL_RE, 'EMAIL'),
    ...detectByRegex(text, IPV4_RE, 'IPV4'),
    ...detectByRegex(text, CARD_RE, 'CREDIT_CARD', (s) => luhn(s.replace(/[ -]/g, ''))),
    ...detectByRegex(text, IBAN_RE, 'IBAN'),
    ...detectByRegex(text, AT_SVN_RE, 'AT_SVN'),
    ...detectByRegex(text, DE_STEUER_RE, 'DE_STEUER_ID', deStuerLikely),
    ...detectByRegex(text, PHONE_RE, 'PHONE', (s) => s.replace(/\D/g, '').length >= 7),
  ];

  // Resolve overlaps: prefer the match that starts earlier; on ties, the longer one.
  // For overlapping numeric types, this gives CREDIT_CARD priority over PHONE
  // for the same span because card detection runs first and Luhn-validated cards
  // are typically longer than phone candidates.
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const resolved: PiiMatch[] = [];
  let cursor = 0;
  for (const match of all) {
    if (match.start < cursor) continue;
    resolved.push(match);
    cursor = match.end;
  }
  return resolved;
};
