/**
 * Unified loopback `Voice Daemon` deep module exposing clean `.asr` (`AsrTransport`, `kind = 'daemon'`)
 * and `.tts` (`TtsEngine`, `kind = 'kokoro-daemon'`) adapters across Obsidian, SillyTavern, MV3,
 * and desktop hosts.
 *
 * Host-agnostic and zero-dependency: uses only standard ES2022 + Uint8Array + fetch.
 */

import {
  MAX_ASR_AUDIO_BYTES,
  MAX_ASR_ERROR_BYTES,
  MAX_ASR_RESPONSE_BYTES,
  buildMultipartFormData,
  encodeMonoPcm16Wav,
  normalizeWhisperLanguage,
} from './asr-engines.ts'
import {
  DEFAULT_ENDPOINT_POLICY,
  type AsrTranscriptEvent,
  type AsrTransport,
  type EndpointPolicy,
  type TtsEngine,
  type TtsEngineStatus,
  type TtsSynthOptions,
  type TtsSynthResult,
} from './contracts.ts'
import { stripEmotionTags } from './emotion.ts'
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
import { validateLoopbackUrl } from './llm-router.ts'
import { redactBodySnippet, redactSecrets } from './redact.ts'
import {
  MAX_AUDIO_BYTES,
  MAX_TTS_ERROR_BYTES,
  sniffAudioMime,
  type ApiKeyProvider,
} from './tts-engines.ts'

export const DEFAULT_DAEMON_BASE_URL = 'http://127.0.0.1:18790'
export const DEFAULT_DAEMON_PROBE_TIMEOUT_MS = 800
export const DEFAULT_DAEMON_TIMEOUT_MS = 8_000
export const DEFAULT_DAEMON_HEALTH_TTL_MS = 15_000
export const DEFAULT_DAEMON_COOLDOWN_MS = 5_000
export const DEFAULT_KOKORO_MODEL = 'kokoro-v1.1-zh'
export const DEFAULT_KOKORO_VOICE = 'zf_001'
export const KOKORO_MAX_SID = 102

const EXPECTED_DAEMON_SERVICE = 'voice-daemon'
const MAX_HEALTH_BYTES = 64 * 1024
const MAX_ERROR_MESSAGE_CHARS = 240
const DEFAULT_SAMPLE_RATE = 16_000
const UTF8_DECODER = new TextDecoder('utf-8')

export type DaemonErrorCode =
  | 'bad_url'
  | 'http_error'
  | 'bad_response'
  | 'bad_audio_payload'
  | 'too_large'
  | 'timeout'
  | 'aborted'
  | 'network'

export class DaemonClientError extends Error {
  readonly code: DaemonErrorCode
  readonly status?: number

  constructor(code: DaemonErrorCode, message: string, status?: number) {
    super(redactSecrets(message))
    this.name = 'DaemonClientError'
    this.code = code
    if (status !== undefined) {
      this.status = status
    }
  }
}

export interface KokoroSpeakerPreset {
  id: string
  sid: number
  label: string
  lang: 'zh' | 'en-us' | 'en-gb'
  gender: 'F' | 'M'
}

/** Curated Kokoro v1.1-zh speaker presets verified against `kokoro-int8-multi-lang-v1_1` (`0..102`). */
export const KOKORO_DEFAULT_SPEAKERS: ReadonlyArray<KokoroSpeakerPreset> = [
  { id: 'zf_001', sid: 3, label: 'Mandarin female (zf_001)', lang: 'zh', gender: 'F' },
  { id: 'zf_xiaobei', sid: 48, label: 'Mandarin female (zf_xiaobei / zf_084)', lang: 'zh', gender: 'F' },
  { id: 'zm_010', sid: 59, label: 'Mandarin male (zm_010)', lang: 'zh', gender: 'M' },
  { id: 'zm_013', sid: 62, label: 'Mandarin deep male (zm_013)', lang: 'zh', gender: 'M' },
  { id: 'af_maple', sid: 0, label: 'English US female (af_maple)', lang: 'en-us', gender: 'F' },
  { id: 'af_sol', sid: 1, label: 'English US female (af_sol)', lang: 'en-us', gender: 'F' },
  { id: 'bf_vale', sid: 2, label: 'English UK female (bf_vale)', lang: 'en-gb', gender: 'F' },
]

