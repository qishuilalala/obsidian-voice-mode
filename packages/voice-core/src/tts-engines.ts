/**
 * Cloud & self-hosted HTTP TTS engines (`OpenAiCompatTtsEngine` and `MimoTtsEngine`),
 * magic-byte audio MIME sniffer, and pure ES2022 strict base64 decoder.
 *
 * Host-agnostic and zero-dependency: uses only standard ES2022 + Uint8Array / fetch / Web Streams.
 */

import type { TtsEngine, TtsEngineStatus, TtsSynthOptions, TtsSynthResult } from './contracts.ts'
import { stripEmotionTags } from './emotion.ts'
import {
  cancelTimeout,
  raceAbort,
  readBoundedStreamBytes,
  readRedactedHttpErrorMessage,
  resolveFetchImpl,
  resolveSecretValue,
  scheduleTimeout,
  type SecretValueProvider,
} from './http-stream.ts'
import { validateEndpointUrl } from './llm-router.ts'
import { redactSecrets } from './redact.ts'
import {
  MIMO_DEFAULT_BASE_URL,
  MIMO_DEFAULT_MODEL,
  MIMO_DEFAULT_VOICE,
  TTS_OPENAI_PRESETS,
  resolveTtsOpenAiPreset,
  type TtsOpenAiPreset,
} from './voice-catalog.ts'

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024
export const MAX_MIMO_JSON_BYTES = 24 * 1024 * 1024
export const MAX_TTS_ERROR_BYTES = 8 * 1024

const MAX_ERROR_MESSAGE_CHARS = 240
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_COOLDOWN_MS = 60_000
const UTF8_DECODER = new TextDecoder('utf-8')

export type TtsErrorCode =
  | 'bad_url'
  | 'not_configured'
  | 'http_error'
  | 'bad_audio_payload'
  | 'too_large'
  | 'timeout'
  | 'aborted'
  | 'network'

/** Typed TTS provider failure with a stable code for fallback decisions. */
export class TtsProviderError extends Error {
  readonly code: TtsErrorCode
  readonly status?: number

  constructor(code: TtsErrorCode, message: string, status?: number) {
    super(redactSecrets(message))
    this.name = 'TtsProviderError'
    this.code = code
    if (status !== undefined) {
      this.status = status
    }
  }
}

export type ApiKeyProvider = SecretValueProvider

export interface ResolveOpenAiTtsConfigInput {
  presetId?: string
  baseUrl?: string
  model?: string
  voice?: string
}

export interface ResolvedOpenAiTtsConfig {
  preset: TtsOpenAiPreset | null
  presetId: string
  baseUrl: string
  url: string
  model: string
  voice: string
  requiresKey: boolean
}

export interface OpenAiCompatTtsOptions {
  presetId?: string
  baseUrl?: string
  model?: string
  voice?: string
  apiKey?: ApiKeyProvider
  responseFormat?: 'mp3' | 'wav'
  instructions?: string
  timeoutMs?: number
  cooldownMs?: number
  fallback?: () => TtsEngine
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface MimoTtsOptions {
  baseUrl?: string
  model?: string
  voice?: string
  apiKey?: ApiKeyProvider
  responseFormat?: 'wav' | 'mp3'
  instructions?: string
  timeoutMs?: number
  cooldownMs?: number
  fallback?: () => TtsEngine
  fetchImpl?: typeof fetch
  now?: () => number
}

// ── Magic-byte audio MIME sniffer ────────────────────────────────────────────

/**
 * Inspect magic bytes first, falling back to a normalized `audio/<subtype>` header
 * only when the payload does not begin with disguised HTML/JSON/XML text (`<`, `{`, `[`).
 */
export function sniffAudioMime(bytes: Uint8Array, contentTypeHeader?: string): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null

