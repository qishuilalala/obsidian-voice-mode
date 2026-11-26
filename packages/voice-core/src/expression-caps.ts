/**
 * Expression capability contract (E1).
 *
 * One source of truth for "what can this TTS engine really express", so host
 * adapters and UI can disclose supported facets and degrade visibly instead of
 * silently dropping emotion/prosody tags.
 *
 * Pure, zero-dependency, browser-safe (no Node APIs).
 */

import { asTtsEngineKind, TTS_ENGINE_KINDS, type TtsEngineKind } from './engine-kind.ts'

/** Facets of expression that a TTS engine may support. */
export const EXPRESSION_FACETS = [
  'voices',
  'rate',
  'pause',
  'whisper',
  'emphasis',
  'laugh',
  'sigh',
  'emotion',
  'instructions',
  'streaming',
  'pitch',
  'volume',
  'spell',
] as const

/** One expression dimension the capability contract can describe (13 facets). */
export type ExpressionFacet = (typeof EXPRESSION_FACETS)[number]

/** How strongly an engine can render emotion. */
/** How an engine can express emotion: not at all, via prompt instructions, or graded styles. */
export type EmotionSupport = 'none' | 'instructions' | 'graded'

/** Semantic degradation behaviour; hosts localize it for their UI. */
/** What happens to an unsupported tag: dropped to plain text, ignored, or manual stop only. */
export type DegradationBehavior = 'plain-text' | 'not-applied' | 'manual-stop'

/** Per-engine expression capability contract (E1): supported facets, voices, limits. */
export interface ExpressionCaps {
  engine: TtsEngineKind
  /** Number of selectable voices; 0 when the engine has no voice choice. */
  voiceCount: number
  supported: readonly ExpressionFacet[]
  /** Native `<break>` upper bound in ms; 0 when pauses are simulated by segment splitting. */
  maxPauseMs: number
  emotion: EmotionSupport
  notes?: string
}

/** Explicit degradation notice for an unsupported tag/facet (never silently dropped). */
export interface ExpressionDegradation {
  facet: ExpressionFacet
  behavior: DegradationBehavior
}

/** Parsed tag analysis for a piece of text against a capability set. */
export interface ExpressionAnalysis {
  supported: ExpressionFacet[]
  degraded: ExpressionDegradation[]
}

/**
 * Capability table. Keep this honest: an engine only claims a facet when the
 * rendered audio actually reflects it. Segment-splitting pause support is still
 * `pause` but with `maxPauseMs: 0` (simulated, native limit unavailable).
 */
export const EXPRESSION_CAPS: Readonly<Record<TtsEngineKind, ExpressionCaps>> = {
  system: {
    engine: 'system',
    voiceCount: 0, // voices depend on the OS/browser; count is not enumerable in core
    supported: ['voices', 'rate', 'pause'],
    maxPauseMs: 0,
    emotion: 'none',
    notes: 'OS/browser speech synthesis: voice list is host-provided; pauses are simulated by segment splitting.',
  },
  'vits-wasm': {
    engine: 'vits-wasm',
    voiceCount: 5,
    supported: ['voices', 'rate', 'pause'],
    maxPauseMs: 0,
    emotion: 'none',
    notes: 'vits-zh-ll: 5 speakers; pauses are simulated by segment splitting.',
  },
  'kokoro-daemon': {
    engine: 'kokoro-daemon',
    voiceCount: 103,
    supported: ['voices', 'rate', 'pause', 'whisper'],
    maxPauseMs: 5000,
    emotion: 'none',
    notes: 'Native <whisper> gain and <break Nms> silence; no emotion conditioning.',
  },
  'openai-compat': {
    engine: 'openai-compat',
    voiceCount: 0, // provider-dependent
    supported: ['voices', 'rate', 'instructions', 'emotion'],
    maxPauseMs: 0,
    emotion: 'instructions',
    notes: 'Provider-dependent; emotion is expressed through natural-language instructions where supported.',
  },
  mimo: {
    engine: 'mimo',
    voiceCount: 9,
    supported: ['voices', 'rate', 'instructions', 'emotion'],
    maxPauseMs: 0,
    emotion: 'instructions',
    notes: 'MiMo TTS: voice list fixed; emotion/speed via natural-language prompts.',
  },
}

/** Resolve caps for any value, falling back to `system` for unknown engines. */
export function getExpressionCaps(engine: unknown): ExpressionCaps {
  return EXPRESSION_CAPS[asTtsEngineKind(engine)]
}

export function supportsFacet(engine: unknown, facet: ExpressionFacet): boolean {
  return getExpressionCaps(engine).supported.includes(facet)
}

/** Requested facets the engine cannot render. */
export function unsupportedFacets(
  engine: unknown,
  requested: readonly ExpressionFacet[],
): ExpressionFacet[] {
  const caps = getExpressionCaps(engine)
  return requested.filter((facet) => !caps.supported.includes(facet))
}

/**
 * Analyze a request against an engine: split into supported facets and
 * semantic degradations. Hosts must surface `degraded` to the user (E1 rule:
 * no silent drops).
 */
export function analyzeExpression(
  engine: unknown,
  requested: readonly ExpressionFacet[],
): ExpressionAnalysis {
  const caps = getExpressionCaps(engine)
  const supported: ExpressionFacet[] = []
  const degraded: ExpressionDegradation[] = []

  for (const facet of requested) {
    if (caps.supported.includes(facet)) {
      supported.push(facet)
      continue
    }
    degraded.push({
      facet,
      behavior: caps.emotion === 'none' && facet === 'emotion' ? 'plain-text' : 'not-applied',
    })
  }

  return { supported, degraded }
}

/** Facets that a host should offer in its UI for a given engine. */
export function selectableFacets(engine: unknown): ExpressionFacet[] {
  return [...getExpressionCaps(engine).supported]
}

/** All engine kinds covered by the capability table (test hook). */
export function coveredEngineKinds(): readonly TtsEngineKind[] {
  return TTS_ENGINE_KINDS
}
