/**
 * Cloud & self-hosted OpenAI-compatible `/audio/transcriptions` ASR transport,
 * mono 16-bit PCM WAV encoder, RFC 7578 binary multipart encoder, and Whisper locale normalizer.
 *
 * Host-agnostic and zero-dependency: uses only standard ES2022 + Uint8Array + fetch.
 */

import {
  DEFAULT_ENDPOINT_POLICY,
  type AsrTranscriptEvent,
  type AsrTransport,
  type EndpointPolicy,
} from './contracts.ts'
import {
  cancelTimeout,
  mergeFloat32Chunks,
  raceAbort,
  readBoundedStreamBytes,
  readRedactedHttpErrorMessage,
  resolveFetchImpl,
  resolveSecretValue,
  scheduleTimeout,
} from './http-stream.ts'
import { validateEndpointUrl } from './llm-router.ts'
import { redactBodySnippet, redactSecrets } from './redact.ts'
import type { ApiKeyProvider } from './tts-engines.ts'

export const DEFAULT_ASR_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_ASR_OPENAI_MODEL = 'whisper-1'
export const MAX_ASR_AUDIO_BYTES = 25 * 1024 * 1024
export const MAX_ASR_RESPONSE_BYTES = 1 * 1024 * 1024
export const MAX_ASR_ERROR_BYTES = 8 * 1024

const MAX_ERROR_MESSAGE_CHARS = 240
const DEFAULT_ASR_TIMEOUT_MS = 45_000
const DEFAULT_SAMPLE_RATE = 16_000
const TRANSCRIPTIONS_SUFFIX = '/audio/transcriptions'
const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8')

export type AsrErrorCode =
  | 'bad_url'
  | 'not_configured'
  | 'http_error'
  | 'bad_response'
  | 'too_large'
  | 'timeout'
  | 'aborted'
  | 'network'

export class AsrProviderError extends Error {
  readonly code: AsrErrorCode
  readonly status?: number

  constructor(code: AsrErrorCode, message: string, status?: number) {
    super(redactSecrets(message))
    this.name = 'AsrProviderError'
    this.code = code
    if (status !== undefined) {
      this.status = status
    }
  }
}

export interface ResolvedAsrEndpoint {
  baseUrl: string
  url: string
  isLoopbackHttp: boolean
}

export interface MultipartFilePart {
  fieldName: string
  fileName: string
  contentType: string
  bytes: Uint8Array
}

export interface OpenAiCompatAsrOptions {
  baseUrl?: string
  model?: string
  apiKey?: ApiKeyProvider
  language?: string
  prompt?: string
  timeoutMs?: number
  maxSpeechSec?: number
  fetchImpl?: typeof fetch
}

/**
 * Validate `baseUrl` (HTTPS or credential-free loopback HTTP only) and resolve
 * `{baseUrl}/audio/transcriptions` without duplicating suffixes or trailing slashes.
 */
export function resolveTranscriptionsEndpointUrl(baseUrl?: string): ResolvedAsrEndpoint {
  const rawBase = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  let parsed: URL
  try {
    parsed = validateEndpointUrl(rawBase || DEFAULT_ASR_OPENAI_BASE_URL)
  } catch (err) {
    throw new AsrProviderError('bad_url', err instanceof Error ? err.message : String(err))
  }

  let basePath = parsed.pathname.replace(/\/+$/, '')
  while (basePath.endsWith(TRANSCRIPTIONS_SUFFIX)) {
    basePath = basePath.slice(0, -TRANSCRIPTIONS_SUFFIX.length).replace(/\/+$/, '')
  }
  parsed.pathname = `${basePath}${TRANSCRIPTIONS_SUFFIX}`
  const url = parsed.toString()

  return {
    baseUrl: `${parsed.origin}${basePath}`,
    url,
    isLoopbackHttp: url.startsWith('http://'),
  }
}

/**
 * Encode mono Float32 PCM samples (`[-1, 1]` clamped, `NaN` -> `0`) into a
 * standard 44-byte RIFF/WAVE PCM16LE `Uint8Array`.
 */