export interface DaemonHealthResult {
  ok: boolean
  version: string
  capabilities: string[]
  voices: string[]
  status?: number
  error?: string
}

export interface DaemonClientOptions {
  baseUrl?: string
  token?: ApiKeyProvider
  probeTimeoutMs?: number
  timeoutMs?: number
  healthTtlMs?: number
  cooldownMs?: number
  asrModel?: string
  voice?: string
  rate?: number
  language?: string
  fallbackAsr?: AsrTransport
  fallbackTts?: TtsEngine
  onFallback?: (surface: 'asr' | 'tts', reason: string) => void
  fetchImpl?: typeof fetch
  now?: () => number
}

interface InflightDaemonRequest {
  readonly ac: AbortController
  readonly surface: 'asr' | 'tts'
  markAborted: () => void
}

/**
 * Validate a strict loopback HTTP or HTTPS URL (`127.0.0.1`, `localhost`, `[::1]`),
 * rejecting non-loopback hosts, non-HTTP(S) schemes, and embedded `user:pass@`.
 * Strips trailing slashes and duplicate `/v1` suffixes.
 */
export function resolveDaemonBaseUrl(rawUrl?: string): string {
  const candidate =
    typeof rawUrl === 'string' && rawUrl.trim().length > 0 ? rawUrl.trim() : DEFAULT_DAEMON_BASE_URL
  let parsed: URL
  try {
    parsed = validateLoopbackUrl(candidate)
  } catch (err) {
    throw new DaemonClientError('bad_url', err instanceof Error ? err.message : String(err))
  }

  let basePath = parsed.pathname.replace(/\/+$/, '')
  while (basePath.endsWith('/v1')) {
    basePath = basePath.slice(0, -3).replace(/\/+$/, '')
  }
  return `${parsed.origin}${basePath}`
}

/**
 * Normalize a Kokoro speaker name or numeric speaker index (`0..102`), falling back to `zf_001`.
 */
export function normalizeKokoroVoice(voice?: string): string {
  if (typeof voice !== 'string') return DEFAULT_KOKORO_VOICE
  const trimmed = voice.trim()
  if (!trimmed) return DEFAULT_KOKORO_VOICE
  if (/^-?\d+$/.test(trimmed)) {
    const sid = Number.parseInt(trimmed, 10)
    return Number.isInteger(sid) && sid >= 0 && sid <= KOKORO_MAX_SID
      ? String(sid)
      : DEFAULT_KOKORO_VOICE
  }
  return trimmed
}

function shouldFallback(err: DaemonClientError): boolean {
  if (
    err.code === 'network' ||
    err.code === 'timeout' ||
    err.code === 'bad_audio_payload' ||
    err.code === 'bad_response'
  ) {
    return true
  }
  if (err.code === 'http_error') {
    return (
      err.status === 401 ||
      err.status === 403 ||
      err.status === 404 ||
      err.status === 405 ||
      (err.status !== undefined && err.status >= 500)
    )
  }
  return false
}

export class DaemonClient {
  readonly asr: AsrTransport
  readonly tts: TtsEngine

  private readonly baseUrl: string
  private readonly options: DaemonClientOptions
  private readonly probeTimeoutMs: number
  private readonly timeoutMs: number
  private readonly healthTtlMs: number
  private readonly cooldownMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly inflight = new Set<InflightDaemonRequest>()

  private voiceOverride?: string
  private defaultRate?: number
  private lastError: DaemonClientError | null = null
  private healthyUntil = 0
  private unhealthyUntil = 0
  private lastUnhealthyError: DaemonClientError | null = null
  private closed = false

