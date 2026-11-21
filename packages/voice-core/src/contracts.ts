/**
 * Cross-host protocol contracts: SecretStore, EndpointPolicy, Model mirror allowlist,
 * AsrTransport, and TtsEngine (strictly Uint8Array / browser-safe, zero Node Buffer).
 */

import type { AsrEngineKind, TtsEngineKind } from './engine-kind.ts'

// ── Secret storage abstraction ───────────────────────────────────────────────

export interface SecretStore {
  getSecret(id: string): Promise<string | null> | string | null
  setSecret(id: string, value: string): Promise<void> | void
  deleteSecret?(id: string): Promise<void> | void
}

// ── Unified VAD / endpointing policy ─────────────────────────────────────────

export interface EndpointPolicy {
  /** Silence duration in ms that ends an utterance (default: 1500). */
  silenceMs: number
  /** Hard utterance cap in seconds, shared across VAD and capture client (default: 60). */
  maxSpeechSec: number
  /** Primary speech detection threshold in [0, 1] (default: 0.5). */
  vadThreshold: number
  /** Early wake / barge-in detection threshold in [0, 1] (default: 0.35). */
  detectVadThreshold: number
}

export const DEFAULT_ENDPOINT_POLICY: Readonly<EndpointPolicy> = {
  silenceMs: 1500,
  maxSpeechSec: 60,
  vadThreshold: 0.5,
  detectVadThreshold: 0.35,
}

export function resolveEndpointPolicy(partial: Partial<EndpointPolicy> = {}): EndpointPolicy {
  const clamp = (val: unknown, min: number, max: number, fallback: number): number => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return fallback
    return Math.min(max, Math.max(min, val))
  }
  return {
    silenceMs: clamp(partial.silenceMs, 200, 10000, DEFAULT_ENDPOINT_POLICY.silenceMs),
    maxSpeechSec: clamp(partial.maxSpeechSec, 5, 300, DEFAULT_ENDPOINT_POLICY.maxSpeechSec),
    vadThreshold: clamp(partial.vadThreshold, 0.05, 0.99, DEFAULT_ENDPOINT_POLICY.vadThreshold),
    detectVadThreshold: clamp(
      partial.detectVadThreshold,
      0.05,
      0.99,
      DEFAULT_ENDPOINT_POLICY.detectVadThreshold,
    ),
  }
}

// ── Model integrity & mirror allowlist ───────────────────────────────────────

export const MODEL_HOST_PRIMARY = 'https://huggingface.co'
export const MODEL_HOST_FALLBACK = 'https://hf-mirror.com'

export const ALLOWED_MODEL_HOSTNAMES = ['huggingface.co', 'hf.co', 'hf-mirror.com'] as const

/** Short connectivity probe timeout (ms) preventing 420s stalls on unreachable mirrors. */
export const MODEL_MIRROR_PROBE_TIMEOUT_MS = 8000

export interface ModelFileSpec {
  /** Pinned upstream revision so SHA256 matches immutable content. */
  revision?: string
  /** Relative path within the model repository. */
  file: string
  /** Expected lowercase hex SHA256 digest. */
  sha256: string
  /** Optional expected file size in bytes for progress UI. */
  bytes?: number
}

/**
 * Validate and normalize a model host origin.
 * Only credential-free HTTPS origins on the allowlist (unless `allowCustomHost` is true) are accepted.
 */
export function validateModelHost(raw: string, allowCustomHost = false): string | null {
  if (!raw || typeof raw !== 'string') return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  const hostname = u.hostname.toLowerCase()
  if (!(ALLOWED_MODEL_HOSTNAMES as readonly string[]).includes(hostname) && !allowCustomHost) {
    return null
  }
  return `${u.protocol}//${hostname}${u.port ? `:${u.port}` : ''}`
}

/**
 * Verify that the final post-redirect URL stays within HTTPS and the allowlisted hosts
 * or their subdomains (such as `cdn-lfs.huggingface.co` or `us.aws.cdn.hf.co`).
 */
export function redirectHostAllowed(finalUrl: string, allowCustomHost = false): boolean {
  try {
    const u = new URL(finalUrl)
    if (u.protocol !== 'https:') return false
    if (u.username || u.password) return false
    const hostname = u.hostname.toLowerCase()
    if (allowCustomHost) return true
    return ALLOWED_MODEL_HOSTNAMES.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    )
  } catch {
    return false
  }
}

/** Guard remote relative model file paths against traversal (`..`, backslashes, NUL bytes). */
export function isSafeModelRel(rel: string, subdir?: string): boolean {
  if (!rel || rel.includes('\\') || rel.includes('\0')) return false
  if (subdir && !rel.startsWith(`${subdir}/`)) return false
  return !rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
}

// ── ASR & TTS engine contracts (Uint8Array / Float32Array) ───────────────────

export interface AsrTranscriptEvent {
  text: string
  isFinal: boolean
  language?: string
  durationMs?: number
}

export interface AsrTransport {
  readonly kind: AsrEngineKind
  start?(options?: {
    language?: string
    policy?: Partial<EndpointPolicy>
    signal?: AbortSignal
  }): Promise<void>
  pushAudio?(pcm16k: Float32Array): void
  finalize?(signal?: AbortSignal): Promise<AsrTranscriptEvent>
  transcribe?(
    pcm16k: Float32Array,
    options?: { sampleRate?: number; language?: string; signal?: AbortSignal },
  ): Promise<AsrTranscriptEvent>
  abort?(): void
  close(): Promise<void>
}

export interface TtsSynthOptions {
  voice?: string
  rate?: number
  signal?: AbortSignal
}

export interface TtsSynthResult {
  /** Encoded audio bytes (WAV, MP3, OGG, etc.) — platform-neutral Uint8Array. */
  audio: Uint8Array
  /** Sniffed or declared audio MIME type. */
  mime: string
  /** Optional output sample rate in Hz. */
  sampleRate?: number
}

export interface TtsEngineStatus {
  engine: TtsEngineKind
  ready: boolean
  loading: boolean
  error?: string
  errorCode?: string
  keyRequired?: boolean
  keyPresent?: boolean
  progress?: { file: string; percent: number }
}

export interface TtsEngine {
  readonly kind: TtsEngineKind
  readonly mime: string
  updateVoice?(voice: string, rate?: number): void
  synthesize(text: string, options?: TtsSynthOptions): Promise<TtsSynthResult>
  interrupt?(): void
  prepare?(): Promise<void>
  status?(): TtsEngineStatus
  close(): Promise<void>
}
