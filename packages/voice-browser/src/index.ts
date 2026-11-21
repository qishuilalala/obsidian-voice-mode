export { TARGET_SAMPLE_RATE, resampleLinear, downsampleTo16k } from './resample.ts'

export {
  VOICE_CAPTURE_PROCESSOR_NAME,
  VOICE_CAPTURE_WORKLET_SOURCE,
  createWorkletModuleUrl,
  type WorkletModuleHandle,
  type CreateWorkletUrlOptions,
} from './audio-worklet-source.ts'

export {
  probeTrackAec,
  resolveBargeInPolicy,
  type BargeInMode,
  type BargeInPolicy,
  type BargeInDowngradeReason,
  type AecProbeResult,
  type BargeInPolicyInput,
  type BargeInPolicyDecision,
  type TrackSettingsLike,
  type MediaTrackLike,
} from './aec-probe.ts'

export {
  PlaybackQueue,
  type PlaybackQueueState,
  type QueueOverflowPolicy,
  type AudioSink,
  type SynthesizeFn,
  type PlaybackQueueOptions,
} from './playback-queue.ts'

export {
  collectRequestTransferables,
  collectResponseTransferables,
  isWorkerRequest,
  isWorkerResponse,
  createWorkerError,
  type WorkerModelTarget,
  type WorkerErrorCode,
  type WorkerModelBinary,
  type WorkerModelLoadRequest,
  type WorkerVadProcessRequest,
  type WorkerVadResetRequest,
  type WorkerAsrStreamStartRequest,
  type WorkerAsrStreamPushRequest,
  type WorkerAsrStreamFinishRequest,
  type WorkerAsrTranscribeRequest,
  type WorkerTtsSynthesizeRequest,
  type WorkerCancelRequest,
  type WorkerDisposeRequest,
  type WorkerRequest,
  type WorkerModelLoadedResponse,
  type WorkerVadResultResponse,
  type WorkerAsrPartialResponse,
  type WorkerAsrFinalResponse,
  type WorkerTtsResultResponse,
  type WorkerAckResponse,
  type WorkerErrorResponse,
  type WorkerResponse,
} from './worker-protocol.ts'

export { createSherpaWorkerScript, encodePcm16Wav } from './sherpa-worker-runtime.ts'

export {
  SherpaWorkerClient,
  SherpaWorkerError,
  type SherpaLoadableTarget,
  type WorkerLike,
  type SherpaWorkerClientOptions,
} from './sherpa-worker-client.ts'

export {
  DICTATION_PRE_ROLL_MS,
  DICTATION_PRE_ROLL_SAMPLES,
  createBrowserMicCapture,
  OfflineDictationSession,
  type DictationMode,
  type DictationSessionState,
  type AudioCaptureOptions,
  type AudioCaptureHandle,
  type AudioCaptureFactory,
  type FinalTranscriptInfo,
  type StopDictationOptions,
  type OfflineDictationSessionOptions,
} from './dictation-session.ts'

export {
  VITS_DEFAULT_SPEAKER_ID,
  VITS_MIN_RATE,
  VITS_MAX_RATE,
  resolveVitsSpeakerId,
  clampVitsRate,
  VitsWasmTtsEngine,
  type VitsWasmTtsEngineOptions,
} from './vits-tts-engine.ts'

export {
  DEFAULT_BARGE_IN_CHUNK_SAMPLES,
  DEFAULT_BARGE_IN_MIN_RMS,
  DEFAULT_BARGE_IN_CONFIRM_CHUNKS,
  computeChunkRms,
  createBargeInMicCapture,
  AecBargeInMonitor,
  type BargeInMonitorState,
  type BargeInCaptureHandle,
  type BargeInCaptureFactory,
  type BargeInStartOptions,
  type BargeInStartResult,
  type BargeInEvent,
  type AecBargeInMonitorOptions,
} from './barge-in-monitor.ts'
