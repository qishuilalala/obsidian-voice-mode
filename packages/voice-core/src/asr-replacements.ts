/**
 * Post-ASR text replacement dictionary (zero runtime dependencies, lookbehind-free).
 *
 * Matching rules:
 * - Case-insensitive; longest-match first; single-pass (replacement outputs are not re-matched).
 * - ASCII alphanumeric boundaries require whole-word boundaries (`sina` does not alter `Sinatra`).
 * - Whitespace-insensitive across CJK/Latin transitions and internal spaces.
 */

export interface AsrReplacement {
  /** Misrecognized spellings produced by the ASR recognizer. */
  from: string[]
  /** Desired canonical spelling. */
  to: string
  /**
   * Optional language scope (P1-2): 'zh' | 'en' | 'ja' | 'ko'. Undefined = applies to all
   * languages. Read-aloud filters scoped rules by the sentence language.
   */
  language?: AsrReplacementLanguage
}

/** Supported language scopes for replacement rules. */
export type AsrReplacementLanguage = 'zh' | 'en' | 'ja' | 'ko'

const REPLACEMENT_LANGUAGES: ReadonlyArray<string> = ['zh', 'en', 'ja', 'ko']

export type AsrReplacer = (text: string, countHit?: boolean) => string

export type ValidateReplacementsResult =
  | { ok: true; rules: AsrReplacement[]; bytes: number }
  | { ok: false; error: string; bytes?: number }

/** UTF-8 payload byte limit for serialized replacement tables. */
export const REPLACEMENTS_MAX_PAYLOAD_BYTES = 12000

const UTF8_ENCODER = new TextEncoder()
const ASCII_WORD = /[A-Za-z0-9]/

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Compute serialized UTF-8 byte length of a replacement rule table. */
export function replacementsPayloadBytes(rules: unknown): number {
  return UTF8_ENCODER.encode(JSON.stringify(rules ?? [])).length
}

/** Keep global rules plus rules scoped to the given language (or its prefix, e.g. zh-CN). */
export function filterReplacementsByLanguage(
  rules: ReadonlyArray<AsrReplacement>,
  language: string | undefined,
): AsrReplacement[] {
  const family = (language ?? '').trim().toLowerCase().split('-')[0]
  return rules.filter((rule) => !rule.language || (family.length > 0 && rule.language === family))
}

/** Validate structure and UTF-8 payload size of an untrusted replacement table. */
export function validateReplacements(rules: unknown): ValidateReplacementsResult {
  if (!Array.isArray(rules)) {
    return { ok: false, error: 'replacements must be an array' }
  }

  const normalized: AsrReplacement[] = []
  for (let i = 0; i < rules.length; i++) {
    const item: unknown = rules[i]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, error: `rule[${i}] must be an object` }
    }
    const rawFrom = (item as { from?: unknown }).from
    const rawTo = (item as { to?: unknown }).to
    if (!Array.isArray(rawFrom)) {
      return { ok: false, error: `rule[${i}].from must be an array of strings` }
    }
    if (typeof rawTo !== 'string' || rawTo.trim().length === 0) {
      return { ok: false, error: `rule[${i}].to must be a non-empty string` }
    }
    const from: string[] = []
    for (let j = 0; j < rawFrom.length; j++) {
      const entry: unknown = rawFrom[j]
      if (typeof entry !== 'string') {
        return { ok: false, error: `rule[${i}].from[${j}] must be a string` }
      }
      if (entry.trim().length > 0) from.push(entry)
    }
    if (from.length === 0) {
      return { ok: false, error: `rule[${i}].from must contain at least one non-empty spelling` }
    }
    const rawLanguage = (item as { language?: unknown }).language
    let language: AsrReplacementLanguage | undefined
    if (rawLanguage !== undefined && rawLanguage !== null && rawLanguage !== '') {
      if (typeof rawLanguage !== 'string' || !REPLACEMENT_LANGUAGES.includes(rawLanguage)) {
        return { ok: false, error: `rule[${i}].language must be one of zh/en/ja/ko` }
      }
      language = rawLanguage as AsrReplacementLanguage
    }
    normalized.push({
      from,
      to: rawTo,
      ...(language ? { language } : {}),
    })
  }

  const bytes = replacementsPayloadBytes(normalized)
  if (bytes > REPLACEMENTS_MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: `replacements payload (${bytes} bytes) exceeds limit (${REPLACEMENTS_MAX_PAYLOAD_BYTES} bytes)`,
      bytes,
    }
  }

  return { ok: true, rules: normalized, bytes }
}