export function encodeMonoPcm16Wav(
  samples: Float32Array,
  sampleRate = DEFAULT_SAMPLE_RATE,
): Uint8Array {
  const rate =
    typeof sampleRate === 'number' && Number.isFinite(sampleRate) && sampleRate > 0
      ? Math.round(sampleRate)
      : DEFAULT_SAMPLE_RATE
  const numSamples = samples.length
  const dataBytes = numSamples * 2
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)

  // "RIFF" chunk descriptor
  out[0] = 0x52
  out[1] = 0x49
  out[2] = 0x46
  out[3] = 0x46
  view.setUint32(4, 36 + dataBytes, true)
  // "WAVE"
  out[8] = 0x57
  out[9] = 0x41
  out[10] = 0x56
  out[11] = 0x45

  // "fmt " sub-chunk (16-byte PCM)
  out[12] = 0x66
  out[13] = 0x6d
  out[14] = 0x74
  out[15] = 0x20
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true) // NumChannels = 1 (mono)
  view.setUint32(24, rate, true) // SampleRate
  view.setUint32(28, rate * 2, true) // ByteRate = SampleRate * 1 * 2
  view.setUint16(32, 2, true) // BlockAlign = 1 * 2
  view.setUint16(34, 16, true) // BitsPerSample = 16

  // "data" sub-chunk
  out[36] = 0x64
  out[37] = 0x61
  out[38] = 0x74
  out[39] = 0x61
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < numSamples; i += 1) {
    const raw = samples[i]
    const clamped = Number.isNaN(raw) ? 0 : raw < -1 ? -1 : raw > 1 ? 1 : raw
    const pcm = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
    view.setInt16(44 + i * 2, pcm, true)
  }

  return out
}

function sanitizeMultipartParam(value: string): string {
  return value
    .replace(/\\/g, '%5C')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/"/g, '%22')
}

function createMultipartBoundary(): string {
  const rand = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(rand)
  } else {
    for (let i = 0; i < rand.length; i += 1) {
      rand[i] = Math.floor(Math.random() * 256)
    }
  }
  let hex = ''
  for (let i = 0; i < rand.length; i += 1) {
    hex += rand[i].toString(16).padStart(2, '0')
  }
  return `----VoiceModeBoundary${hex}`
}

/**
 * Pure `Uint8Array` RFC 7578 multipart encoder so binary upload bodies work across
 * desktop HTTPS and mobile native HTTP bridges without host-specific multipart globals.
 */
