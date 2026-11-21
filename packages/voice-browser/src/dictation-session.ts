/**
 * Offline dictation session orchestrating 16 kHz microphone capture, 640 ms (10,240-sample)
 * pre-roll ring buffering, serialized Silero VAD endpointing, 60 s utterance capping, and
 * SenseVoice transcription across `toggle`, `single`, and `push-to-talk` modes.
 */

import { resolveEndpointPolicy, type EndpointPolicy } from '@voice-mode/core'
import { VOICE_CAPTURE_PROCESSOR_NAME, createWorkletModuleUrl } from './audio-worklet-source.ts'
import { TARGET_SAMPLE_RATE } from './resample.ts'
import type { SherpaWorkerClient } from './sherpa-worker-client.ts'

export type DictationMode = 'toggle' | 'single' | 'push-to-talk'

export type DictationSessionState = 'idle' | 'starting' | 'listening' | 'transcribing' | 'stopping'

/** 640 ms pre-roll preserved before VAD speech onset so leading syllables are never clipped. */
export const DICTATION_PRE_ROLL_MS = 640
export const DICTATION_PRE_ROLL_SAMPLES = (DICTATION_PRE_ROLL_MS * TARGET_SAMPLE_RATE) / 1000 // 10,240

const SILERO_DEFAULT_MIN_SILENCE_SAMPLES = Math.round(0.35 * TARGET_SAMPLE_RATE) // 5,600 (350 ms)
const INTER_UTTERANCE_SILENCE_LEAD_SAMPLES = Math.round(0.16 * TARGET_SAMPLE_RATE) // 2,560 (160 ms)
const PTT_MIN_DURATION_MS = 150
const PTT_MIN_SAMPLES = Math.round((PTT_MIN_DURATION_MS / 1000) * TARGET_SAMPLE_RATE) // 2,400
const PTT_MIN_PEAK_RMS = 0.002
const RMS_WINDOW_SAMPLES = 512

export interface AudioCaptureOptions {
  onChunk: (pcm16k: Float32Array) => void
  onError?: (err: Error) => void
  workletUrl?: string
  deviceId?: string
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  chunkSamples?: number
}

export interface AudioCaptureHandle {
  stop(): Promise<void>
}

export type AudioCaptureFactory = (options: AudioCaptureOptions) => Promise<AudioCaptureHandle>

export interface FinalTranscriptInfo {
  durationMs: number
  mode: DictationMode
}

export interface StopDictationOptions {
  /** Flush and transcribe any in-progress speech segment before resolving (default: true). */
  flush?: boolean
}

export interface OfflineDictationSessionOptions {
  workerClient: SherpaWorkerClient
  captureAudio?: AudioCaptureFactory
  endpointPolicy?: Partial<EndpointPolicy>
  language?: string
  workletUrl?: string
  deviceId?: string
  onStateChange?: (state: DictationSessionState) => void
  onSpeechActivity?: (isSpeech: boolean) => void
  onFinalTranscript?: (text: string, info: FinalTranscriptInfo) => void
  onError?: (err: Error) => void
}

/**
 * Default browser/Electron microphone capture using `getUserMedia` + `AudioContext` +
 * `VOICE_CAPTURE_PROCESSOR_NAME` AudioWorklet resampler + zero-gain sink node.
 */