  // RIFF....WAVE
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return 'audio/wav'
  }

  // ID3 tag or MPEG audio frame sync
  if (bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return 'audio/mpeg'
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff) {
    const b1 = bytes[1]
    if ((b1 & 0xe0) === 0xe0 && (b1 & 0x18) !== 0x08 && (b1 & 0x06) !== 0x00) {
      return 'audio/mpeg'
    }
  }

  // OggS
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return 'audio/ogg'
  }

  // fLaC
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x66 &&
    bytes[1] === 0x4c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x43
  ) {
    return 'audio/flac'
  }

  // EBML (WebM / Matroska)
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return 'audio/webm'
  }

  // ISO BMFF `....ftyp`
  if (
    bytes.byteLength >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return 'audio/mp4'
  }

  if (!contentTypeHeader || typeof contentTypeHeader !== 'string') return null
  const mediaType = (contentTypeHeader.split(';')[0] ?? '').trim().toLowerCase()
  if (!/^audio\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) return null

  const prefix = UTF8_DECODER.decode(bytes.subarray(0, 64)).trimStart()
  if (prefix.startsWith('<') || prefix.startsWith('{') || prefix.startsWith('[')) {
    return null
  }
  return mediaType
}

// ── Pure ES2022 strict Base64 / Base64URL decoder ────────────────────────────

const B64_TABLE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1)
  const std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < std.length; i += 1) {
    table[std.charCodeAt(i)] = i
  }
  table[45] = 62 // '-'
  table[95] = 63 // '_'
  return table
})()

function lookupB64(code: number): number {
  if (code < 0 || code >= 128) return -1
  return B64_TABLE[code]
}

/**
 * Pure ES2022 strict base64 / base64url decoder supporting padded and valid unpadded inputs.
 * Rejects invalid characters, malformed padding, and empty outputs with `TtsProviderError`.
 */
export function decodeBase64Strict(raw: string): Uint8Array {
  if (typeof raw !== 'string') {
    throw new TtsProviderError('bad_audio_payload', 'Base64 audio payload must be a string')
  }
  const clean = /[ \t\r\n]/.test(raw) ? raw.replace(/[ \t\r\n]+/g, '') : raw
  if (clean.length === 0) {
    throw new TtsProviderError('bad_audio_payload', 'Base64 audio payload is empty')
  }

  let padCount = 0
  while (padCount < clean.length && clean.charCodeAt(clean.length - 1 - padCount) === 61) {
    padCount += 1
  }
  if (padCount > 2 || (padCount > 0 && clean.length % 4 !== 0)) {
    throw new TtsProviderError('bad_audio_payload', 'Invalid base64 padding in audio payload')
  }

  const dataLen = clean.length - padCount
  if (dataLen === 0 || dataLen % 4 === 1) {
    throw new TtsProviderError('bad_audio_payload', 'Invalid base64 length in audio payload')
  }

  const fullQuads = Math.floor(dataLen / 4)
  const rem = dataLen % 4
  const outLen = fullQuads * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0)
  if (outLen === 0) {
    throw new TtsProviderError('bad_audio_payload', 'Decoded audio payload is empty')
  }

  const out = new Uint8Array(outLen)
  let inPos = 0
  let outPos = 0

  for (let q = 0; q < fullQuads; q += 1) {
    const b0 = lookupB64(clean.charCodeAt(inPos))
    const b1 = lookupB64(clean.charCodeAt(inPos + 1))
    const b2 = lookupB64(clean.charCodeAt(inPos + 2))
    const b3 = lookupB64(clean.charCodeAt(inPos + 3))
    if ((b0 | b1 | b2 | b3) < 0) {
      throw new TtsProviderError('bad_audio_payload', 'Corrupt base64 character in audio payload')
    }
    out[outPos] = (b0 << 2) | (b1 >> 4)
    out[outPos + 1] = ((b1 & 0x0f) << 4) | (b2 >> 2)
    out[outPos + 2] = ((b2 & 0x03) << 6) | b3
    inPos += 4
    outPos += 3
  }

  if (rem === 2) {
    const b0 = lookupB64(clean.charCodeAt(inPos))
    const b1 = lookupB64(clean.charCodeAt(inPos + 1))
    if ((b0 | b1) < 0) {
      throw new TtsProviderError('bad_audio_payload', 'Corrupt base64 character in audio payload')
    }
    out[outPos] = (b0 << 2) | (b1 >> 4)
  } else if (rem === 3) {
    const b0 = lookupB64(clean.charCodeAt(inPos))
    const b1 = lookupB64(clean.charCodeAt(inPos + 1))
    const b2 = lookupB64(clean.charCodeAt(inPos + 2))
    if ((b0 | b1 | b2) < 0) {
      throw new TtsProviderError('bad_audio_payload', 'Corrupt base64 character in audio payload')
    }
    out[outPos] = (b0 << 2) | (b1 >> 4)
    out[outPos + 1] = ((b1 & 0x0f) << 4) | (b2 >> 2)
  }

  return out
}