export function buildMultipartFormData(
  fields: ReadonlyArray<readonly [string, string]>,
  file: MultipartFilePart,
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = createMultipartBoundary()
  const crlf = UTF8_ENCODER.encode('\r\n')
  const parts: Uint8Array[] = []

  for (const [rawName, rawValue] of fields) {
    const safeName = sanitizeMultipartParam(rawName)
    const partText =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${safeName}"\r\n\r\n` +
      `${rawValue}\r\n`
    parts.push(UTF8_ENCODER.encode(partText))
  }

  const safeFieldName = sanitizeMultipartParam(file.fieldName)
  const safeFileName = sanitizeMultipartParam(file.fileName)
  const safeContentType =
    (file.contentType || 'application/octet-stream').replace(/[\r\n]+/g, ' ').trim() ||
    'application/octet-stream'

  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${safeFieldName}"; filename="${safeFileName}"\r\n` +
    `Content-Type: ${safeContentType}\r\n\r\n`
  parts.push(UTF8_ENCODER.encode(fileHeader))
  parts.push(file.bytes)
  parts.push(crlf)
  parts.push(UTF8_ENCODER.encode(`--${boundary}--\r\n`))

  let totalBytes = 0
  for (const p of parts) {
    totalBytes += p.byteLength
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const p of parts) {
    body.set(p, offset)
    offset += p.byteLength
  }

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/**
 * Normalize caller locale tags into Whisper ISO-639-1 / Cantonese codes.
 * Returns `undefined` for empty or `'auto'` so Whisper auto-detects multilingual speech.
 */
export function normalizeWhisperLanguage(locale?: string): string | undefined {
  if (typeof locale !== 'string') return undefined
  const trimmed = locale.trim().toLowerCase()
  if (!trimmed || trimmed === 'auto') return undefined
  if (trimmed === 'cantonese') return 'yue'

  const subtags = trimmed.split(/[-_]+/).filter(Boolean)
  const primary = subtags[0]
  if (!primary) return undefined

  if (primary === 'yue') return 'yue'
  if (primary === 'zh' && (subtags.includes('hk') || subtags.includes('yue'))) {
    return 'yue'
  }
  if (/^[a-z]{2,3}$/.test(primary)) {
    return primary
  }
  return undefined
}

// ── Internal async / bounded-stream helpers ──────────────────────────────────

interface InflightAsrHandle {
  readonly ac: AbortController
  markAborted: () => void
}

// ── OpenAI-compatible `/audio/transcriptions` ASR transport ──────────────────

export class OpenAiCompatAsrTransport implements AsrTransport {
  readonly kind = 'openai-compat' as const

  private readonly options: OpenAiCompatAsrOptions
  private readonly timeoutMs: number
  private readonly maxSpeechSec: number
  private readonly fetchImpl: typeof fetch
  private readonly inflight = new Set<InflightAsrHandle>()

  private closed = false
  private chunks: Float32Array[] = []
  private bufferedSamples = 0
  private sessionMaxSamples: number
  private sessionLanguage: string | undefined

  constructor(options: OpenAiCompatAsrOptions = {}) {
    this.options = options
    this.timeoutMs =
      typeof options.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_ASR_TIMEOUT_MS
    this.maxSpeechSec =
      typeof options.maxSpeechSec === 'number' &&
      Number.isFinite(options.maxSpeechSec) &&
      options.maxSpeechSec > 0
        ? options.maxSpeechSec
        : DEFAULT_ENDPOINT_POLICY.maxSpeechSec
    this.fetchImpl = resolveFetchImpl(options.fetchImpl)
    this.sessionMaxSamples = Math.max(0, Math.floor(this.maxSpeechSec * DEFAULT_SAMPLE_RATE))
  }

  async start(options?: {
    language?: string
    policy?: Partial<EndpointPolicy>
    signal?: AbortSignal
  }): Promise<void> {
    if (this.closed) {
      throw new AsrProviderError('aborted', 'ASR transport is closed')
    }
    if (options?.signal?.aborted) {
      throw new AsrProviderError('aborted', 'ASR session was aborted')
    }
    const policyMaxSec = options?.policy?.maxSpeechSec
    const effectiveMaxSec =
      typeof policyMaxSec === 'number' && Number.isFinite(policyMaxSec) && policyMaxSec > 0
        ? policyMaxSec
        : this.maxSpeechSec
    this.chunks = []
    this.bufferedSamples = 0
    this.sessionMaxSamples = Math.max(0, Math.floor(effectiveMaxSec * DEFAULT_SAMPLE_RATE))
    this.sessionLanguage = options?.language
  }

  pushAudio(pcm16k: Float32Array): void {
    if (this.closed || !(pcm16k instanceof Float32Array) || pcm16k.length === 0) return
    const remaining = this.sessionMaxSamples - this.bufferedSamples
    if (remaining <= 0) return
    const slice = pcm16k.length <= remaining ? pcm16k.slice() : pcm16k.slice(0, remaining)
    this.chunks.push(slice)
    this.bufferedSamples += slice.length
  }

  async finalize(signal?: AbortSignal): Promise<AsrTranscriptEvent> {
    const merged = mergeFloat32Chunks(this.chunks, this.bufferedSamples)
    const lang = this.sessionLanguage
    this.chunks = []
    this.bufferedSamples = 0
    this.sessionLanguage = undefined

    const transcribeOpts: { sampleRate?: number; language?: string; signal?: AbortSignal } = {
      sampleRate: DEFAULT_SAMPLE_RATE,
    }
    if (lang !== undefined) transcribeOpts.language = lang
    if (signal !== undefined) transcribeOpts.signal = signal
    return this.transcribe(merged, transcribeOpts)
  }

  async transcribe(
    pcm16k: Float32Array,
    options?: { sampleRate?: number; language?: string; signal?: AbortSignal },
  ): Promise<AsrTranscriptEvent> {
    if (this.closed) {
      throw new AsrProviderError('aborted', 'ASR transport is closed')
    }
    if (options?.signal?.aborted) {
      throw new AsrProviderError('aborted', 'ASR transcription was aborted')
    }
    if (!pcm16k || pcm16k.length === 0) {
      return { text: '', isFinal: true, durationMs: 0 }
    }

    const endpoint = resolveTranscriptionsEndpointUrl(this.options.baseUrl)
    if (44 + pcm16k.length * 2 > MAX_ASR_AUDIO_BYTES) {
      throw new AsrProviderError(
        'too_large',
        `ASR audio upload exceeds ${MAX_ASR_AUDIO_BYTES} bytes`,
      )
    }

    const ac = new AbortController()
    let timedOut = false
    let abortedByTransport = false
    let callerAborted = false

    const handle: InflightAsrHandle = {
      ac,
      markAborted: () => {
        abortedByTransport = true
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
      ac.abort(new Error('ASR request timed out'))
    }, this.timeoutMs)

    try {
      const trimmedKey = await resolveSecretValue(this.options.apiKey)
      if (abortedByTransport || callerAborted || options?.signal?.aborted || this.closed) {
        throw new AsrProviderError('aborted', 'ASR transcription was aborted')
      }
      if (!endpoint.isLoopbackHttp && !trimmedKey) {
        throw new AsrProviderError(
          'not_configured',
          'ASR endpoint requires a non-empty apiKey unless using loopback HTTP',
        )
      }

      const effectiveRate =
        typeof options?.sampleRate === 'number' &&
        Number.isFinite(options.sampleRate) &&
        options.sampleRate > 0
          ? Math.round(options.sampleRate)
          : DEFAULT_SAMPLE_RATE
      const wav = encodeMonoPcm16Wav(pcm16k, effectiveRate)
      if (wav.byteLength > MAX_ASR_AUDIO_BYTES) {
        throw new AsrProviderError(
          'too_large',
          `ASR audio upload exceeds ${MAX_ASR_AUDIO_BYTES} bytes`,
        )
      }

      const model = this.options.model?.trim() || DEFAULT_ASR_OPENAI_MODEL
      const rawLang = options?.language !== undefined ? options.language : this.options.language
      const normalizedLang = normalizeWhisperLanguage(rawLang)
      const prompt = this.options.prompt?.trim()

      const fields: Array<readonly [string, string]> = [
        ['model', model],
        ['response_format', 'json'],
      ]
      if (normalizedLang !== undefined) {
        fields.push(['language', normalizedLang])
      }
      if (prompt) {
        fields.push(['prompt', prompt])
      }

      const multipart = buildMultipartFormData(fields, {
        fieldName: 'file',
        fileName: 'speech.wav',
        contentType: 'audio/wav',
        bytes: wav,
      })

      const headers: Record<string, string> = {
        'Content-Type': multipart.contentType,
      }
      if (trimmedKey.length > 0) {
        headers.Authorization = `Bearer ${trimmedKey}`
      }

      const durationMs = Math.round((pcm16k.length / effectiveRate) * 1000)

      const res = await raceAbort(
        this.fetchImpl(endpoint.url, {
          method: 'POST',
          headers,
          body: multipart.body,
          signal: ac.signal,
          redirect: 'error',
        }),
        ac.signal,
      )

      if (!res.ok) {
        const msg = await readRedactedHttpErrorMessage(
          res,
          MAX_ASR_ERROR_BYTES,
          MAX_ERROR_MESSAGE_CHARS,
          ac.signal,
        )
        throw new AsrProviderError('http_error', msg, res.status)
      }

      const bodyBytes = await readBoundedStreamBytes(
        res,
        MAX_ASR_RESPONSE_BYTES,
        ac.signal,
        () =>
          new AsrProviderError(
            'too_large',
            `ASR transcript response exceeds ${MAX_ASR_RESPONSE_BYTES} bytes`,
          ),
      )
      if (abortedByTransport || callerAborted || options?.signal?.aborted) {
        throw new AsrProviderError('aborted', 'ASR transcription was aborted')
      }

      const rawText = UTF8_DECODER.decode(bodyBytes)
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
      if (contentType.includes('text/plain')) {
        return {
          text: rawText.trim(),
          isFinal: true,
          durationMs,
        }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawText)
      } catch {
        throw new AsrProviderError(
          'bad_response',
          `ASR provider returned non-JSON response: ${redactBodySnippet(rawText, 160)}`,
        )
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { text?: unknown }).text !== 'string'
      ) {
        throw new AsrProviderError(
          'bad_response',
          'ASR JSON response must be an object with a string "text" field',
        )
      }

      const data = parsed as { text: string; language?: unknown }
      const event: AsrTranscriptEvent = {
        text: data.text.trim(),
        isFinal: true,
        durationMs,
      }
      if (typeof data.language === 'string' && data.language.trim().length > 0) {
        event.language = data.language.trim()
      }
      return event
    } catch (rawErr) {
      if (abortedByTransport || callerAborted || options?.signal?.aborted) {
        throw new AsrProviderError('aborted', 'ASR transcription was aborted')
      }
      if (timedOut) {
        throw new AsrProviderError(
          'timeout',
          `ASR request timed out after ${this.timeoutMs} ms`,
        )
      }
      if (rawErr instanceof AsrProviderError) {
        throw rawErr
      }
      throw new AsrProviderError(
        'network',
        rawErr instanceof Error ? rawErr.message : String(rawErr),
      )
    } finally {
      cancelTimeout(timer)
      options?.signal?.removeEventListener('abort', onCallerAbort)
      this.inflight.delete(handle)
    }
  }

  abort(): void {
    this.chunks = []
    this.bufferedSamples = 0
    this.sessionLanguage = undefined
    for (const handle of this.inflight) {
      handle.markAborted()
      handle.ac.abort(new Error('ASR aborted'))
    }
    this.inflight.clear()
  }

  async close(): Promise<void> {
    this.closed = true
    this.abort()
  }
}
