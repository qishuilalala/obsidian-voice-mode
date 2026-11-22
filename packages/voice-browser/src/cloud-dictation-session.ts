/**
 * Transport-backed microphone dictation session (`CloudDictationSession`) for BYOK cloud/local-server
 * `AsrTransport` implementations (such as `OpenAiCompatAsrTransport`) across Desktop and Mobile
 * with zero WASM and zero Web Worker dependencies.
 */

import {
  resolveEndpointPolicy,
  type AsrTranscriptEvent,
  type AsrTransport,
  type EndpointPolicy,
} from '@voice-mode/core'
import { computeChunkRms } from './barge-in-monitor.ts'
import {
  DICTATION_PRE_ROLL_SAMPLES,
  createBrowserMicCapture,
  type AudioCaptureFactory,
  type AudioCaptureHandle,
  type DictationMode,
  type DictationSessionState,
  type FinalTranscriptInfo,
  type StopDictationOptions,
} from './dictation-session.ts'
import { TARGET_SAMPLE_RATE } from './resample.ts'

/** Default RMS speech threshold calibrated for `autoGainControl: true` dictation capture. */
export const DEFAULT_CLOUD_SPEECH_RMS_THRESHOLD = 0.008

/** Default minimum consecutive speech duration (ms) required to confirm onset and reject clicks. */
export const DEFAULT_CLOUD_MIN_SPEECH_MS = 160

const INTER_UTTERANCE_SILENCE_LEAD_SAMPLES = Math.round(0.16 * TARGET_SAMPLE_RATE) // 2,560 (160 ms)
const PTT_MIN_DURATION_MS = 150
const PTT_MIN_SAMPLES = Math.round((PTT_MIN_DURATION_MS / 1000) * TARGET_SAMPLE_RATE) // 2,400
const PTT_MIN_PEAK_RMS = 0.002
const RMS_WINDOW_SAMPLES = 512

export interface CloudDictationSessionOptions {
  transport: AsrTransport
  captureAudio?: AudioCaptureFactory
  endpointPolicy?: Partial<EndpointPolicy>
  language?: string
  /** Minimum frame RMS amplitude required to classify a frame as speech (default: 0.008). */
  speechRmsThreshold?: number
  /** Minimum consecutive speech duration in ms required to confirm speech onset (default: 160). */
  minSpeechMs?: number
  workletUrl?: string
  deviceId?: string
  onStateChange?: (state: DictationSessionState) => void
  onSpeechActivity?: (isSpeech: boolean) => void
  onFinalTranscript?: (text: string, info: FinalTranscriptInfo) => void
  onError?: (err: Error) => void
}

function concatFloat32Chunks(chunks: Float32Array[], totalSamples: number): Float32Array {
  if (totalSamples <= 0 || chunks.length === 0) return new Float32Array(0)
  if (chunks.length === 1 && chunks[0].length === totalSamples) return chunks[0]
  const out = new Float32Array(totalSamples)
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, totalSamples - offset)
    if (take <= 0) break
    out.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset)
    offset += take
  }
  return out
}

function computePeakWindowRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let peakRms = 0
  for (let offset = 0; offset < samples.length; offset += RMS_WINDOW_SAMPLES) {
    const end = Math.min(samples.length, offset + RMS_WINDOW_SAMPLES)
    const len = end - offset
    let sumSq = 0
    for (let i = offset; i < end; i++) {
      const v = samples[i]
      sumSq += v * v
    }
    const rms = Math.sqrt(sumSq / len)
    if (rms > peakRms) peakRms = rms
  }
  return peakRms
}

export class CloudDictationSession {
  private readonly transport: AsrTransport
  private readonly captureAudio: AudioCaptureFactory
  private policy: EndpointPolicy
  private language?: string
  private readonly speechRmsThreshold: number
  private readonly minSpeechMs: number
  private readonly workletUrl?: string
  private readonly deviceId?: string
  private readonly onStateChange?: (state: DictationSessionState) => void
  private readonly onSpeechActivity?: (isSpeech: boolean) => void
  private readonly onFinalTranscript?: (text: string, info: FinalTranscriptInfo) => void
  private readonly onError?: (err: Error) => void