// ── Endpoint & preset configuration resolvers ────────────────────────────────

function buildValidatedEndpoint(rawBaseUrl: string, suffix: string): { baseUrl: string; url: string } {
  let url: URL
  try {
    url = validateEndpointUrl(rawBaseUrl)
  } catch (err) {
    throw new TtsProviderError('bad_url', err instanceof Error ? err.message : String(err))
  }
  const noSlash = url.pathname.replace(/\/+$/, '')
  const basePath = noSlash.endsWith(suffix) ? noSlash.slice(0, -suffix.length) : noSlash
  url.pathname = `${basePath}${suffix}`
  return {
    baseUrl: `${url.origin}${basePath}`,
    url: url.toString(),
  }
}

/** Validate `baseUrl` (HTTPS or credential-free loopback HTTP only) and resolve `{baseUrl}/audio/speech`. */
export function resolveSpeechEndpointUrl(baseUrl: string): string {
  return buildValidatedEndpoint(baseUrl, '/audio/speech').url
}

/** Resolve an OpenAI-compatible TTS preset and caller overrides into a validated speech config. */
export function resolveOpenAiTtsConfig(
  input: ResolveOpenAiTtsConfigInput = {},
): ResolvedOpenAiTtsConfig {
  const rawPresetId = input.presetId?.trim() ?? ''
  const rawBaseUrl = input.baseUrl?.trim() ?? ''

  const preset: TtsOpenAiPreset | null = rawPresetId
    ? resolveTtsOpenAiPreset(rawPresetId)
    : rawBaseUrl
      ? null
      : (TTS_OPENAI_PRESETS['openai-official'] ?? null)

  const effectiveBase = rawBaseUrl || preset?.baseUrl || ''
  const { baseUrl, url } = buildValidatedEndpoint(effectiveBase, '/audio/speech')
  const model = input.model?.trim() || preset?.model || 'tts-1'
  const voice = input.voice !== undefined ? input.voice.trim() : (preset?.voice ?? '')
  const isLoopbackOverride = rawBaseUrl.length > 0 && url.startsWith('http://')

  return {
    preset,
    presetId: preset?.id ?? (rawPresetId || 'custom'),
    baseUrl,
    url,
    model,
    voice,
    requiresKey: preset && !isLoopbackOverride ? preset.requiresKey : false,
  }
}

// ── Shared HTTP & circuit-breaker utilities ──────────────────────────────────

interface InflightHandle {
  readonly ac: AbortController
  markInterrupted: () => void
}

// ── Shared base logic for remote HTTP TTS engines ────────────────────────────

abstract class HttpTtsEngineBase implements TtsEngine {
  abstract readonly kind: 'openai-compat' | 'mimo'
  abstract readonly mime: string

  protected readonly timeoutMs: number
  protected readonly cooldownMs: number
  protected readonly fetchImpl: typeof fetch
  protected readonly now: () => number
  protected readonly fallbackFactory?: () => TtsEngine

  protected voiceOverride?: string
  protected defaultRate?: number
  protected cachedKeyPresent?: boolean
  protected lastError: TtsProviderError | null = null
  protected cooldownUntil = 0
  protected closed = false
  protected fallbackEngine: TtsEngine | null = null
  protected readonly inflight = new Set<InflightHandle>()