interface CompiledPattern {
  pattern: string
  requireLeftBound: boolean
}

function compilePattern(heard: string): CompiledPattern | null {
  const trimmedStr = heard.replace(/\s+/g, ' ').trim()
  const chars = [...trimmedStr]
  if (chars.length === 0) return null

  let body = ''
  let prev = ''
  let spaced = false
  for (const ch of chars) {
    if (ch === ' ') {
      spaced = true
      continue
    }
    if (prev && (spaced || ASCII_WORD.test(prev) !== ASCII_WORD.test(ch))) body += '\\s*'
    body += escapeRegExp(ch)
    prev = ch
    spaced = false
  }

  const first = chars[0]
  const last = chars[chars.length - 1]
  const requireLeftBound = ASCII_WORD.test(first)
  // Right boundary uses standard negative lookahead (ES3-safe, no lookbehind).
  const tail = ASCII_WORD.test(last) ? '(?![A-Za-z0-9])' : ''
  return { pattern: `${body}${tail}`, requireLeftBound }
}

/**
 * Compile a replacement dictionary into a single-pass, lookbehind-free replacer function.
 * Optional `onHit` fires with the winning rule index whenever `countHit` is true.
 */
export function createAsrReplacer(
  rules: readonly AsrReplacement[],
  onHit?: (ruleIndex: number) => void,
): AsrReplacer {
  const entries: Array<{
    pattern: string
    key: string
    to: string
    length: number
    ruleIndex: number
    requireLeftBound: boolean
  }> = []

  rules.forEach((rule, ruleIndex) => {
    if (!rule.to) return
    for (const heard of rule.from) {
      const compiled = compilePattern(heard)
      if (!compiled) continue
      const compact = heard.replace(/\s+/g, '')
      entries.push({
        pattern: compiled.pattern,
        key: compact.toLowerCase(),
        to: rule.to,
        length: [...compact].length,
        ruleIndex,
        requireLeftBound: compiled.requireLeftBound,
      })
    }
  })

  if (entries.length === 0) return (text) => text

  entries.sort((a, b) => b.length - a.length)

  const targets = new Map<string, { to: string; ruleIndex: number; requireLeftBound: boolean }>()
  for (const e of entries) {
    if (!targets.has(e.key)) {
      targets.set(e.key, {
        to: e.to,
        ruleIndex: e.ruleIndex,
        requireLeftBound: e.requireLeftBound,
      })
    }
  }

  const source = entries.map((e) => `(?:${e.pattern})`).join('|')

  return (text, countHit = true) => {
    if (!text) return text
    const regex = new RegExp(source, 'giu')
    let out = ''
    let cursor = 0
    let m: RegExpExecArray | null

    while ((m = regex.exec(text)) !== null) {
      const match = m[0]
      const offset = m.index
      if (match.length === 0) {
        regex.lastIndex = offset + 1
        continue
      }

      const hit = targets.get(match.replace(/\s+/g, '').toLowerCase())
      if (!hit) {
        regex.lastIndex = offset + 1
        continue
      }

      if (hit.requireLeftBound && offset > 0 && ASCII_WORD.test(text[offset - 1])) {
        // Advance by 1 code unit so shorter/non-ASCII-bounded rules starting later can still match.
        regex.lastIndex = offset + 1
        continue
      }

      out += text.slice(cursor, offset) + hit.to
      if (onHit && countHit) onHit(hit.ruleIndex)
      cursor = offset + match.length
      regex.lastIndex = cursor
    }

    return cursor === 0 ? text : out + text.slice(cursor)
  }
}