  private currentState: DictationSessionState = 'idle'
  private currentMode: DictationMode = 'toggle'
  private sessionEpoch = 0
  private captureHandle: AudioCaptureHandle | null = null
  private inFlightTeardown: Promise<void> | null = null
  private acceptingChunks = false
  private speechActive = false
  private singleUtteranceTriggered = false

  // 640 ms (10,240 samples @ 16 kHz) pre-roll ring buffer
  private readonly preRollRing = new Float32Array(DICTATION_PRE_ROLL_SAMPLES)
  private preRollWritePos = 0
  private preRollCount = 0

  // Candidate speech onset frames buffered until `minSpeechMs` is confirmed so single-frame
  // clicks never trigger utterances AND never overwrite the 640 ms pre-roll before true onset.
  private pendingSpeechChunks: Float32Array[] = []
  private pendingSpeechSamples = 0
  private continuingSpeechFromCap = false

  // Active utterance / push-to-talk accumulator
  private inUtterance = false
  private utteranceChunks: Float32Array[] = []
  private utteranceSamples = 0
  private trailingSilenceSamples = 0

  // Serialized transport transcription queue & active AbortControllers
  private transcribeQueue: Promise<void> = Promise.resolve()
  private readonly inFlightControllers = new Set<AbortController>()
  private stoppingPromise: Promise<void> | null = null
  private singleFinalizePromise: Promise<void> | null = null

  constructor(options: CloudDictationSessionOptions) {
    const hasTranscribe = typeof options.transport?.transcribe === 'function'
    const hasStreaming =
      typeof options.transport?.start === 'function' &&
      typeof options.transport?.pushAudio === 'function' &&
      typeof options.transport?.finalize === 'function'
    if (!hasTranscribe && !hasStreaming) {
      throw new Error(
        'CloudDictationSession requires an AsrTransport implementing transcribe() or start()/pushAudio()/finalize()',
      )
    }

    this.transport = options.transport
    this.captureAudio = options.captureAudio ?? createBrowserMicCapture
    this.policy = resolveEndpointPolicy(options.endpointPolicy)
    this.language = options.language
    this.speechRmsThreshold =
      typeof options.speechRmsThreshold === 'number' && Number.isFinite(options.speechRmsThreshold)
        ? Math.max(0, options.speechRmsThreshold)
        : DEFAULT_CLOUD_SPEECH_RMS_THRESHOLD
    this.minSpeechMs =
      typeof options.minSpeechMs === 'number' && Number.isFinite(options.minSpeechMs)
        ? Math.max(0, options.minSpeechMs)
        : DEFAULT_CLOUD_MIN_SPEECH_MS
    this.workletUrl = options.workletUrl
    this.deviceId = options.deviceId
    this.onStateChange = options.onStateChange
    this.onSpeechActivity = options.onSpeechActivity
    this.onFinalTranscript = options.onFinalTranscript
    this.onError = options.onError
  }

  get state(): DictationSessionState {
    return this.currentState
  }

  get mode(): DictationMode {
    return this.currentMode
  }

  updateEndpointPolicy(partial: Partial<EndpointPolicy>): void {
    this.policy = resolveEndpointPolicy({
      ...this.policy,
      ...(partial.silenceMs !== undefined ? { silenceMs: partial.silenceMs } : {}),
      ...(partial.maxSpeechSec !== undefined ? { maxSpeechSec: partial.maxSpeechSec } : {}),
      ...(partial.vadThreshold !== undefined ? { vadThreshold: partial.vadThreshold } : {}),
      ...(partial.detectVadThreshold !== undefined
        ? { detectVadThreshold: partial.detectVadThreshold }
        : {}),
    })
  }

  updateLanguage(language: string | undefined): void {
    this.language = language
  }