  constructor(opts: {
    timeoutMs?: number
    cooldownMs?: number
    fallback?: () => TtsEngine
    fetchImpl?: typeof fetch
    now?: () => number
  }) {
    this.timeoutMs =
      typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_TIMEOUT_MS
    this.cooldownMs =
      typeof opts.cooldownMs === 'number' && Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0
        ? opts.cooldownMs
        : DEFAULT_COOLDOWN_MS
    this.fetchImpl = resolveFetchImpl(opts.fetchImpl)
    this.now = opts.now ?? Date.now
    if (opts.fallback) {
      this.fallbackFactory = opts.fallback
    }
  }

  updateVoice(voice: string, rate?: number): void {
    this.voiceOverride = voice.trim()
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      this.defaultRate = rate
    }
  }

  interrupt(): void {
    for (const handle of this.inflight) {
      handle.markInterrupted()
      handle.ac.abort(new Error('TTS interrupted'))
    }
    this.inflight.clear()
    this.fallbackEngine?.interrupt?.()
  }

  async close(): Promise<void> {
    this.closed = true
    this.interrupt()
    if (this.fallbackEngine) {
      const fb = this.fallbackEngine
      this.fallbackEngine = null
      await fb.close()
    }
  }

  abstract prepare(): Promise<void>
  abstract status(): TtsEngineStatus
  protected abstract synthesizePrimary(
    cleanedText: string,
    options: TtsSynthOptions | undefined,
    signal: AbortSignal,
  ): Promise<TtsSynthResult>

  async synthesize(text: string, options?: TtsSynthOptions): Promise<TtsSynthResult> {
    if (this.closed) {
      throw new TtsProviderError('aborted', 'TTS engine is closed')
    }
    if (options?.signal?.aborted) {
      throw new TtsProviderError('aborted', 'TTS synthesis was aborted')
    }

    const cleaned = stripEmotionTags(text).trim()
    if (cleaned.length === 0) {
      return { audio: new Uint8Array(0), mime: this.mime }
    }

    if (this.fallbackFactory && this.cooldownMs > 0 && this.now() < this.cooldownUntil) {
      return this.synthesizeViaFallback(text, options)
    }

    const ac = new AbortController()
    let timedOut = false
    let interrupted = false
    let callerAborted = false

    const handle: InflightHandle = {
      ac,
      markInterrupted: () => {
        interrupted = true
      },
    }
    this.inflight.add(handle)

    const onCallerAbort = (): void => {
      callerAborted = true
      ac.abort(options?.signal?.reason ?? new Error('aborted'))
    }
    options?.signal?.addEventListener('abort', onCallerAbort, { once: true })

    const timer = scheduleTimeout(() => {
      timedOut = true
      ac.abort(new Error('TTS request timed out'))
    }, this.timeoutMs)

    try {
      const result = await this.synthesizePrimary(cleaned, options, ac.signal)
      if (interrupted || callerAborted || options?.signal?.aborted) {
        throw new TtsProviderError('aborted', 'TTS synthesis was aborted')
      }
      this.cooldownUntil = 0
      this.lastError = null
      return result
    } catch (rawErr) {
      let err: TtsProviderError
      if (interrupted || callerAborted || options?.signal?.aborted) {
        err = new TtsProviderError('aborted', 'TTS synthesis was aborted')
      } else if (timedOut) {
        err = new TtsProviderError('timeout', `TTS request timed out after ${this.timeoutMs} ms`)
      } else if (rawErr instanceof TtsProviderError) {
        err = rawErr
      } else {
        err = new TtsProviderError(
          'network',
          rawErr instanceof Error ? rawErr.message : String(rawErr),
        )
      }

      if (err.code === 'aborted' || err.code === 'bad_url') {
        throw err
      }

      this.lastError = err
      if (this.fallbackFactory) {
        if (this.cooldownMs > 0) {
          this.cooldownUntil = this.now() + this.cooldownMs
        }
        return this.synthesizeViaFallback(text, options)
      }
      throw err
    } finally {
      cancelTimeout(timer)
      options?.signal?.removeEventListener('abort', onCallerAbort)
      this.inflight.delete(handle)
    }
  }

  private synthesizeViaFallback(
    text: string,
    options: TtsSynthOptions | undefined,
  ): Promise<TtsSynthResult> {
    if (!this.fallbackEngine) {
      this.fallbackEngine = this.fallbackFactory!()
    }
    const fallbackOpts: TtsSynthOptions = {}
    if (options?.voice !== undefined) fallbackOpts.voice = options.voice
    const rate = options?.rate ?? this.defaultRate
    if (rate !== undefined) fallbackOpts.rate = rate
    if (options?.signal !== undefined) fallbackOpts.signal = options.signal
    return this.fallbackEngine.synthesize(text, fallbackOpts)
  }
}