export async function createBrowserMicCapture(
  options: AudioCaptureOptions,
): Promise<AudioCaptureHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture (navigator.mediaDevices.getUserMedia) is unavailable')
  }

  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: options.echoCancellation ?? true,
    noiseSuppression: options.noiseSuppression ?? true,
    autoGainControl: options.autoGainControl ?? true,
  }
  if (options.deviceId) {
    audioConstraints.deviceId = { exact: options.deviceId }
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
  let workletHandle: { url: string; revoke: () => void } | null = null
  let audioContext: AudioContext | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let workletNode: AudioWorkletNode | null = null
  let sinkGain: GainNode | null = null
  let stopped = false

  const teardown = async (): Promise<void> => {
    if (stopped) return
    stopped = true

    if (workletNode) {
      try {
        workletNode.port.onmessage = null
        workletNode.port.postMessage({ type: 'stop' })
      } catch {
        // Ignore port teardown errors.
      }
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect()
      } catch {
        // Ignore disconnect errors.
      }
    }
    if (workletNode) {
      try {
        workletNode.disconnect()
      } catch {
        // Ignore disconnect errors.
      }
    }
    if (sinkGain) {
      try {
        sinkGain.disconnect()
      } catch {
        // Ignore disconnect errors.
      }
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop()
      } catch {
        // Ignore track stop errors.
      }
    }
    if (audioContext) {
      try {
        if (audioContext.state !== 'closed') {
          await audioContext.close()
        }
      } catch {
        // Ignore context close errors.
      }
    }
    if (workletHandle) {
      try {
        workletHandle.revoke()
      } catch {
        // Ignore revoke errors.
      }
    }
  }

  try {
    workletHandle = createWorkletModuleUrl(options.workletUrl)
    audioContext = new AudioContext()
    await audioContext.audioWorklet.addModule(workletHandle.url)
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    sourceNode = audioContext.createMediaStreamSource(stream)
    workletNode = new AudioWorkletNode(audioContext, VOICE_CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {
        targetSampleRate: TARGET_SAMPLE_RATE,
        chunkSamples: options.chunkSamples ?? 1024,
      },
    })
    sinkGain = audioContext.createGain()
    sinkGain.gain.value = 0

    workletNode.port.onmessage = (ev: MessageEvent<unknown>) => {
      if (stopped) return
      const payload = ev.data
      if (payload instanceof Float32Array && payload.length > 0) {
        options.onChunk(payload)
      } else if (payload instanceof ArrayBuffer && payload.byteLength > 0) {
        options.onChunk(new Float32Array(payload))
      }
    }
    workletNode.onprocessorerror = () => {
      if (stopped) return
      options.onError?.(new Error('AudioWorklet voice capture processor error'))
    }

    sourceNode.connect(workletNode)
    workletNode.connect(sinkGain)
    sinkGain.connect(audioContext.destination)

    return { stop: teardown }
  } catch (err) {
    await teardown()
    throw err
  }
}

function concatFloat32Chunks(chunks: Float32Array[], totalSamples: number): Float32Array {
  if (totalSamples <= 0 || chunks.length === 0) return new Float32Array(0)
  if (chunks.length === 1 && chunks[0]!.length === totalSamples) return chunks[0]!
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
      const v = samples[i]!
      sumSq += v * v
    }
    const rms = Math.sqrt(sumSq / len)
    if (rms > peakRms) peakRms = rms
  }
  return peakRms
}

export class OfflineDictationSession {
  private readonly workerClient: SherpaWorkerClient
  private readonly captureAudio: AudioCaptureFactory
  private policy: EndpointPolicy
  private language?: string
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
  private acceptingChunks = false
  private speechActive = false
  private singleUtteranceTriggered = false

  // 640 ms (10,240 samples @ 16 kHz) pre-roll ring buffer
  private readonly preRollRing = new Float32Array(DICTATION_PRE_ROLL_SAMPLES)
  private preRollWritePos = 0
  private preRollCount = 0

  // Active utterance / push-to-talk accumulator
  private inUtterance = false
  private utteranceChunks: Float32Array[] = []
  private utteranceSamples = 0
  private trailingSilenceSamples = 0

  // Strictly ordered async pipelines
  private vadQueue: Promise<void> = Promise.resolve()
  private transcribeQueue: Promise<void> = Promise.resolve()
  private stoppingPromise: Promise<void> | null = null