  async start(mode: DictationMode = 'toggle'): Promise<void> {
    if (this.currentState !== 'idle') {
      throw new Error(`Cannot start dictation while session state is "${this.currentState}"`)
    }

    const epoch = ++this.sessionEpoch
    this.currentMode = mode
    this.stoppingPromise = null
    this.singleFinalizePromise = null
    this.singleUtteranceTriggered = false
    this.acceptingChunks = false
    this.resetAudioBuffers()
    this.setSpeechActive(false)
    this.transcribeQueue = Promise.resolve()

    this.setState('starting')

    let acquiredHandle: AudioCaptureHandle | null = null
    try {
      const handle = await this.captureAudio({
        onChunk: (chunk) => this.onCapturedChunk(chunk, epoch),
        onError: (err) => {
          if (epoch === this.sessionEpoch) {
            this.emitError(err)
          }
        },
        workletUrl: this.workletUrl,
        deviceId: this.deviceId,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      })
      acquiredHandle = handle

      // If `abort()`, `stop()`, or a newer `start()` ran while awaiting microphone setup,
      // close ONLY this stale handle without clobbering any newer epoch's state or handle.
      if (epoch !== this.sessionEpoch) {
        await this.cleanupStaleAttempt(handle)
        return
      }

      this.captureHandle = handle
      this.acceptingChunks = true
      this.setState('listening')
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (epoch === this.sessionEpoch) {
        this.acceptingChunks = false
        await this.teardownCapture()
        this.setState('idle')
        this.emitError(error)
        throw error
      }
      if (acquiredHandle) {
        await this.cleanupStaleAttempt(acquiredHandle)
      }
    }
  }

  async stop(options?: StopDictationOptions): Promise<void> {
    if (this.currentState === 'idle') return
    const flush = options?.flush ?? true

    if (!flush) {
      await this.abort()
      return
    }

    if (this.stoppingPromise) {
      return this.stoppingPromise
    }

    const epoch = this.sessionEpoch
    const mode = this.currentMode

    const runStop = async (): Promise<void> => {
      if (this.currentState === 'starting') {
        const cancelEpoch = ++this.sessionEpoch
        await this.teardownCapture()
        if (cancelEpoch === this.sessionEpoch) {
          this.resetAudioBuffers()
          this.setSpeechActive(false)
          this.setState('idle')
        }
        return
      }

      if (this.singleFinalizePromise) {
        await this.singleFinalizePromise
        return
      }

      this.acceptingChunks = false
      if (this.currentState !== 'transcribing') {
        this.setState('stopping')
      }
      await this.teardownCapture()

      if (epoch !== this.sessionEpoch) return

      if (mode === 'push-to-talk') {
        const pcm = this.takeBufferedUtterance()
        this.setSpeechActive(false)
        if (pcm.length >= PTT_MIN_SAMPLES && computePeakWindowRms(pcm) >= PTT_MIN_PEAK_RMS) {
          this.setState('transcribing')
          this.enqueueTranscription(pcm, mode, epoch)
          await this.transcribeQueue
        }
      } else {
        if (this.inUtterance && this.utteranceSamples > 0) {
          const flushed = this.takeBufferedUtterance()
          this.setSpeechActive(false)
          if (flushed.length > 0) {
            this.enqueueTranscription(flushed, mode, epoch)
          }
        } else {
          this.resetAudioBuffers()
          this.setSpeechActive(false)
        }

        this.setState('transcribing')
        await this.transcribeQueue
      }

      if (epoch === this.sessionEpoch) {
        this.setState('idle')
      }
    }

    const p = runStop().finally(() => {
      if (this.stoppingPromise === p) {
        this.stoppingPromise = null
      }
    })
    this.stoppingPromise = p
    return p
  }

  /**
   * Immediately cancel all buffered audio and in-flight transport requests, tear down mic capture,
   * and reset state to `'idle'` without firing `onFinalTranscript` or false `onError`.
   */
  async abort(): Promise<void> {
    if (
      this.currentState === 'idle' &&
      !this.captureHandle &&
      !this.inFlightTeardown &&
      this.inFlightControllers.size === 0
    ) {
      return
    }
    const abortEpoch = ++this.sessionEpoch
    this.acceptingChunks = false
    this.stoppingPromise = null
    this.singleFinalizePromise = null
    this.abortInFlightTransports()
    this.resetAudioBuffers()
    this.setSpeechActive(false)
    await this.teardownCapture()
    if (abortEpoch === this.sessionEpoch) {
      this.setState('idle')
    }
  }

