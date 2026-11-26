/**
 * Emotion tag DSL parser and stripper (pure, zero dependencies).
 *
 * Supported tags:
 * - `<break N ms>` -> pause duration attached to the preceding (or first) segment via `preBreakMs`
 * - `<whisper>...</whisper>` -> scoped segment flag `whisper: true` (unbalanced open falls back to `false`)
 * - `<laugh>`, `<sigh>`, `<emphasis>` -> inline markers stripped without reading aloud
 */

export type EmotionTag = 'laugh' | 'sigh' | 'emphasis'

/** Scoped prosody/emotion names accepted by `<emotion:NAME>...</emotion>`. */
export const EMOTION_NAMES = [
  'neutral',
  'gentle',
  'happy',
  'sad',
  'angry',
  'excited',
  'tender',
  'serious',
  'playful',
  'nervous',
] as const

export type EmotionName = (typeof EMOTION_NAMES)[number]

export interface EmotionSegment {
  /** Spoken plain text with emotion tags consumed. */
  text: string
  /** True when the segment lies within a balanced `<whisper>...</whisper>` scope. */
  whisper: boolean
  /** Optional silence break in milliseconds associated with this segment. */
  preBreakMs?: number
  /** `<slow>...</slow>` scope. */
  slow?: boolean
  /** `<fast>...</fast>` scope. */
  fast?: boolean
  /** `<spell>...</spell>` scope (letter-by-letter reading). */
  spell?: boolean
  /** `<volume N>...</volume>` scope, clamped to [0, 2]. */
  volume?: number
  /** `<pitch N>...</pitch>` scope in semitones, clamped to [-12, 12]. */
  pitch?: number
  /** `<emotion:NAME>...</emotion>` scope. */
  emotion?: EmotionName
}

export interface EmotionPromptOptions {
  allowWhisper?: boolean
  allowBreaks?: boolean
  maxBreakMs?: number
  allowRoleplayNarration?: boolean
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
  '<\\s*(break\\s+(?<ms>\\d+)\\s*ms|whisper|\\/whisper|slow|\\/slow|fast|\\/fast|spell|\\/spell|volume\\s+(?<volume>\\d+(?:\\.\\d+)?)|\\/volume|pitch\\s+(?<pitch>-?\\d+)|\\/pitch|emotion\\s*:\\s*(?<emotion>[a-z][a-z_-]*)|\\/emotion|laugh|sigh|emphasis)\\s*>'

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
 * Unbalanced scopes downgrade conservatively (their flags are dropped) instead of throwing.
 */
export function parseEmotionTags(raw: string): EmotionSegment[] {
  const input = String(raw)
  const out: EmotionSegment[] = []
  let buf = ''
  let whisper = false
  let slow = false
  let fast = false
  let spell = false
  let volume: number | undefined
  let pitch: number | undefined
  let emotion: EmotionName | undefined
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
    const seg: EmotionSegment = { text, whisper }
    if (slow) seg.slow = true
    if (fast) seg.fast = true
    if (spell) seg.spell = true
    if (volume !== undefined) seg.volume = volume
    if (pitch !== undefined) seg.pitch = pitch
    if (emotion) seg.emotion = emotion
    out.push(seg)
  }

  const clampVolume = (value: number): number => Math.min(2, Math.max(0, value))
  const clampPitch = (value: number): number => Math.min(12, Math.max(-12, value))

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
      if (buf.trim().length > 0) flush()
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
    } else if (tag === 'slow') {
      flush()
      slow = true
      fast = false
    } else if (tag === '/slow') {
      flush()
      slow = false
    } else if (tag === 'fast') {
      flush()
      fast = true
      slow = false
    } else if (tag === '/fast') {
      flush()
      fast = false
    } else if (tag === 'spell') {
      flush()
      spell = true
    } else if (tag === '/spell') {
      flush()
      spell = false
    } else if (tag.startsWith('volume')) {
      const raw = Number(m.groups?.volume ?? NaN)
      if (!Number.isFinite(raw)) {
        sawInlineTag = true
        continue
      }
      flush()
      volume = clampVolume(raw)
    } else if (tag === '/volume') {
      flush()
      volume = undefined
    } else if (tag.startsWith('pitch')) {
      const raw = Number(m.groups?.pitch ?? NaN)
      if (!Number.isFinite(raw)) {
        sawInlineTag = true
        continue
      }
      flush()
      pitch = clampPitch(raw)
    } else if (tag === '/pitch') {
      flush()
      pitch = undefined
    } else if (tag.startsWith('emotion')) {
      const name = (m.groups?.emotion ?? '').toLowerCase()
      flush()
      emotion = (EMOTION_NAMES as readonly string[]).includes(name)
        ? (name as EmotionName)
        : undefined
    } else if (tag === '/emotion') {
      flush()
      emotion = undefined
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

  // Unbalanced scopes downgrade conservatively: drop their flags entirely.
  if (whisper) for (const seg of out) seg.whisper = false
  if (slow) for (const seg of out) delete seg.slow
  if (fast) for (const seg of out) delete seg.fast
  if (spell) for (const seg of out) delete seg.spell
  if (volume !== undefined) for (const seg of out) delete seg.volume
  if (pitch !== undefined) for (const seg of out) delete seg.pitch
  if (emotion) for (const seg of out) delete seg.emotion

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
  const allowRoleplayNarration = options.allowRoleplayNarration ?? false
  const rawMax = options.maxBreakMs ?? DEFAULT_PROMPT_MAX_BREAK_MS
  const maxBreakMs =
    typeof rawMax === 'number' && Number.isFinite(rawMax)
      ? Math.min(MAX_BREAK_MS, Math.max(100, Math.round(rawMax)))
      : DEFAULT_PROMPT_MAX_BREAK_MS

  const parts = [
    allowRoleplayNarration
      ? 'Write natural spoken dialogue without Markdown code fences or bullet lists; apply emotion tags only to spoken dialogue.'
      : 'Write natural spoken dialogue without Markdown formatting, bullet symbols, code fences, or stage-direction asterisks.',
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
    parts.push('Optional scoped cues: <slow>...</slow>, <fast>...</fast>, <spell>...</spell>, <volume 0.5>...</volume>, <pitch -2>...</pitch>, <emotion:gentle>...</emotion>; always close them.')
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
  if (segments.some((seg) => seg.slow)) {
    hints.push('slow the delivery for marked phrases')
  }
  if (segments.some((seg) => seg.fast)) {
    hints.push('quicken the pace for marked phrases')
  }
  if (segments.some((seg) => seg.spell)) {
    hints.push('spell out marked words letter by letter')
  }
  if (segments.some((seg) => seg.volume !== undefined)) {
    hints.push('adjust vocal loudness where marked')
  }
  if (segments.some((seg) => seg.pitch !== undefined)) {
    hints.push('shift pitch where marked')
  }
  const emotionNames = [
    ...new Set(segments.map((seg) => seg.emotion).filter((name): name is EmotionName => !!name)),
  ]
  if (emotionNames.length > 0) {
    hints.push(`convey the marked emotion (${emotionNames.join(', ')})`)
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