  private chunks: Float32Array[] = []
  private bufferedSamples = 0
  private sessionMaxSamples = Math.floor(DEFAULT_ENDPOINT_POLICY.maxSpeechSec * DEFAULT_SAMPLE_RATE)
  private sessionLanguage?: string

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = resolveDaemonBaseUrl(options.baseUrl)
    this.options = options
    this.probeTimeoutMs =
      typeof options.probeTimeoutMs === 'number' &&
      Number.isFinite(options.probeTimeoutMs) &&
      options.probeTimeoutMs > 0
        ? options.probeTimeoutMs
        : DEFAULT_DAEMON_PROBE_TIMEOUT_MS
    this.timeoutMs =
      typeof options.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_DAEMON_TIMEOUT_MS
    this.healthTtlMs =
      typeof options.healthTtlMs === 'number' &&
      Number.isFinite(options.healthTtlMs) &&
      options.healthTtlMs >= 0
        ? options.healthTtlMs
        : DEFAULT_DAEMON_HEALTH_TTL_MS
    this.cooldownMs =
      typeof options.cooldownMs === 'number' &&
      Number.isFinite(options.cooldownMs) &&
      options.cooldownMs >= 0
        ? options.cooldownMs
        : DEFAULT_DAEMON_COOLDOWN_MS
    this.fetchImpl = resolveFetchImpl(options.fetchImpl)
    this.now = options.now ?? Date.now

    if (options.voice !== undefined) {
      this.voiceOverride = options.voice.trim()
    }
    if (typeof options.rate === 'number' && Number.isFinite(options.rate) && options.rate > 0) {
      this.defaultRate = options.rate
    }

    this.asr = {
      kind: 'daemon',
      start: (opts) => this.startAsr(opts),
      pushAudio: (pcm16k) => this.pushAudio(pcm16k),
      finalize: (sig) => this.finalizeAsr(sig),
      transcribe: (pcm16k, opts) => this.transcribe(pcm16k, opts),
      abort: () => this.abortAsr(),
      close: () => this.close(),
    }