  private onCapturedChunk(chunk: Float32Array, epoch: number): void {
    if (!this.acceptingChunks || epoch !== this.sessionEpoch || chunk.length === 0) return
    if (this.currentMode === 'single' && this.singleUtteranceTriggered) return

    if (this.currentMode === 'push-to-talk') {
      const maxSamples = Math.round(this.policy.maxSpeechSec * TARGET_SAMPLE_RATE)
      const remaining = maxSamples - this.utteranceSamples
      if (remaining <= 0) return
      const copy = chunk.length <= remaining ? chunk.slice() : chunk.subarray(0, remaining).slice()
      this.utteranceChunks.push(copy)
      this.utteranceSamples += copy.length
      const hasVoice = computePeakWindowRms(copy) >= PTT_MIN_PEAK_RMS
      if (hasVoice && !this.speechActive) {
        this.setSpeechActive(true)
      }
      return
    }

    const owned = chunk.slice()
    const isSpeech = computeChunkRms(owned) >= this.speechRmsThreshold
    const minSpeechSamples =
      this.minSpeechMs <= 0 ? 0 : Math.round((this.minSpeechMs / 1000) * TARGET_SAMPLE_RATE)

    if (!this.inUtterance) {
      if (!isSpeech) {
        this.continuingSpeechFromCap = false
        this.setSpeechActive(false)
        if (this.pendingSpeechSamples > 0) {
          for (const pendingChunk of this.pendingSpeechChunks) {
            this.pushPreRoll(pendingChunk)
          }
          this.pendingSpeechChunks = []
          this.pendingSpeechSamples = 0
        }
        this.pushPreRoll(owned)
        return
      }

      if (this.continuingSpeechFromCap) {
        this.continuingSpeechFromCap = false
        this.inUtterance = true
        this.trailingSilenceSamples = 0
        this.setSpeechActive(true)
        this.appendChunkToUtterance(owned, true, epoch)
        return
      }

      if (this.pendingSpeechSamples + owned.length < minSpeechSamples) {
        this.pendingSpeechChunks.push(owned)
        this.pendingSpeechSamples += owned.length
        return
      }

      // Speech onset confirmed: prepend 640 ms (10,240-sample) pre-roll + buffered onset frames!
      this.inUtterance = true
      this.trailingSilenceSamples = 0
      this.setSpeechActive(true)
      const preRoll = this.drainPreRoll()
      const pending = this.pendingSpeechChunks
      this.pendingSpeechChunks = []
      this.pendingSpeechSamples = 0

      if (preRoll.length > 0) {
        this.appendChunkToUtterance(preRoll, true, epoch)
      }
      for (const pendingChunk of pending) {
        this.appendChunkToUtterance(pendingChunk, true, epoch)
      }
      this.appendChunkToUtterance(owned, true, epoch)
      return
    }

    this.appendChunkToUtterance(owned, isSpeech, epoch)
  }

