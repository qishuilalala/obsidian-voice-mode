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

export interface EmotionPromptOptions {
  allowWhisper?: boolean
  allowBreaks?: boolean
  maxBreakMs?: number
}

export type EmotionPlanMode = 'pcm-segments' | 'instructions' | 'strip'

export interface CompiledEmotionPlan {
  mode: EmotionPlanMode
  /** Spoken plain text with emotion tags stripped and whitespace normalized. */
  plainText: string
  /** Ordered segments for PCM/neural synthesis or single stripped segment in `strip` mode. */
  segments: EmotionSegment[]
  /** Natural-language prosody instruction when `mode === 'instructions'` (empty otherwise). */
  instructions: string
  /** True when any supported emotion or break tag appeared in `raw`. */
  hasEmotionCues: boolean
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

const DEFAULT_PROMPT_MAX_BREAK_MS = 1500
const INLINE_CUE_RE = /<\s*(laugh|sigh|emphasis)\s*>/gi
const ANY_EMOTION_CUE_RE = new RegExp(EMOTION_TAG_PATTERN, 'i')

/**
 * Build a concise system-prompt instruction guiding an LLM to emit natural spoken prose
 * with optional balanced `<whisper>...</whisper>` and `<break 300ms>` tags, free of Markdown noise.
 */
export function buildEmotionPromptInstruction(options: EmotionPromptOptions = {}): string {
  const allowWhisper = options.allowWhisper ?? true
  const allowBreaks = options.allowBreaks ?? true
  const rawMax = options.maxBreakMs ?? DEFAULT_PROMPT_MAX_BREAK_MS
  const maxBreakMs =
    typeof rawMax === 'number' && Number.isFinite(rawMax)
      ? Math.min(MAX_BREAK_MS, Math.max(100, Math.round(rawMax)))
      : DEFAULT_PROMPT_MAX_BREAK_MS

  const parts = [
    'Write natural spoken dialogue without Markdown formatting, bullet symbols, code fences, or stage-direction asterisks.',
  ]
  if (allowWhisper) {
    parts.push(
      'For hushed or confidential phrases, wrap the phrase in balanced <whisper>...</whisper> tags and always close </whisper>.',
    )
  }
  if (allowBreaks) {
    parts.push(
      `For natural hesitation or dramatic beats, insert <break 300ms> (up to <break ${maxBreakMs}ms>).`,
    )
  }
  if (allowWhisper || allowBreaks) {
    parts.push('Use inline cues (<laugh>, <sigh>, <emphasis>) sparingly; never invent unsupported tags.')
  }
  return parts.join(' ')
}

/**
 * Compile raw emotion-tagged text into an execution plan tailored to the target TTS family:
 * - `'pcm-segments'`: segmented `whisper` / `preBreakMs` slices for local VITS / Kokoro synthesis
 * - `'instructions'`: clean `plainText` plus natural-language prosody `instructions` for cloud TTS
 * - `'strip'`: clean `plainText` for plain system `speechSynthesis`
 */
export function compileEmotionPlan(raw: string, mode: EmotionPlanMode): CompiledEmotionPlan {
  const input = String(raw)
  const plainText = stripEmotionTags(input).replace(/\s+/g, ' ').trim()
  const hasEmotionCues = ANY_EMOTION_CUE_RE.test(input)

  if (mode === 'strip') {
    return {
      mode,
      plainText,
      segments: plainText ? [{ text: plainText, whisper: false }] : [],
      instructions: '',
      hasEmotionCues,
    }
  }

  const segments = parseEmotionTags(input)
  if (mode === 'pcm-segments' || !hasEmotionCues) {
    return {
      mode,
      plainText,
      segments,
      instructions: '',
      hasEmotionCues,
    }
  }

  const hints: string[] = []
  if (segments.some((seg) => seg.whisper)) {
    hints.push('deliver hushed phrases in a soft whisper')
  }
  if (segments.some((seg) => (seg.preBreakMs ?? 0) > 0)) {
    hints.push('leave natural measured pauses between thoughts')
  }

  const inlineSet = new Set<string>()
  for (const match of input.matchAll(INLINE_CUE_RE)) {
    const cue = (match[1] ?? '').toLowerCase()
    if (cue) inlineSet.add(cue)
  }
  if (inlineSet.has('laugh')) hints.push('include a light natural laugh')
  if (inlineSet.has('sigh')) hints.push('include a gentle sigh')
  if (inlineSet.has('emphasis')) hints.push('place clear vocal emphasis on key words')

  return {
    mode,
    plainText,
    segments,
    instructions: hints.length > 0 ? `Speak naturally: ${hints.join(', ')}.` : '',
    hasEmotionCues,
  }
}
