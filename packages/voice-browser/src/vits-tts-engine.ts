/**
 * Offline VITS TTS engine (`vits-wasm`) backed by `SherpaWorkerClient`.
 *
 * Maps `VITS_SPEAKERS` names or numeric speaker IDs (`default sid = 0`, `suyingxue`),
 * clamps playback rate to `[0.5, 2.0]`, strips emotion tags prior to synthesis,
 * honors `AbortSignal` / `interrupt()`, and emits browser-safe `Uint8Array` WAV payloads.
 */

import {
  VITS_SPEAKERS,
  findVitsSpeaker,
  stripEmotionTags,
  type TtsEngine,
  type TtsEngineStatus,
  type TtsSynthOptions,
  type TtsSynthResult,
} from '@voice-mode/core'
import type { SherpaWorkerClient } from './sherpa-worker-client.ts'

export const VITS_DEFAULT_SPEAKER_ID = 0
export const VITS_MIN_RATE = 0.5
export const VITS_MAX_RATE = 2.0

export interface VitsWasmTtsEngineOptions {
  workerClient: SherpaWorkerClient
  /** Initial speaker name or numeric ID (default: `'suyingxue'`, `sid = 0`). */
  voice?: string
  /** Initial speech speed multiplier clamped to `[0.5, 2.0]` (default: `1.0`). */
  rate?: number
  /**
   * Whether `close()` should also dispose the underlying `SherpaWorkerClient` (default: `false`,
   * preserving shared worker lifecycle across Silero VAD and SenseVoice ASR).
   */
  disposeWorkerOnClose?: boolean
}

/**
 * Resolve a speaker name, bilingual label, or numeric string to a non-negative VITS speaker ID.
 * Falls back to `0` (`suyingxue`) when unspecified or unrecognized.
 */
export function resolveVitsSpeakerId(voice?: string): number {
  if (typeof voice !== 'string') return VITS_DEFAULT_SPEAKER_ID
  const trimmed = voice.trim()
  if (!trimmed) return VITS_DEFAULT_SPEAKER_ID

  const catalogMatch = findVitsSpeaker(trimmed)
  if (catalogMatch) return catalogMatch.sid

  const lower = trimmed.toLowerCase()
  const labelMatch = VITS_SPEAKERS.find(
    (s) => s.zh === trimmed || s.en.toLowerCase() === lower,
  )
  if (labelMatch) return labelMatch.sid

  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10)
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed
    }
  }

  return VITS_DEFAULT_SPEAKER_ID
}

/** Clamp VITS synthesis speed multiplier into `[0.5, 2.0]` (default `1.0` on non-finite values). */
export function clampVitsRate(rate?: number): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 1.0
  return Math.min(VITS_MAX_RATE, Math.max(VITS_MIN_RATE, rate))
}

function makeAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason
  }
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string' && reason.length > 0
        ? reason
        : 'VITS synthesis aborted'
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError')
  }
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(makeAbortError(signal.reason))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      reject(makeAbortError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (val) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(val)
      },
      (err) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

export class VitsWasmTtsEngine implements TtsEngine {
  readonly kind = 'vits-wasm' as const
  readonly mime = 'audio/wav'

  private readonly workerClient: SherpaWorkerClient
  private readonly disposeWorkerOnClose: boolean
  private defaultVoice: string
  private defaultRate: number
  private loading = false
  private closed = false
  private lastError: string | undefined = undefined
  private readonly activeControllers = new Set<AbortController>()

  constructor(options: VitsWasmTtsEngineOptions) {
    this.workerClient = options.workerClient
    this.defaultVoice = options.voice ?? 'suyingxue'
    this.defaultRate = clampVitsRate(options.rate)
    this.disposeWorkerOnClose = options.disposeWorkerOnClose ?? false
  }

  updateVoice(voice: string, rate?: number): void {
    this.defaultVoice = voice
    if (rate !== undefined) {
      this.defaultRate = clampVitsRate(rate)
    }
  }

  async prepare(): Promise<void> {
    if (this.closed) {
      throw new Error('VitsWasmTtsEngine is closed')
    }
    this.loading = true
    try {
      await this.workerClient.ensureTtsLoaded()
      this.lastError = undefined
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      this.loading = false
    }
  }

  status(): TtsEngineStatus {
    return {
      engine: this.kind,
      ready: !this.closed && this.workerClient.isLoaded('tts-vits'),
      loading: this.loading,
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  async synthesize(text: string, options?: TtsSynthOptions): Promise<TtsSynthResult> {
    if (this.closed) {
      throw new Error('VitsWasmTtsEngine is closed')
    }
    const callerSignal = options?.signal
    if (callerSignal?.aborted) {
      throw makeAbortError(callerSignal.reason)
    }

    const cleaned = stripEmotionTags(text).replace(/\s+/g, ' ').trim()
    if (cleaned.length === 0) {
      return {
        audio: new Uint8Array(0),
        mime: this.mime,
        sampleRate: 22050,
      }
    }

    const speakerId = resolveVitsSpeakerId(options?.voice ?? this.defaultVoice)
    const speed = clampVitsRate(options?.rate ?? this.defaultRate)

    const localController = new AbortController()
    this.activeControllers.add(localController)
    const onCallerAbort = (): void => {
      localController.abort(callerSignal?.reason)
    }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

    const wasLoaded = this.workerClient.isLoaded('tts-vits')
    if (!wasLoaded) {
      this.loading = true
    }

    try {
      const synthPromise = this.workerClient.synthesizeTts(cleaned, { speakerId, speed })
      // Prevent late unhandled rejections if caller aborts while worker synthesis is still running.
      synthPromise.catch(() => undefined)
      const res = await raceWithSignal(synthPromise, localController.signal)
      if (localController.signal.aborted) {
        throw makeAbortError(localController.signal.reason)
      }
      this.lastError = undefined
      return {
        audio: new Uint8Array(res.audio),
        mime: res.mime,
        sampleRate: res.sampleRate,
      }
    } catch (err) {
      if (!localController.signal.aborted) {
        this.lastError = err instanceof Error ? err.message : String(err)
      }
      throw err
    } finally {
      this.loading = false
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.activeControllers.delete(localController)
    }
  }

  interrupt(): void {
    if (this.activeControllers.size === 0) return
    const controllers = Array.from(this.activeControllers)
    this.activeControllers.clear()
    for (const c of controllers) {
      c.abort(makeAbortError('VITS synthesis interrupted'))
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.interrupt()
    if (this.disposeWorkerOnClose) {
      await this.workerClient.dispose()
    }
  }
}