  private appendChunkToUtterance(chunk: Float32Array, isSpeech: boolean, epoch: number): void {
    let cursor = chunk
    while (cursor.length > 0) {
      if (epoch !== this.sessionEpoch) return
      if (this.currentMode === 'single' && this.singleUtteranceTriggered) return

      const maxSpeechSamples = Math.round(this.policy.maxSpeechSec * TARGET_SAMPLE_RATE)
      const silenceTargetSamples = Math.round((this.policy.silenceMs / 1000) * TARGET_SAMPLE_RATE)

      const room = Math.max(0, maxSpeechSamples - this.utteranceSamples)
      const head = cursor.length <= room ? cursor : cursor.subarray(0, room)
      const overflow = cursor.length > room ? cursor.subarray(room) : null

      if (head.length > 0) {
        this.utteranceChunks.push(head)
        this.utteranceSamples += head.length
      }

      if (isSpeech) {
        this.setSpeechActive(true)
        this.trailingSilenceSamples = 0
      } else {
        this.setSpeechActive(false)
        this.trailingSilenceSamples += head.length
      }

      const hitSilenceEndpoint = !isSpeech && this.trailingSilenceSamples >= silenceTargetSamples
      const hitMaxSpeechCap = this.utteranceSamples >= maxSpeechSamples

      if (!hitSilenceEndpoint && !hitMaxSpeechCap) {
        return
      }

      const trailingSilenceBeforeTake = this.trailingSilenceSamples
      const completedPcm = this.takeBufferedUtterance()
      const mode = this.currentMode

      if (mode === 'single') {
        this.singleUtteranceTriggered = true
        this.acceptingChunks = false
        this.setSpeechActive(false)
        const p = this.finishSingleUtterance(completedPcm, epoch).finally(() => {
          if (this.singleFinalizePromise === p) {
            this.singleFinalizePromise = null
          }
        })
        this.singleFinalizePromise = p
        return
      }

      // Seed up to 160 ms (2,560 samples) of trailing silence into pre-roll so an immediately
      // following utterance retains a clean acoustic silence frame before its first phoneme.
      if (hitSilenceEndpoint && trailingSilenceBeforeTake > 0 && completedPcm.length > 0) {
        const leadLen = Math.min(
          INTER_UTTERANCE_SILENCE_LEAD_SAMPLES,
          trailingSilenceBeforeTake,
          completedPcm.length,
        )
        if (leadLen > 0) {
          this.pushPreRoll(completedPcm.subarray(completedPcm.length - leadLen))
        }
      }

      if (completedPcm.length > 0) {
        this.enqueueTranscription(completedPcm, mode, epoch)
      }

      if (overflow && overflow.length > 0) {
        if (isSpeech) {
          this.inUtterance = true
          this.trailingSilenceSamples = 0
          cursor = overflow.slice()
          continue
        }
        this.continuingSpeechFromCap = false
        this.pushPreRoll(overflow)
        return
      }

      this.continuingSpeechFromCap = hitMaxSpeechCap && isSpeech
      return
    }
  }

  private async finishSingleUtterance(completedPcm: Float32Array, epoch: number): Promise<void> {
    await this.teardownCapture()
    if (epoch !== this.sessionEpoch) return

    this.setState('transcribing')
    if (completedPcm.length > 0) {
      this.enqueueTranscription(completedPcm, 'single', epoch)
    }
    await this.transcribeQueue
    if (epoch === this.sessionEpoch) {
      this.setState('idle')
    }
  }

  private enqueueTranscription(pcm: Float32Array, mode: DictationMode, epoch: number): void {
    const language = this.language
    const policy = this.policy
    this.transcribeQueue = this.transcribeQueue
      .then(async () => {
        if (epoch !== this.sessionEpoch) return
        const controller = new AbortController()
        this.inFlightControllers.add(controller)
        try {
          const res = await this.runTransportTranscribe(pcm, language, policy, controller.signal)
          if (epoch !== this.sessionEpoch || controller.signal.aborted) return
          const text = res.text.trim()
          if (text.length > 0) {
            const durationMs =
              typeof res.durationMs === 'number' && res.durationMs > 0
                ? res.durationMs
                : Math.round((pcm.length / TARGET_SAMPLE_RATE) * 1000)
            try {
              this.onFinalTranscript?.(text, { durationMs, mode })
            } catch {
              // Observer errors must not break session pipeline.
            }
          }
        } catch (err) {
          if (epoch === this.sessionEpoch && !controller.signal.aborted) {
            this.emitError(err instanceof Error ? err : new Error(String(err)))
          }
        } finally {
          this.inFlightControllers.delete(controller)
        }
      })
  }