// ── OpenAI-compatible `/audio/speech` engine ─────────────────────────────────

/** OpenAI-compatible speech synthesis engine (7 built-in presets + custom endpoint). */
export class OpenAiCompatTtsEngine extends HttpTtsEngineBase {
  readonly kind = 'openai-compat' as const
  readonly mime: string

  private readonly rawOptions: OpenAiCompatTtsOptions
  private readonly responseFormat: 'mp3' | 'wav'

  constructor(options: OpenAiCompatTtsOptions = {}) {
    super(options)
    this.rawOptions = options
    this.responseFormat = options.responseFormat ?? 'mp3'
    this.mime = this.responseFormat === 'wav' ? 'audio/wav' : 'audio/mpeg'
    if (typeof options.apiKey === 'string') {
      this.cachedKeyPresent = options.apiKey.trim().length > 0
    }
  }

  async prepare(): Promise<void> {
    const resolved = resolveOpenAiTtsConfig(this.rawOptions)
    const key = await resolveSecretValue(this.rawOptions.apiKey)
    this.cachedKeyPresent = key.length > 0
    if (resolved.requiresKey && !key) {
      throw new TtsProviderError(
        'not_configured',
        `TTS preset "${resolved.presetId}" requires a non-empty apiKey`,
      )
    }
  }

  status(): TtsEngineStatus {
    try {
      const cfg = resolveOpenAiTtsConfig(this.rawOptions)
      const keyPresent =
        typeof this.rawOptions.apiKey === 'string'
          ? this.rawOptions.apiKey.trim().length > 0
          : (this.cachedKeyPresent ?? false)
      const status: TtsEngineStatus = {
        engine: this.kind,
        ready: !this.closed && (!cfg.requiresKey || keyPresent),
        loading: this.inflight.size > 0,
        keyRequired: cfg.requiresKey,
        keyPresent,
      }
      if (this.lastError) {
        status.error = this.lastError.message
        status.errorCode = this.lastError.code
      }
      return status
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        engine: this.kind,
        ready: false,
        loading: false,
        error: redactSecrets(msg),
        errorCode: err instanceof TtsProviderError ? err.code : 'bad_url',
      }
    }
  }

  protected async synthesizePrimary(
    cleanedText: string,
    options: TtsSynthOptions | undefined,
    signal: AbortSignal,
  ): Promise<TtsSynthResult> {
    const resolved = resolveOpenAiTtsConfig(this.rawOptions)
    const trimmedKey = await resolveSecretValue(this.rawOptions.apiKey)
    this.cachedKeyPresent = trimmedKey.length > 0
    if (resolved.requiresKey && !trimmedKey) {
      throw new TtsProviderError(
        'not_configured',
        `TTS preset "${resolved.presetId}" requires a non-empty apiKey`,
      )
    }

    const effectiveVoice =
      options?.voice !== undefined
        ? options.voice.trim()
        : this.voiceOverride !== undefined
          ? this.voiceOverride
          : resolved.voice

    const effectiveRate = options?.rate ?? this.defaultRate
    const payload: Record<string, unknown> = {
      model: resolved.model,
      input: cleanedText,
      response_format: this.responseFormat,
    }
    if (effectiveVoice.length > 0) {
      payload.voice = effectiveVoice
    }
    if (
      typeof effectiveRate === 'number' &&
      Number.isFinite(effectiveRate) &&
      effectiveRate > 0 &&
      effectiveRate !== 1
    ) {
      payload.speed = effectiveRate
    }
    const instructions = this.rawOptions.instructions?.trim()
    if (instructions) {
      payload.instructions = instructions
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (trimmedKey.length > 0) {
      headers.Authorization = `Bearer ${trimmedKey}`
    }

    const res = await raceAbort(
      this.fetchImpl(resolved.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
        redirect: 'error',
      }),
      signal,
    )

    if (!res.ok) {
      const msg = await readRedactedHttpErrorMessage(
        res,
        MAX_TTS_ERROR_BYTES,
        MAX_ERROR_MESSAGE_CHARS,
        signal,
      )
      throw new TtsProviderError('http_error', msg, res.status)
    }

    const audio = await readBoundedStreamBytes(
      res,
      MAX_AUDIO_BYTES,
      signal,
      () => new TtsProviderError('too_large', `TTS audio response exceeds ${MAX_AUDIO_BYTES} bytes`),
    )
    if (audio.byteLength === 0) {
      throw new TtsProviderError('bad_audio_payload', 'TTS provider returned empty audio payload')
    }

    const sniffed = sniffAudioMime(audio, res.headers.get('content-type') ?? undefined)
    if (!sniffed) {
      throw new TtsProviderError(
        'bad_audio_payload',
        'TTS provider returned unrecognized or non-audio payload',
      )
    }

    return { audio, mime: sniffed }
  }
}

