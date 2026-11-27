/**
 * Hands-free AEC3 barge-in monitor (`AecBargeInMonitor`) for Chromium/Electron-routed TTS playback.
 *
 * Captures 16 kHz microphone audio with `echoCancellation: true`, `noiseSuppression: true`, and
 * mandatory `autoGainControl: false` (preventing AGC from amplifying residual speaker echo in gaps),
 * verifies live `MediaStreamTrack` AEC3 activation via `probeTrackAec` + `resolveBargeInPolicy`,
 * immediately closes the microphone stream when downgraded to `'manual'`, and triggers `< 600 ms`
 * barge-in on confirmed human speech (`minRmsThreshold = 0.0045`, `confirmChunks = 2` ~128 ms).
 */

import {
  probeTrackAec,
  resolveBargeInPolicy,
  type AecProbeResult,
  type BargeInDowngradeReason,
  type BargeInMode,
  type BargeInPolicy,
  type BargeInPolicyDecision,
  type MediaTrackLike,
} from './aec-probe.ts'
import {
  createBrowserMicCapture,
  type AudioCaptureHandle,
  type AudioCaptureOptions,
} from './dictation-session.ts'
import type { SherpaWorkerClient } from './sherpa-worker-client.ts'

/** 1024 samples @ 16 kHz = 64 ms per frame (exact 2x512 Silero VAD windows, zero carry delay). */
export const DEFAULT_BARGE_IN_CHUNK_SAMPLES = 1024
/** Minimum chunk RMS energy required alongside Silero VAD detection to reject residual echo/clicks. */
export const DEFAULT_BARGE_IN_MIN_RMS = 0.0045
/** Consecutive speech+RMS chunks required to confirm barge-in (`2 * 64 ms = 128 ms < 600 ms`). */
export const DEFAULT_BARGE_IN_CONFIRM_CHUNKS = 2

export type BargeInMonitorState = 'idle' | 'starting' | 'monitoring' | 'stopping'

export interface BargeInCaptureHandle extends AudioCaptureHandle {
  readonly track?: MediaTrackLike | null
  readonly supportedConstraints?: { echoCancellation?: boolean }
}

export type BargeInCaptureFactory = (
  options: AudioCaptureOptions,
) => Promise<BargeInCaptureHandle>

export interface BargeInStartOptions {
  bargeInMode?: BargeInMode
  usesSystemTts?: boolean
  isEdge?: boolean
  isSafari?: boolean
  isMobile?: boolean
}

export interface BargeInStartResult {
  activePolicy: BargeInPolicy
  reason: BargeInDowngradeReason
  aecProbe: AecProbeResult | null
}

export interface BargeInEvent {
  elapsedMs: number
  rms: number
  confirmedChunks: number
  speechProbability: number
}

export interface AecBargeInMonitorOptions {
  workerClient: SherpaWorkerClient
  captureAudio?: BargeInCaptureFactory
  bargeInMode?: BargeInMode
  usesSystemTts?: boolean
  isEdge?: boolean
  isSafari?: boolean
  isMobile?: boolean
  workletUrl?: string
  deviceId?: string
  /** Samples per 16 kHz capture frame (default: 1024 = 64 ms). */
  chunkSamples?: number
  /** Minimum chunk RMS energy threshold (default: 0.0045). */
  minRmsThreshold?: number
  /** Consecutive confirmed speech chunks required before firing `onBargeIn` (default: 2 = ~128 ms). */
  confirmChunks?: number
  /** Invoked once when speech is confirmed; microphone capture stops automatically before/upon firing. */
  onBargeIn?: (event: BargeInEvent) => void
  /** Invoked whenever hands-free barge-in downgrades to `'manual'`. */
  onDowngrade?: (decision: BargeInPolicyDecision, aecProbe: AecProbeResult | null) => void
  onError?: (err: Error) => void
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** Compute root-mean-square amplitude over a mono PCM frame. */
export function computeChunkRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    sumSq += s * s
  }
  return Math.sqrt(sumSq / samples.length)
}

/**
 * Default browser/Electron microphone capture configured specifically for AEC3 barge-in monitoring.
 * Forces `echoCancellation: true`, `noiseSuppression: true`, and `autoGainControl: false` (M0 S0-6).
 */
export function createBargeInMicCapture(
  options: AudioCaptureOptions,
): Promise<BargeInCaptureHandle> {
  return createBrowserMicCapture({
    ...options,
    echoCancellation: options.echoCancellation ?? true,
    noiseSuppression: options.noiseSuppression ?? true,
    autoGainControl: options.autoGainControl ?? false,
    chunkSamples: options.chunkSamples ?? DEFAULT_BARGE_IN_CHUNK_SAMPLES,
  })
}