  constructor(options: OfflineDictationSessionOptions) {
    this.workerClient = options.workerClient
    this.captureAudio = options.captureAudio ?? createBrowserMicCapture
    this.policy = resolveEndpointPolicy(options.endpointPolicy)
    this.language = options.language
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
    this.policy = resolveEndpointPolicy(partial)
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
    this.singleUtteranceTriggered = false
    this.acceptingChunks = false
    this.resetAudioBuffers()
    this.setSpeechActive(false)
    this.vadQueue = Promise.resolve()
    this.transcribeQueue = Promise.resolve()

    this.setState('starting')
    this.workerClient.setKeepAlive(true)

    try {
      if (mode === 'push-to-talk') {
        await this.workerClient.ensureAsrLoaded()
      } else {
        await Promise.all([
          this.workerClient.ensureVadLoaded(),
          this.workerClient.ensureAsrLoaded(),
        ])
        if (epoch === this.sessionEpoch) {
          await this.workerClient.resetVad()
        }
      }

      if (epoch !== this.sessionEpoch) {
        this.workerClient.setKeepAlive(false)
        this.setState('idle')
        return
      }

      const handle = await this.captureAudio({
        onChunk: (chunk) => this.onCapturedChunk(chunk, epoch),
        onError: (err) => this.emitError(err),
        workletUrl: this.workletUrl,
        deviceId: this.deviceId,
      })

      if (epoch !== this.sessionEpoch) {
        await this.safeStopHandle(handle)
        this.workerClient.setKeepAlive(false)
        this.setState('idle')
        return
      }

      this.captureHandle = handle
      this.acceptingChunks = true
      this.setState('listening')
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (epoch === this.sessionEpoch) {
        await this.teardownCapture()
        this.workerClient.setKeepAlive(false)
        this.setState('idle')
      }
      this.emitError(error)
      throw error
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
        // Cancel startup cleanly when stopped before mic capture is open.
        this.sessionEpoch++
        await this.teardownCapture()
        this.resetAudioBuffers()
        this.setSpeechActive(false)
        this.workerClient.setKeepAlive(false)
        this.setState('idle')
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
        if (pcm.length >= PTT_MIN_SAMPLES && computePeakWindowRms(pcm) > PTT_MIN_PEAK_RMS) {
          this.setState('transcribing')
          this.enqueueTranscription(pcm, mode, epoch)
          await this.transcribeQueue
        }
      } else {
        // Wait for all captured chunks already queued into VAD to finish endpoint evaluation.
        await this.vadQueue
        if (epoch !== this.sessionEpoch) return

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
        this.workerClient.setKeepAlive(false)
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

  /** Immediately discard all buffered audio, ignore in-flight VAD/ASR results, and close mic capture. */
  async abort(): Promise<void> {
    if (this.currentState === 'idle') return
    this.sessionEpoch++
    this.acceptingChunks = false
    this.stoppingPromise = null
    this.resetAudioBuffers()
    this.setSpeechActive(false)
    this.workerClient.setKeepAlive(false)
    await this.teardownCapture()
    this.setState('idle')
  }

  private onCapturedChunk(chunk: Float32Array, epoch: number): void {
    if (!this.acceptingChunks || epoch !== this.sessionEpoch || chunk.length === 0) return

    if (this.currentMode === 'push-to-talk') {
      const maxSamples = Math.round(this.policy.maxSpeechSec * TARGET_SAMPLE_RATE)
      const remaining = maxSamples - this.utteranceSamples
      if (remaining <= 0) return
      const copy = chunk.length <= remaining ? chunk.slice() : chunk.subarray(0, remaining).slice()
      this.utteranceChunks.push(copy)
      this.utteranceSamples += copy.length
      const hasVoice = computePeakWindowRms(copy) > PTT_MIN_PEAK_RMS
      if (hasVoice && !this.speechActive) {
        this.setSpeechActive(true)
      }
      return
    }

    // Copy chunk immediately in case caller reuses buffers; serialize through VAD queue.
    const ownedChunk = chunk.slice()
    this.vadQueue = this.vadQueue
      .then(() => this.processStreamingChunk(ownedChunk, epoch))
      .catch((err) => {
        if (epoch === this.sessionEpoch) {
          this.emitError(err instanceof Error ? err : new Error(String(err)))
        }
      })
  }

  private async processStreamingChunk(chunk: Float32Array, epoch: number): Promise<void> {
    if (epoch !== this.sessionEpoch) return
    if (this.currentMode === 'single' && this.singleUtteranceTriggered) return

    const vadRes = await this.workerClient.processVad(chunk)
    if (epoch !== this.sessionEpoch) return
    if (this.currentMode === 'single' && this.singleUtteranceTriggered) return

    const isSpeech = vadRes.isSpeech
    this.setSpeechActive(isSpeech)

    if (!this.inUtterance) {
      if (!isSpeech) {
        this.pushPreRoll(chunk)
        return
      }
      // Speech onset: prepend 640 ms (10,240-sample) pre-roll ring buffer!
      this.inUtterance = true
      this.trailingSilenceSamples = 0
      const preRoll = this.drainPreRoll()
      if (preRoll.length > 0) {
        this.utteranceChunks.push(preRoll)
        this.utteranceSamples += preRoll.length
      }
    }

    const maxSpeechSamples = Math.round(this.policy.maxSpeechSec * TARGET_SAMPLE_RATE)
    const silenceTargetSamples = Math.round((this.policy.silenceMs / 1000) * TARGET_SAMPLE_RATE)

    // Append up to `maxSpeechSamples` so utterance never exceeds the hard cap (60s default).
    const room = Math.max(0, maxSpeechSamples - this.utteranceSamples)
    const head = chunk.length <= room ? chunk : chunk.subarray(0, room)
    const overflow = chunk.length > room ? chunk.subarray(room) : null

    if (head.length > 0) {
      this.utteranceChunks.push(head)
      this.utteranceSamples += head.length
    }

    if (isSpeech) {
      this.trailingSilenceSamples = 0
    } else {
      this.trailingSilenceSamples += head.length
      if (vadRes.speechEnded) {
        // Silero VAD holds `isDetected() === true` during its internal 500 ms hangover before
        // emitting `speechEnded = true`; credit up to that hangover so total silence aligns with `silenceMs`.
        this.trailingSilenceSamples = Math.max(
          this.trailingSilenceSamples,
          Math.min(SILERO_DEFAULT_MIN_SILENCE_SAMPLES, silenceTargetSamples),
        )
      }
    }

    const hitSilenceEndpoint =
      !isSpeech &&
      (this.trailingSilenceSamples >= silenceTargetSamples ||
        (vadRes.speechEnded && this.policy.silenceMs <= 400))
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
      await this.teardownCapture()
      if (epoch !== this.sessionEpoch) return

      this.setState('transcribing')
      if (completedPcm.length > 0) {
        this.enqueueTranscription(completedPcm, mode, epoch)
      }
      void this.transcribeQueue.then(() => {
        if (epoch === this.sessionEpoch) {
          this.workerClient.setKeepAlive(false)
          this.setState('idle')
        }
      })
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

    // `'toggle'` mode: dispatch completed utterance in background while continuing capture seamlessly!
    if (completedPcm.length > 0) {
      this.enqueueTranscription(completedPcm, mode, epoch)
    }

    if (overflow && overflow.length > 0) {
      if (isSpeech) {
        this.inUtterance = true
        this.utteranceChunks.push(overflow.slice())
        this.utteranceSamples = overflow.length
      } else {
        this.pushPreRoll(overflow)
      }
    }
  }

  private enqueueTranscription(pcm: Float32Array, mode: DictationMode, epoch: number): void {
    this.transcribeQueue = this.transcribeQueue
      .then(async () => {
        if (epoch !== this.sessionEpoch) return
        const res = await this.workerClient.transcribe(pcm, {
          sampleRate: TARGET_SAMPLE_RATE,
          language: this.language,
        })
        if (epoch !== this.sessionEpoch) return
        const text = res.text.trim()
        if (text.length > 0) {
          const durationMs =
            res.durationMs > 0 ? res.durationMs : Math.round((pcm.length / TARGET_SAMPLE_RATE) * 1000)
          try {
            this.onFinalTranscript?.(text, { durationMs, mode })
          } catch {
            // Observer errors must not break session pipeline.
          }
        }
      })
      .catch((err) => {
        if (epoch === this.sessionEpoch) {
          this.emitError(err instanceof Error ? err : new Error(String(err)))
        }
      })
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
    this.inUtterance = false
    this.utteranceChunks = []
    this.utteranceSamples = 0
    this.trailingSilenceSamples = 0
  }

  private async teardownCapture(): Promise<void> {
    const handle = this.captureHandle
    this.captureHandle = null
    if (handle) {
      await this.safeStopHandle(handle)
    }
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
      // Observer errors must not break VAD loop.
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