// ── Xiaomi MiMo `/chat/completions` audio engine ─────────────────────────────

function formatMimoSpeedPrompt(rate: number): string {
  const formatted = Number(rate.toFixed(2))
  if (rate > 1) {
    return `Please speak at a faster pace (${formatted}x speed，语速加快至约 ${formatted} 倍).`
  }
  return `Please speak at a slower pace (${formatted}x speed，语速放慢至约 ${formatted} 倍).`
}

/** Xiaomi MiMo speech synthesis engine (BYOK, emotion via instructions). */
export class MimoTtsEngine extends HttpTtsEngineBase {
  readonly kind = 'mimo' as const
  readonly mime: string

  private readonly rawOptions: MimoTtsOptions
  private readonly responseFormat: 'wav' | 'mp3'

  constructor(options: MimoTtsOptions = {}) {
    super(options)
    this.rawOptions = options
    this.responseFormat = options.responseFormat ?? 'wav'
    this.mime = this.responseFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    if (typeof options.apiKey === 'string') {
      this.cachedKeyPresent = options.apiKey.trim().length > 0
    }
  }

  private resolveUrl(): string {
    const rawBase = this.rawOptions.baseUrl?.trim() || MIMO_DEFAULT_BASE_URL
    return buildValidatedEndpoint(rawBase, '/chat/completions').url
  }

  async prepare(): Promise<void> {
    this.resolveUrl()
    const key = await resolveSecretValue(this.rawOptions.apiKey)
    this.cachedKeyPresent = key.length > 0
    if (!key) {
      throw new TtsProviderError('not_configured', 'MiMo TTS requires a non-empty apiKey')
    }
  }