export class AecBargeInMonitor {
  private readonly workerClient: SherpaWorkerClient
  private readonly captureAudio: BargeInCaptureFactory
  private bargeInMode: BargeInMode
  private usesSystemTts: boolean
  private readonly isEdge: boolean
  private readonly isSafari: boolean
  private readonly isMobile: boolean
  private readonly workletUrl?: string
  private readonly deviceId?: string
  private readonly chunkSamples: number
  private readonly minRmsThreshold: number
  private readonly confirmChunks: number
  private readonly onBargeIn?: (event: BargeInEvent) => void
  private readonly onDowngrade?: (
    decision: BargeInPolicyDecision,
    aecProbe: AecProbeResult | null,
  ) => void
  private readonly onError?: (err: Error) => void

  private currentState: BargeInMonitorState = 'idle'
  private currentPolicy: BargeInPolicy | null = null
  private monitorEpoch = 0
  private startedAtMs = 0
  private captureHandle: BargeInCaptureHandle | null = null
  private inFlightTeardown: Promise<void> | null = null
  private acceptingChunks = false
  private bargeInTriggered = false
  private consecutiveSpeechChunks = 0
  private nonSpeechChunksSinceReset = 0
  private vadQueue: Promise<void> = Promise.resolve()

  constructor(options: AecBargeInMonitorOptions) {
    this.workerClient = options.workerClient
    this.captureAudio = options.captureAudio ?? createBargeInMicCapture
    this.bargeInMode = options.bargeInMode ?? 'detect'
    this.usesSystemTts = options.usesSystemTts ?? false
    this.isEdge = options.isEdge ?? false
    this.isSafari = options.isSafari ?? false
    this.isMobile = options.isMobile ?? false
    this.workletUrl = options.workletUrl
    this.deviceId = options.deviceId
    this.chunkSamples = Math.max(128, Math.floor(options.chunkSamples ?? DEFAULT_BARGE_IN_CHUNK_SAMPLES))
    this.minRmsThreshold =
      typeof options.minRmsThreshold === 'number' && Number.isFinite(options.minRmsThreshold)
        ? Math.max(0, options.minRmsThreshold)
        : DEFAULT_BARGE_IN_MIN_RMS
    this.confirmChunks = Math.max(1, Math.floor(options.confirmChunks ?? DEFAULT_BARGE_IN_CONFIRM_CHUNKS))
    this.onBargeIn = options.onBargeIn
    this.onDowngrade = options.onDowngrade
    this.onError = options.onError
  }

  get state(): BargeInMonitorState {
    return this.currentState
  }

  get activePolicy(): BargeInPolicy | null {
    return this.currentPolicy
  }

  updateMode(mode: BargeInMode): void {
    this.bargeInMode = mode
  }

  updateUsesSystemTts(usesSystemTts: boolean): void {
    this.usesSystemTts = usesSystemTts
  }