    this.tts = {
      kind: 'kokoro-daemon',
      mime: 'audio/wav',
      updateVoice: (voice, rate) => this.updateVoice(voice, rate),
      prepare: () => this.prepareTts(),
      status: () => this.ttsStatus(),
      interrupt: () => this.interruptTts(),
      synthesize: (text, opts) => this.synthesize(text, opts),
      close: () => this.close(),
    }
  }

  asAsrTransport(): AsrTransport {
    return this.asr
  }

  asTtsEngine(): TtsEngine {
    return this.tts
  }

  resetHealthCache(): void {
    this.healthyUntil = 0
    this.unhealthyUntil = 0
    this.lastUnhealthyError = null
  }

  async probeHealth(signal?: AbortSignal): Promise<DaemonHealthResult> {
    if (this.closed) {
      return { ok: false, version: '', capabilities: [], voices: [], error: 'Daemon client is closed' }
    }
    if (signal?.aborted) {
      return { ok: false, version: '', capabilities: [], voices: [], error: 'Health probe aborted' }
    }

    const ac = new AbortController()
    let timedOut = false
    const onAbort = (): void => ac.abort(signal?.reason ?? new Error('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = scheduleTimeout(() => {
      timedOut = true
      ac.abort(new Error('Daemon health probe timed out'))
    }, this.probeTimeoutMs)

    try {
      const token = await resolveSecretValue(this.options.token)
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (token.length > 0) {
        headers.Authorization = `Bearer ${token}`
      }

      const res = await raceAbort(
        this.fetchImpl(`${this.baseUrl}/v1/health`, {
          method: 'GET',
          headers,
          signal: ac.signal,
          redirect: 'error',
        }),
        ac.signal,
      )

      if (res.status !== 200) {
        const msg = await readRedactedHttpErrorMessage(
          res,
          MAX_ASR_ERROR_BYTES,
          MAX_ERROR_MESSAGE_CHARS,
          ac.signal,
        )
        this.markUnhealthy(new DaemonClientError('http_error', msg, res.status))
        return {
          ok: false,
          version: '',
          capabilities: [],
          voices: [],
          status: res.status,
          error: msg,
        }
      }

      const body = await readBoundedStreamBytes(
        res,
        MAX_HEALTH_BYTES,
        ac.signal,
        () => new DaemonClientError('too_large', `Daemon health exceeds ${MAX_HEALTH_BYTES} bytes`),
      )
      const parsed: unknown = JSON.parse(UTF8_DECODER.decode(body))
      if (typeof parsed !== 'object' || parsed === null) {
        const err = new DaemonClientError(
          'bad_response',
          'Daemon health endpoint returned invalid JSON object',
        )
        this.markUnhealthy(err)
        return { ok: false, version: '', capabilities: [], voices: [], error: err.message }
      }

      const obj = parsed as {
        ok?: unknown
        service?: unknown
        version?: unknown
        capabilities?: unknown
        voices?: unknown
      }
      if (obj.ok !== true || obj.service !== EXPECTED_DAEMON_SERVICE) {
        const err = new DaemonClientError(
          'bad_response',
          'Loopback endpoint did not identify as service="voice-daemon" with ok=true',
        )
        this.markUnhealthy(err)
        return {
          ok: false,
          version: '',
          capabilities: [],
          voices: [],
          status: res.status,
          error: err.message,
        }
      }

      const capabilities = Array.isArray(obj.capabilities)
        ? obj.capabilities.filter((c): c is string => typeof c === 'string')
        : []
      const voices = Array.isArray(obj.voices)
        ? obj.voices.filter((v): v is string => typeof v === 'string')
        : []

      this.markHealthy()
      return {
        ok: true,
        version: typeof obj.version === 'string' ? obj.version : '',
        capabilities,
        voices,
        status: res.status,
      }
    } catch (err) {
      const code: DaemonErrorCode = timedOut ? 'timeout' : 'network'
      const reason = timedOut
        ? `Daemon health probe timed out after ${this.probeTimeoutMs} ms`
        : redactSecrets(err instanceof Error ? err.message : String(err)).slice(
            0,
            MAX_ERROR_MESSAGE_CHARS,
          )
      this.markUnhealthy(new DaemonClientError(code, reason))
      return {
        ok: false,
        version: '',
        capabilities: [],
        voices: [],
        error: reason,
      }
    } finally {
      cancelTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private markHealthy(): void {
    this.healthyUntil = this.now() + this.healthTtlMs
    this.unhealthyUntil = 0
    this.lastUnhealthyError = null
  }

  private markUnhealthy(err: DaemonClientError): void {
    this.healthyUntil = 0
    this.unhealthyUntil = this.cooldownMs > 0 ? this.now() + this.cooldownMs : 0
    this.lastUnhealthyError = err
    this.lastError = err
  }

  private async ensureDaemonHealthy(signal?: AbortSignal): Promise<void> {
    const now = this.now()
    if (this.cooldownMs > 0 && now < this.unhealthyUntil && this.lastUnhealthyError) {
      throw this.lastUnhealthyError
    }
    if (now < this.healthyUntil) {
      return
    }
    const health = await this.probeHealth(signal)
    if (signal?.aborted) {
      throw new DaemonClientError('aborted', 'Daemon request was aborted')
    }
    if (!health.ok) {
      throw (
        this.lastUnhealthyError ??
        new DaemonClientError(
          health.status !== undefined && health.status !== 200 ? 'http_error' : 'network',
          health.error ?? 'Local voice daemon is unavailable',
          health.status,
        )
      )
    }
  }

  // ── TTS methods (`tts.kind = 'kokoro-daemon'`) ─────────────────────────────

  updateVoice(voice: string, rate?: number): void {
    this.voiceOverride = voice.trim()
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      this.defaultRate = rate
    }
    this.options.fallbackTts?.updateVoice?.(voice, rate)
  }

  async prepareTts(): Promise<void> {
    const health = await this.probeHealth()
    if (!health.ok && !this.options.fallbackTts) {
      throw new DaemonClientError(
        health.status !== undefined && health.status !== 200 ? 'http_error' : 'network',
        health.error ?? 'Local voice daemon is unavailable',
        health.status,
      )
    }
  }

  ttsStatus(): TtsEngineStatus {
    const out: TtsEngineStatus = {
      engine: 'kokoro-daemon',
      ready: !this.closed,
      loading: this.inflight.size > 0,
      keyRequired: false,
    }
    if (this.lastError) {
      out.error = this.lastError.message
      out.errorCode = this.lastError.code
    }
    return out
  }

  interruptTts(): void {
    for (const req of Array.from(this.inflight)) {
      if (req.surface === 'tts') {
        req.markAborted()
        req.ac.abort(new Error('TTS interrupted'))
        this.inflight.delete(req)
      }
    }
    this.options.fallbackTts?.interrupt?.()
  }

  async synthesize(text: string, options?: TtsSynthOptions): Promise<TtsSynthResult> {
    if (this.closed) {
      throw new DaemonClientError('aborted', 'Daemon TTS client is closed')
    }
    if (options?.signal?.aborted) {
      throw new DaemonClientError('aborted', 'Daemon TTS synthesis was aborted')
    }

    if (stripEmotionTags(text).trim().length === 0) {
      return { audio: new Uint8Array(0), mime: 'audio/wav' }
    }

    try {
      await this.ensureDaemonHealthy(options?.signal)
      const result = await this.synthesizePrimary(text, options)
      this.markHealthy()
      this.lastError = null
      return result
    } catch (rawErr) {
      const err =
        rawErr instanceof DaemonClientError
          ? rawErr
          : new DaemonClientError(
              'network',
              rawErr instanceof Error ? rawErr.message : String(rawErr),
            )
      if (err.code === 'aborted' || err.code === 'bad_url') {
        throw err
      }
      this.markUnhealthy(err)
      if (this.options.fallbackTts && shouldFallback(err)) {
        this.options.onFallback?.('tts', err.message)
        const fbOpts: TtsSynthOptions = {}
        if (options?.voice !== undefined) fbOpts.voice = options.voice
        const rate = options?.rate ?? this.defaultRate
        if (rate !== undefined) fbOpts.rate = rate
        if (options?.signal !== undefined) fbOpts.signal = options.signal
        return this.options.fallbackTts.synthesize(text, fbOpts)
      }
      throw err
    }
  }

  private async synthesizePrimary(
    rawText: string,
    options: TtsSynthOptions | undefined,
  ): Promise<TtsSynthResult> {
    const ac = new AbortController()
    let timedOut = false
    let localAborted = false
    let callerAborted = false

    const handle: InflightDaemonRequest = {
      ac,
      surface: 'tts',
      markAborted: () => {
        localAborted = true
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
      ac.abort(new Error('Daemon TTS request timed out'))
    }, this.timeoutMs)

    try {
      const token = await resolveSecretValue(this.options.token)
      if (localAborted || callerAborted || options?.signal?.aborted || this.closed) {
        throw new DaemonClientError('aborted', 'Daemon TTS synthesis was aborted')
      }

      const rawVoice =
        options?.voice !== undefined
          ? options.voice
          : this.voiceOverride !== undefined
            ? this.voiceOverride
            : this.options.voice
      const voice = normalizeKokoroVoice(rawVoice)
      const effectiveSpeed =
        typeof options?.rate === 'number' && Number.isFinite(options.rate) && options.rate > 0
          ? options.rate
          : (this.defaultRate ?? 1.0)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (token.length > 0) {
        headers.Authorization = `Bearer ${token}`
      }

      const res = await raceAbort(
        this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: DEFAULT_KOKORO_MODEL,
            input: rawText,
            voice,
            speed: effectiveSpeed,
            response_format: 'wav',
          }),
          signal: ac.signal,
          redirect: 'error',
        }),
        ac.signal,
      )

      if (!res.ok) {
        const msg = await readRedactedHttpErrorMessage(
          res,
          MAX_TTS_ERROR_BYTES,
          MAX_ERROR_MESSAGE_CHARS,
          ac.signal,
        )
        throw new DaemonClientError('http_error', msg, res.status)
      }

      const audio = await readBoundedStreamBytes(
        res,
        MAX_AUDIO_BYTES,
        ac.signal,
        () => new DaemonClientError('too_large', `Daemon TTS audio exceeds ${MAX_AUDIO_BYTES} bytes`),
      )
      if (localAborted || callerAborted || options?.signal?.aborted) {
        throw new DaemonClientError('aborted', 'Daemon TTS synthesis was aborted')
      }
      if (audio.byteLength === 0) {
        throw new DaemonClientError('bad_audio_payload', 'Daemon returned empty audio payload')
      }

      const sniffed = sniffAudioMime(audio, res.headers.get('content-type') ?? undefined)
      if (!sniffed) {
        throw new DaemonClientError(
          'bad_audio_payload',
          'Daemon returned unrecognized or non-audio payload',
        )
      }
      return { audio, mime: sniffed }
    } catch (err) {
      if (localAborted || callerAborted || options?.signal?.aborted) {
        throw new DaemonClientError('aborted', 'Daemon TTS synthesis was aborted')
      }
      if (timedOut) {
        throw new DaemonClientError('timeout', `Daemon TTS timed out after ${this.timeoutMs} ms`)
      }
      if (err instanceof DaemonClientError) {
        throw err
      }
      throw new DaemonClientError('network', err instanceof Error ? err.message : String(err))
    } finally {
      cancelTimeout(timer)
      options?.signal?.removeEventListener('abort', onCallerAbort)
      this.inflight.delete(handle)
    }
  }

  // ── ASR methods (`asr.kind = 'daemon'`) ────────────────────────────────────

  async startAsr(options?: {
    language?: string
    policy?: Partial<EndpointPolicy>
    signal?: AbortSignal
  }): Promise<void> {
    if (this.closed) {
      throw new DaemonClientError('aborted', 'Daemon ASR transport is closed')
    }
    if (options?.signal?.aborted) {
      throw new DaemonClientError('aborted', 'Daemon ASR session was aborted')
    }
    const maxSec = options?.policy?.maxSpeechSec
    const effectiveMaxSec =
      typeof maxSec === 'number' && Number.isFinite(maxSec) && maxSec > 0
        ? maxSec
        : DEFAULT_ENDPOINT_POLICY.maxSpeechSec
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

  async finalizeAsr(signal?: AbortSignal): Promise<AsrTranscriptEvent> {
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
      throw new DaemonClientError('aborted', 'Daemon ASR transport is closed')
    }
    if (options?.signal?.aborted) {
      throw new DaemonClientError('aborted', 'Daemon ASR transcription was aborted')
    }
    if (!pcm16k || pcm16k.length === 0) {
      return { text: '', isFinal: true, durationMs: 0 }
    }

    try {
      await this.ensureDaemonHealthy(options?.signal)
      const event = await this.transcribePrimary(pcm16k, options)
      this.markHealthy()
      return event
    } catch (rawErr) {
      const err =
        rawErr instanceof DaemonClientError
          ? rawErr
          : new DaemonClientError(
              'network',
              rawErr instanceof Error ? rawErr.message : String(rawErr),
            )
      if (err.code === 'aborted' || err.code === 'bad_url') {
        throw err
      }
      this.markUnhealthy(err)
      if (this.options.fallbackAsr && shouldFallback(err)) {
        this.options.onFallback?.('asr', err.message)
        return this.transcribeViaFallback(pcm16k, options)
      }
      throw err
    }
  }

  private async transcribeViaFallback(
    pcm16k: Float32Array,
    options: { sampleRate?: number; language?: string; signal?: AbortSignal } | undefined,
  ): Promise<AsrTranscriptEvent> {
    const fb = this.options.fallbackAsr
    if (!fb) {
      throw new DaemonClientError('network', 'Daemon ASR fallback is not configured')
    }
    if (typeof fb.transcribe === 'function') {
      return fb.transcribe(pcm16k, options)
    }
    if (fb.start && fb.pushAudio && fb.finalize) {
      const startOpts: { language?: string; signal?: AbortSignal } = {}
      if (options?.language !== undefined) startOpts.language = options.language
      if (options?.signal !== undefined) startOpts.signal = options.signal
      await fb.start(startOpts)
      fb.pushAudio(pcm16k)
      return fb.finalize(options?.signal)
    }
    throw new DaemonClientError('bad_response', 'Configured fallbackAsr lacks transcribe()')
  }

  private async transcribePrimary(
    pcm16k: Float32Array,
    options: { sampleRate?: number; language?: string; signal?: AbortSignal } | undefined,
  ): Promise<AsrTranscriptEvent> {
    if (44 + pcm16k.length * 2 > MAX_ASR_AUDIO_BYTES) {
      throw new DaemonClientError(
        'too_large',
        `Daemon ASR upload exceeds ${MAX_ASR_AUDIO_BYTES} bytes`,
      )
    }

    const ac = new AbortController()
    let timedOut = false
    let localAborted = false
    let callerAborted = false

    const handle: InflightDaemonRequest = {
      ac,
      surface: 'asr',
      markAborted: () => {
        localAborted = true
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
      ac.abort(new Error('Daemon ASR request timed out'))
    }, this.timeoutMs)

    try {
      const token = await resolveSecretValue(this.options.token)
      if (localAborted || callerAborted || options?.signal?.aborted || this.closed) {
        throw new DaemonClientError('aborted', 'Daemon ASR transcription was aborted')
      }

      const effectiveRate =
        typeof options?.sampleRate === 'number' &&
        Number.isFinite(options.sampleRate) &&
        options.sampleRate > 0
          ? Math.round(options.sampleRate)
          : DEFAULT_SAMPLE_RATE
      const wav = encodeMonoPcm16Wav(pcm16k, effectiveRate)
      const model = this.options.asrModel?.trim() || 'sensevoice'
      const rawLang = options?.language !== undefined ? options.language : this.options.language
      const normalizedLang = normalizeWhisperLanguage(rawLang)

      const fields: Array<readonly [string, string]> = [
        ['model', model],
        ['response_format', 'json'],
      ]
      if (normalizedLang !== undefined) {
        fields.push(['language', normalizedLang])
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
      if (token.length > 0) {
        headers.Authorization = `Bearer ${token}`
      }

      const durationMs = Math.round((pcm16k.length / effectiveRate) * 1000)

      const res = await raceAbort(
        this.fetchImpl(`${this.baseUrl}/v1/audio/transcriptions`, {
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
        throw new DaemonClientError('http_error', msg, res.status)
      }

      const body = await readBoundedStreamBytes(
        res,
        MAX_ASR_RESPONSE_BYTES,
        ac.signal,
        () => new DaemonClientError('too_large', `Daemon ASR exceeds ${MAX_ASR_RESPONSE_BYTES} bytes`),
      )
      if (localAborted || callerAborted || options?.signal?.aborted) {
        throw new DaemonClientError('aborted', 'Daemon ASR transcription was aborted')
      }

      const rawText = UTF8_DECODER.decode(body)
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
      if (contentType.includes('text/plain')) {
        return { text: rawText.trim(), isFinal: true, durationMs }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawText)
      } catch {
        throw new DaemonClientError(
          'bad_response',
          `Daemon ASR returned non-JSON response: ${redactBodySnippet(rawText, 160)}`,
        )
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { text?: unknown }).text !== 'string'
      ) {
        throw new DaemonClientError(
          'bad_response',
          'Daemon ASR JSON response must contain a string "text" field',
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
    } catch (err) {
      if (localAborted || callerAborted || options?.signal?.aborted) {
        throw new DaemonClientError('aborted', 'Daemon ASR transcription was aborted')
      }
      if (timedOut) {
        throw new DaemonClientError('timeout', `Daemon ASR timed out after ${this.timeoutMs} ms`)
      }
      if (err instanceof DaemonClientError) {
        throw err
      }
      throw new DaemonClientError('network', err instanceof Error ? err.message : String(err))
    } finally {
      cancelTimeout(timer)
      options?.signal?.removeEventListener('abort', onCallerAbort)
      this.inflight.delete(handle)
    }
  }

  abortAsr(): void {
    this.chunks = []
    this.bufferedSamples = 0
    this.sessionLanguage = undefined
    for (const req of Array.from(this.inflight)) {
      if (req.surface === 'asr') {
        req.markAborted()
        req.ac.abort(new Error('ASR aborted'))
        this.inflight.delete(req)
      }
    }
    this.options.fallbackAsr?.abort?.()
  }

  async close(): Promise<void> {
    this.closed = true
    this.interruptTts()
    this.abortAsr()
    await Promise.all([
      this.options.fallbackTts ? this.options.fallbackTts.close().catch(() => undefined) : undefined,
      this.options.fallbackAsr ? this.options.fallbackAsr.close().catch(() => undefined) : undefined,
    ])
  }
}