  private async runTransportTranscribe(
    pcm: Float32Array,
    language: string | undefined,
    policy: EndpointPolicy,
    signal: AbortSignal,
  ): Promise<AsrTranscriptEvent> {
    if (typeof this.transport.transcribe === 'function') {
      return this.transport.transcribe(pcm, {
        sampleRate: TARGET_SAMPLE_RATE,
        language,
        signal,
      })
    }
    if (
      typeof this.transport.start === 'function' &&
      typeof this.transport.pushAudio === 'function' &&
      typeof this.transport.finalize === 'function'
    ) {
      await this.transport.start({
        language,
        policy,
        signal,
      })
      if (signal.aborted) {
        return { text: '', isFinal: true }
      }
      this.transport.pushAudio(pcm)
      return this.transport.finalize(signal)
    }
    throw new Error(
      'AsrTransport must implement transcribe() or start()/pushAudio()/finalize()',
    )
  }

  private abortInFlightTransports(): void {
    for (const controller of this.inFlightControllers) {
      try {
        controller.abort()
      } catch {
        // Ignore AbortController errors.
      }
    }
    this.inFlightControllers.clear()
    try {
      this.transport.abort?.()
    } catch {
      // Ignore transport abort errors.
    }
  }

  private pushPreRoll(chunk: Float32Array): void {
    const cap = DICTATION_PRE_ROLL_SAMPLES
    if (chunk.length >= cap) {
      this.preRollRing.set(chunk.subarray(chunk.length - cap), 0)
      this.preRollWritePos = 0
      this.preRollCount = cap
      return
    }
    const firstPart = Math.min(chunk.length, cap - this.preRollWritePos)
    this.preRollRing.set(chunk.subarray(0, firstPart), this.preRollWritePos)
    if (firstPart < chunk.length) {
      this.preRollRing.set(chunk.subarray(firstPart), 0)
    }
    this.preRollWritePos = (this.preRollWritePos + chunk.length) % cap
    this.preRollCount = Math.min(cap, this.preRollCount + chunk.length)
  }

  private drainPreRoll(): Float32Array {
    const count = this.preRollCount
    if (count === 0) return new Float32Array(0)
    const cap = DICTATION_PRE_ROLL_SAMPLES
    const out = new Float32Array(count)
    const start = (this.preRollWritePos - count + cap) % cap
    const tailLen = Math.min(count, cap - start)
    out.set(this.preRollRing.subarray(start, start + tailLen), 0)
    if (tailLen < count) {
      out.set(this.preRollRing.subarray(0, count - tailLen), tailLen)
    }
    this.preRollWritePos = 0
    this.preRollCount = 0
    return out
  }

  private takeBufferedUtterance(): Float32Array {
    const pcm = concatFloat32Chunks(this.utteranceChunks, this.utteranceSamples)
    this.inUtterance = false
    this.utteranceChunks = []
    this.utteranceSamples = 0
    this.trailingSilenceSamples = 0
    return pcm
  }

  private resetAudioBuffers(): void {
    this.preRollWritePos = 0
    this.preRollCount = 0
    this.pendingSpeechChunks = []
    this.pendingSpeechSamples = 0
    this.continuingSpeechFromCap = false
    this.inUtterance = false
    this.utteranceChunks = []
    this.utteranceSamples = 0
    this.trailingSilenceSamples = 0
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

  private async cleanupStaleAttempt(handle: AudioCaptureHandle): Promise<void> {
    if (this.captureHandle === handle) {
      this.captureHandle = null
    }
    await this.safeStopHandle(handle)
  }

  private async safeStopHandle(handle: AudioCaptureHandle): Promise<void> {
    try {
      await handle.stop()
    } catch {
      // Ignore capture teardown errors.
    }
  }

  private setState(next: DictationSessionState): void {
    if (this.currentState === next) return
    this.currentState = next
    try {
      this.onStateChange?.(next)
    } catch {
      // Observer errors must not break state machine.
    }
  }

  private setSpeechActive(active: boolean): void {
    if (this.speechActive === active) return
    this.speechActive = active
    try {
      this.onSpeechActivity?.(active)
    } catch {
      // Observer errors must not break RMS endpointing loop.
    }
  }

  private emitError(err: Error): void {
    try {
      this.onError?.(err)
    } catch {
      // Observer errors must not break error reporting.
    }
  }
}