  /**
   * Start barge-in monitoring for an active TTS utterance/stream.
   * Returns the resolved policy (`'auto'` when actively monitoring, `'manual'` when downgraded or manual).
   */
  async start(overrides?: BargeInStartOptions): Promise<BargeInStartResult> {
    if (this.currentState !== 'idle') {
      await this.stop()
    }

    const mode = overrides?.bargeInMode ?? this.bargeInMode
    const usesSystemTts = overrides?.usesSystemTts ?? this.usesSystemTts
    const isEdge = overrides?.isEdge ?? this.isEdge
    const isSafari = overrides?.isSafari ?? this.isSafari
    const isMobile = overrides?.isMobile ?? this.isMobile

    // Fast pre-capture gate: never open the OS microphone when policy already forbids hands-free
    // barge-in regardless of hardware AEC (e.g. `manual`, `usesSystemTts: true`, Mobile, Edge/Safari in `detect`).
    const optimisticDecision = resolveBargeInPolicy({
      requestedMode: mode,
      usesSystemTts,
      isEdge,
      isSafari,
      isMobile,
      nativeAecActive: true,
    })
    if (!optimisticDecision.allowHandsFreeBargeIn) {
      this.currentPolicy = 'manual'
      if (optimisticDecision.reason !== 'user-selected-manual') {
        this.emitDowngrade(optimisticDecision, null)
      }
      return {
        activePolicy: 'manual',
        reason: optimisticDecision.reason,
        aecProbe: null,
      }
    }

    const epoch = ++this.monitorEpoch
    this.acceptingChunks = false
    this.bargeInTriggered = false
    this.consecutiveSpeechChunks = 0
    this.nonSpeechChunksSinceReset = 0
    this.currentPolicy = null
    this.currentState = 'starting'

    let acquiredHandle: BargeInCaptureHandle | null = null
    try {
      const bufferedEarlyChunks: Float32Array[] = []
      let vadReady = false

      const handle = await this.captureAudio({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        chunkSamples: this.chunkSamples,
        workletUrl: this.workletUrl,
        deviceId: this.deviceId,
        onChunk: (chunk) => {
          if (!this.acceptingChunks || epoch !== this.monitorEpoch || this.bargeInTriggered) return
          if (chunk.length === 0) return
          const copy = chunk.slice()
          if (!vadReady) {
            bufferedEarlyChunks.push(copy)
            return
          }
          this.enqueueVadChunk(copy, epoch)
        },
        onError: (err) => {
          if (epoch === this.monitorEpoch) {
            this.emitError(err)
          }
        },
      })
      acquiredHandle = handle

      // If `stop()` or a newer `start()` ran while awaiting microphone setup, close ONLY this
      // stale handle without clobbering any newer epoch's state, policy, or captureHandle.
      if (epoch !== this.monitorEpoch) {
        await this.cleanupStaleAttempt(handle)
        return {
          activePolicy: 'manual',
          reason: 'user-selected-manual',
          aecProbe: null,
        }
      }

      const aecProbe = probeTrackAec(handle.track, handle.supportedConstraints)
      const decision = resolveBargeInPolicy({
        requestedMode: mode,
        usesSystemTts,
        isEdge,
        isSafari,
        isMobile,
        nativeAecActive: aecProbe.nativeAecActive,
      })

      if (!decision.allowHandsFreeBargeIn) {
        // Honest auto-downgrade: immediately close the mic stream BEFORE returning so zero mic
        // indicator stays lit and zero uncancelled speaker echo can self-interrupt playback!
        await this.safeStopHandle(handle)
        if (epoch === this.monitorEpoch) {
          this.currentState = 'idle'
          this.currentPolicy = 'manual'
        }
        this.emitDowngrade(decision, aecProbe)
        return {
          activePolicy: 'manual',
          reason: decision.reason,
          aecProbe,
        }
      }

      this.captureHandle = handle
      this.startedAtMs = nowMs()
      this.acceptingChunks = true
      this.vadQueue = Promise.resolve()
      this.workerClient.setKeepAlive(true)

      await this.workerClient.ensureVadLoaded()
      if (epoch !== this.monitorEpoch) {
        await this.cleanupStaleAttempt(handle)
        return {
          activePolicy: 'manual',
          reason: 'user-selected-manual',
          aecProbe,
        }
      }

      await this.workerClient.resetVad()
      if (epoch !== this.monitorEpoch) {
        await this.cleanupStaleAttempt(handle)
        return {
          activePolicy: 'manual',
          reason: 'user-selected-manual',
          aecProbe,
        }
      }

      this.currentPolicy = 'auto'
      this.currentState = 'monitoring'
      vadReady = true
      for (const early of bufferedEarlyChunks) {
        this.enqueueVadChunk(early, epoch)
      }
      bufferedEarlyChunks.length = 0

      return {
        activePolicy: 'auto',
        reason: 'ok',
        aecProbe,
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (epoch === this.monitorEpoch) {
        this.acceptingChunks = false
        await this.teardownCapture()
        this.workerClient.setKeepAlive(false)
        this.currentState = 'idle'
        this.currentPolicy = null
        this.emitError(error)
      } else if (acquiredHandle) {
        await this.cleanupStaleAttempt(acquiredHandle)
      }
      throw error
    }
  }

  /** Stop active microphone capture and cancel any pending VAD barge-in evaluations. */
  async stop(): Promise<void> {
    if (this.currentState === 'idle' && !this.captureHandle && !this.inFlightTeardown) {
      this.currentPolicy = null
      return
    }
    this.monitorEpoch++
    this.acceptingChunks = false
    this.consecutiveSpeechChunks = 0
    this.currentState = 'stopping'
    this.workerClient.setKeepAlive(false)
    await this.teardownCapture()
    this.currentPolicy = null
    this.currentState = 'idle'
  }

  private enqueueVadChunk(chunk: Float32Array, epoch: number): void {
    this.vadQueue = this.vadQueue
      .then(() => this.evaluateChunk(chunk, epoch))
      .catch((err) => {
        if (epoch === this.monitorEpoch && !this.bargeInTriggered) {
          this.emitError(err instanceof Error ? err : new Error(String(err)))
        }
      })
  }

  private async evaluateChunk(chunk: Float32Array, epoch: number): Promise<void> {
    if (!this.acceptingChunks || epoch !== this.monitorEpoch || this.bargeInTriggered) return

    const rms = computeChunkRms(chunk)
    const vadRes = await this.workerClient.processVad(chunk)

    if (!this.acceptingChunks || epoch !== this.monitorEpoch || this.bargeInTriggered) return

    if (vadRes.isSpeech && rms >= this.minRmsThreshold) {
      this.consecutiveSpeechChunks++
      this.nonSpeechChunksSinceReset = 0
    } else {
      this.consecutiveSpeechChunks = 0
      this.nonSpeechChunksSinceReset++
      // Refresh Silero VAD RNN & 60s circular buffer every ~25.6s of non-speech so multi-minute
      // read-aloud sessions never wrap the C++ buffer or accumulate stale noise state.
      if (this.nonSpeechChunksSinceReset >= 400) {
        this.nonSpeechChunksSinceReset = 0
        await this.workerClient.resetVad()
      }
      return
    }

    if (this.consecutiveSpeechChunks < this.confirmChunks) {
      return
    }

    // Confirmed human speech barge-in: halt further chunk processing, release mic stream,
    // and notify caller (`< 600 ms` target; ~128-200 ms typical).
    this.bargeInTriggered = true
    this.acceptingChunks = false
    const confirmedChunks = this.consecutiveSpeechChunks
    const elapsedMs = Math.max(0, Math.round(nowMs() - this.startedAtMs))

    this.monitorEpoch++
    this.currentState = 'stopping'
    this.workerClient.setKeepAlive(false)
    await this.teardownCapture()
    this.currentPolicy = null
    this.currentState = 'idle'

    try {
      this.onBargeIn?.({
        elapsedMs,
        rms,
        confirmedChunks,
        speechProbability: vadRes.speechProbability,
      })
    } catch {
      // Observer errors must not escape post-teardown callback.
    }
  }

  private async teardownCapture(): Promise<void> {
    const handle = this.captureHandle
    this.captureHandle = null
    if (handle) {
      const p = this.safeStopHandle(handle).finally(() => {
        if (this.inFlightTeardown === p) {
          this.inFlightTeardown = null
        }
      })
      this.inFlightTeardown = p
      await p
    } else if (this.inFlightTeardown) {
      await this.inFlightTeardown
    }
  }

  private async cleanupStaleAttempt(handle: BargeInCaptureHandle): Promise<void> {
    if (this.captureHandle === handle) {
      this.captureHandle = null
    }
    await this.safeStopHandle(handle)
  }

  private async safeStopHandle(handle: BargeInCaptureHandle): Promise<void> {
    try {
      await handle.stop()
    } catch {
      // Ignore capture teardown errors.
    }
  }

  private emitDowngrade(decision: BargeInPolicyDecision, aecProbe: AecProbeResult | null): void {
    try {
      this.onDowngrade?.(decision, aecProbe)
    } catch {
      // Observer errors must not break policy resolution.
    }
  }

  private emitError(err: Error): void {
    try {
      this.onError?.(err)
    } catch {
      // Observer errors must not break monitor loop.
    }
  }
}

export interface BargeInGuardOptions {
  /** Returns whether barge-in monitoring should be armed for this utterance (`manual` callers return false). */
  shouldArm: (engineIsSystem: boolean) => boolean
  /** Start microphone monitoring; callers own async error handling (fire-and-forget is fine). */
  arm: () => void
  /** Stop microphone monitoring. */
  disarm: () => void
}

export interface BargeInGuard {
  /** Re-evaluate the target from one utterance's ACTUAL playback engine; de-duplicates repeated targets. */
  update: (engineIsSystem: boolean) => void
  /** Cancel/turn-end: disarm if armed and clear the cached target so the next turn starts clean. */
  reset: () => void
}

/**
 * Per-utterance AEC3 barge-in arm/disarm guard.
 *
 * Feed it the actual playback engine of every utterance (`from onPlayStart / info.engine`), not the
 * configured or predicted engine: `update(info.engine === 'system')`. The guard only calls
 * `arm`/`disarm` when the desired state actually changes, so consecutive utterances on the same path
 * never close/reopen the microphone (which would restart AEC3 convergence). Call `reset()` when
 * playback is cancelled or a turn ends: it disarms if needed and clears the cache so stale armed
 * state never leaks into the next turn.
 */
export function createBargeInGuard(options: BargeInGuardOptions): BargeInGuard {
  let targetArmed = false
  return {
    update(engineIsSystem: boolean): void {
      const wantArmed = options.shouldArm(engineIsSystem)
      if (wantArmed === targetArmed) return
      targetArmed = wantArmed
      if (wantArmed) options.arm()
      else options.disarm()
    },
    reset(): void {
      if (targetArmed) options.disarm()
      targetArmed = false
    },
  }
}
