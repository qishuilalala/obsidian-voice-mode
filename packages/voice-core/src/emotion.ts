/**
 * Emotion tag DSL parser and stripper (pure, zero dependencies).
 *
 * Supported tags:
 * - `<break N ms>` -> pause duration attached to the preceding (or first) segment via `preBreakMs`
 * - `<whisper>...</whisper>` -> scoped segment flag `whisper: true` (unbalanced open falls back to `false`)
 * - `<laugh>`, `<sigh>`, `<emphasis>` -> inline markers stripped without reading aloud
 */

export type EmotionTag = 'laugh' | 'sigh' | 'emphasis'

export interface EmotionSegment {
  /** Spoken plain text with emotion tags consumed. */
  text: string
  /** True when the segment lies within a balanced `<whisper>...</whisper>` scope. */
  whisper: boolean
  /** Optional silence break in milliseconds associated with this segment. */
  preBreakMs?: number
}

const EMOTION_TAG_PATTERN =
  '<\\s*(break\\s+(?<ms>\\d+)\\s*ms|whisper|\\/whisper|laugh|sigh|emphasis)\\s*>'

const TAG_RE = new RegExp(EMOTION_TAG_PATTERN, 'gi')
const STRIP_RE = new RegExp(EMOTION_TAG_PATTERN, 'gi')

/** Upper bounds prevent pathological `<break>` values from causing PCM allocation OOM. */
const MAX_BREAK_MS = 5000
const MAX_TOTAL_BREAK_MS = 10000

/**
 * Strip all supported emotion tags, replacing each with a single space so adjacent
 * Latin words never glue together (`a<laugh>b` -> `a b`).
 */
export function stripEmotionTags(raw: string): string {
  return String(raw).replace(STRIP_RE, ' ')
}

/**
 * Parse emotion tags into an ordered list of speech segments.
 * Unbalanced `<whisper>` downgrades all segments to `whisper: false` conservatively.
 */
export function parseEmotionTags(raw: string): EmotionSegment[] {
  const input = String(raw)
  const out: EmotionSegment[] = []
  let buf = ''
  let whisper = false
  let pendingBreakMs = 0
  let totalBreakMs = 0
  let sawInlineTag = false

  const appendText = (chunk: string): void => {
    if (chunk.length === 0) return
    if (sawInlineTag && /[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(chunk)) {
      buf += ' '
    }
    sawInlineTag = false
    buf += chunk
  }

  const flush = (): void => {
    const text = buf.trim()
    buf = ''
    sawInlineTag = false
    if (text.length === 0) return
    out.push({ text, whisper })
  }

  let lastEnd = 0
  for (const m of input.matchAll(TAG_RE)) {
    const idx = m.index ?? 0
    appendText(input.slice(lastEnd, idx))
    lastEnd = idx + m[0].length
    const tag = (m[1] ?? '').toLowerCase().trim()

    if (tag.startsWith('break')) {
      const rawMs = Number(m.groups?.ms ?? 0)
      if (!Number.isFinite(rawMs) || rawMs <= 0) {
        sawInlineTag = true
        continue
      }
      const remaining = Math.max(0, MAX_TOTAL_BREAK_MS - totalBreakMs)
      const ms = Math.min(rawMs, MAX_BREAK_MS, remaining)
      if (ms <= 0) {
        if (buf.trim().length > 0) flush()
        continue
      }
      totalBreakMs += ms
      if (buf.trim().length > 0) {
        flush()
      }
      const last = out[out.length - 1]
      if (last) {
        last.preBreakMs = (last.preBreakMs ?? 0) + ms
      } else {
        pendingBreakMs += ms
      }
    } else if (tag === 'whisper') {
      flush()
      whisper = true
    } else if (tag === '/whisper') {
      flush()
      whisper = false
    } else {
      sawInlineTag = true
    }
  }

  appendText(input.slice(lastEnd))
  flush()

  if (pendingBreakMs > 0) {
    const first = out[0]
    if (first) {
      first.preBreakMs = (first.preBreakMs ?? 0) + pendingBreakMs
    }
    pendingBreakMs = 0
  }

  if (whisper) {
    for (const seg of out) seg.whisper = false
  }

  return out
}
