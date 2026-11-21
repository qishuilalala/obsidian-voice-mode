/**
 * Secret redaction for error messages and diagnostic logs.
 *
 * Redaction always runs before truncation over a generous prefix window so long
 * or truncated secrets spanning the snippet boundary are masked completely.
 */

const PREFIXED: ReadonlyArray<{ re: RegExp; to: string }> = [
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1<redacted>' },
  { re: /\b(Basic\s+)[A-Za-z0-9+/=-]{8,}/gi, to: '$1<redacted>' },
  { re: /\b((?:api[-_]?key|x-api-key)\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1<redacted>' },
  { re: /(https?:\/\/)([^:@/\s]+:[^@/\s]+)(@)/gi, to: '$1<redacted>$3' },
  { re: /([?&](?:api[_-]?key|access_token|token|key)=)([^&\s#]+)/gi, to: '$1<redacted>' },
  // Matches both complete JSON string values and values truncated before the closing quote.
  {
    re: /("(?:[a-zA-Z0-9_-]*?(?:api[_-]?key|token|secret|password))"\s*:\s*")([^"\\]{6,})("|$)/gi,
    to: '$1<redacted>$3',
  },
]

const BARE: ReadonlyArray<RegExp> = [
  /\bsk-(?:proj|live|test|ant)-[A-Za-z0-9._-]{8,}/g,
  /\bsk[-_][A-Za-z0-9._-]{8,}/g,
  /\bgsk_[A-Za-z0-9._-]{8,}/g,
  /\brk_(?:live|test)_[A-Za-z0-9._-]{8,}/g,
  /\bAIza[A-Za-z0-9._-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9_]{10,}/g,
  // Mixed-case + digit high-entropy token (>=20 chars); excludes 64-hex SHA256 digests and '/' paths.
  /\b(?![0-9a-fA-F]{64}\b)(?=[A-Za-z0-9+=_-]*[A-Z])(?=[A-Za-z0-9+=_-]*[a-z])(?=[A-Za-z0-9+=_-]*[0-9])[A-Za-z0-9+=_-]{20,}\b/g,
  // 32-hex keys (MD5-shaped secrets); 64-hex SHA256 digests remain intact.
  /\b[0-9a-f]{32}\b/gi,
]

/** Replace secret-like values with `<redacted>` while keeping model slugs, paths, and SHA256 digests intact. */
export function redactSecrets(text: unknown): string {
  let out = typeof text === 'string' ? text : String(text ?? '')
  for (const { re, to } of PREFIXED) out = out.replace(re, to)
  for (const re of BARE) out = out.replace(re, '<redacted>')
  return out
}

/** Redact an HTTP response body over a generous window before truncating to at most `maxLength` characters. */
export function redactBodySnippet(body: unknown, maxLength = 200): string {
  const raw = typeof body === 'string' ? body : String(body ?? '')
  if (maxLength <= 0) return ''
  const preWindow = Math.max(maxLength * 4, 2048)
  return redactSecrets(raw.slice(0, preWindow)).slice(0, maxLength)
}