  status(): TtsEngineStatus {
    try {
      this.resolveUrl()
      const keyPresent =
        typeof this.rawOptions.apiKey === 'string'
          ? this.rawOptions.apiKey.trim().length > 0
          : (this.cachedKeyPresent ?? false)
      const status: TtsEngineStatus = {
        engine: this.kind,
        ready: !this.closed && keyPresent,
        loading: this.inflight.size > 0,
        keyRequired: true,
        keyPresent,
      }
      if (this.lastError) {
        status.error = this.lastError.message
        status.errorCode = this.lastError.code
      }
      return status
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        engine: this.kind,
        ready: false,
        loading: false,
        keyRequired: true,
        keyPresent: false,
        error: redactSecrets(msg),
        errorCode: err instanceof TtsProviderError ? err.code : 'bad_url',
      }
    }
  }

  protected async synthesizePrimary(
    cleanedText: string,
    options: TtsSynthOptions | undefined,
    signal: AbortSignal,
  ): Promise<TtsSynthResult> {
    const url = this.resolveUrl()
    const trimmedKey = await resolveSecretValue(this.rawOptions.apiKey)
    this.cachedKeyPresent = trimmedKey.length > 0
    if (!trimmedKey) {
      throw new TtsProviderError('not_configured', 'MiMo TTS requires a non-empty apiKey')
    }

    const effectiveVoice =
      (options?.voice !== undefined ? options.voice.trim() : undefined) ||
      this.voiceOverride ||
      this.rawOptions.voice?.trim() ||
      MIMO_DEFAULT_VOICE

    const effectiveRate = options?.rate ?? this.defaultRate
    const hasCustomRate =
      typeof effectiveRate === 'number' &&
      Number.isFinite(effectiveRate) &&
      effectiveRate > 0 &&
      effectiveRate !== 1

    const userPrompts: string[] = []
    const instructions = this.rawOptions.instructions?.trim()
    if (instructions) {
      userPrompts.push(instructions)
    }
    if (hasCustomRate) {
      userPrompts.push(formatMimoSpeedPrompt(effectiveRate))
    }

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
    if (userPrompts.length > 0) {
      messages.push({ role: 'user', content: userPrompts.join('\n') })
    }
    messages.push({ role: 'assistant', content: cleanedText })

    const model = this.rawOptions.model?.trim() || MIMO_DEFAULT_MODEL
    const payload = {
      model,
      messages,
      audio: {
        voice: effectiveVoice,
        format: this.responseFormat,
      },
      stream: false,
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'api-key': trimmedKey,
    }

    const res = await raceAbort(
      this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
        redirect: 'error',
      }),
      signal,
    )

    if (!res.ok) {
      const msg = await readRedactedHttpErrorMessage(
        res,
        MAX_TTS_ERROR_BYTES,
        MAX_ERROR_MESSAGE_CHARS,
        signal,
      )
      throw new TtsProviderError('http_error', msg, res.status)
    }

    const rawBytes = await readBoundedStreamBytes(
      res,
      MAX_MIMO_JSON_BYTES,
      signal,
      () =>
        new TtsProviderError('too_large', `MiMo JSON response exceeds ${MAX_MIMO_JSON_BYTES} bytes`),
    )
    const rawJson = UTF8_DECODER.decode(rawBytes)

    let parsed: unknown
    try {
      parsed = JSON.parse(rawJson)
    } catch {
      const snippet = redactSecrets(rawJson.slice(0, MAX_TTS_ERROR_BYTES))
        .replace(/\s+/g, ' ')
        .trim()
      throw new TtsProviderError(
        'bad_audio_payload',
        `MiMo returned non-JSON body: ${snippet}`.slice(0, MAX_ERROR_MESSAGE_CHARS),
      )
    }

    const root =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    const firstChoice = Array.isArray(root?.choices)
      ? (root.choices[0] as { message?: { audio?: { data?: unknown } } } | undefined)
      : undefined
    const b64Data = firstChoice?.message?.audio?.data

    if (typeof b64Data !== 'string' || b64Data.trim().length === 0) {
      const errDetail = root?.error
        ? `: ${redactSecrets(JSON.stringify(root.error).slice(0, MAX_TTS_ERROR_BYTES))}`
        : ''
      throw new TtsProviderError(
        'bad_audio_payload',
        `MiMo response missing choices[0].message.audio.data${errDetail}`.slice(
          0,
          MAX_ERROR_MESSAGE_CHARS,
        ),
      )
    }

    const audio = decodeBase64Strict(b64Data)
    const declaredMime = this.responseFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    const sniffed = sniffAudioMime(audio, declaredMime)
    if (!sniffed) {
      throw new TtsProviderError(
        'bad_audio_payload',
        'MiMo returned unrecognized or non-audio payload',
      )
    }

    return { audio, mime: sniffed }
  }
}
