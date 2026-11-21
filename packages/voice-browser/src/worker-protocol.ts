/**
 * Zero-copy ArrayBuffer message protocol between the host main thread and a speech
 * inference Web Worker (VAD, streaming/offline ASR, and VITS TTS).
 *
 * Designed for Electron (`nodeIntegrationInWorker: false`) and standard browser Workers:
 * the main thread loads/caches model binaries and transfers ownership of ArrayBuffers
 * directly into the Worker without copying.
 */

export type WorkerModelTarget = 'vad' | 'asr-stream' | 'asr-offline' | 'tts-vits'

export type WorkerErrorCode =
  | 'invalid_message'
  | 'not_initialized'
  | 'model_load_failed'
  | 'vad_failed'
  | 'asr_failed'
  | 'tts_failed'
  | 'aborted'
  | 'out_of_memory'
  | 'internal_error'

export interface WorkerModelBinary {
  /** Logical filename inside the model bundle (e.g. `model.int8.onnx`, `tokens.txt`). */
  name: string
  /** Transferable binary buffer containing verified model weights or metadata. */
  buffer: ArrayBuffer
}

// ── Main thread -> Worker requests ───────────────────────────────────────────

export interface WorkerModelLoadRequest {
  id: number
  type: 'model:load'
  target: WorkerModelTarget
  files: WorkerModelBinary[]
  config?: Record<string, string | number | boolean>
}

export interface WorkerVadProcessRequest {
  id: number
  type: 'vad:process'
  /** Float32 PCM samples transferred as an ArrayBuffer (typically 16 kHz mono). */
  pcm: ArrayBuffer
  sampleRate: number
}

export interface WorkerVadResetRequest {
  id: number
  type: 'vad:reset'
}

export interface WorkerAsrStreamStartRequest {
  id: number
  type: 'asr:stream-start'
  sessionId: string
  language?: string
}

export interface WorkerAsrStreamPushRequest {
  id: number
  type: 'asr:stream-push'
  sessionId: string
  /** Float32 PCM chunk transferred as an ArrayBuffer. */
  pcm: ArrayBuffer
  sampleRate: number
}

export interface WorkerAsrStreamFinishRequest {
  id: number
  type: 'asr:stream-finish'
  sessionId: string
  /** Optional full utterance PCM buffer for offline finalization (e.g. SenseVoice). */
  fullPcm?: ArrayBuffer
  sampleRate?: number
}

export interface WorkerAsrTranscribeRequest {
  id: number
  type: 'asr:transcribe'
  /** Full Float32 PCM utterance transferred as an ArrayBuffer. */
  pcm: ArrayBuffer
  sampleRate: number
  language?: string
}

export interface WorkerTtsSynthesizeRequest {
  id: number
  type: 'tts:synthesize'
  text: string
  speakerId?: number
  speed?: number
}

export interface WorkerCancelRequest {
  id: number
  type: 'worker:cancel'
  targetId?: number
}

export interface WorkerDisposeRequest {
  id: number
  type: 'worker:dispose'
}

export type WorkerRequest =
  | WorkerModelLoadRequest
  | WorkerVadProcessRequest
  | WorkerVadResetRequest
  | WorkerAsrStreamStartRequest
  | WorkerAsrStreamPushRequest
  | WorkerAsrStreamFinishRequest
  | WorkerAsrTranscribeRequest
  | WorkerTtsSynthesizeRequest
  | WorkerCancelRequest
  | WorkerDisposeRequest

// ── Worker -> Main thread responses ──────────────────────────────────────────

export interface WorkerModelLoadedResponse {
  id: number
  type: 'model:loaded'
  target: WorkerModelTarget
  elapsedMs: number
}

export interface WorkerVadResultResponse {
  id: number
  type: 'vad:result'
  speechProbability: number
  isSpeech: boolean
  speechEnded: boolean
}

export interface WorkerAsrPartialResponse {
  id: number
  type: 'asr:partial'
  sessionId: string
  text: string
}

export interface WorkerAsrFinalResponse {
  id: number
  type: 'asr:final'
  sessionId?: string
  text: string
  language?: string
  durationMs: number
}

export interface WorkerTtsResultResponse {
  id: number
  type: 'tts:result'
  /** Synthesized audio payload (Float32 PCM or encoded WAV) transferred back zero-copy. */
  audio: ArrayBuffer
  sampleRate: number
  channels: number
  mime: string
}

export interface WorkerAckResponse {
  id: number
  type: 'worker:ack'
}

export interface WorkerErrorResponse {
  id: number
  type: 'worker:error'
  code: WorkerErrorCode
  message: string
  retryable?: boolean
}

export type WorkerResponse =
  | WorkerModelLoadedResponse
  | WorkerVadResultResponse
  | WorkerAsrPartialResponse
  | WorkerAsrFinalResponse
  | WorkerTtsResultResponse
  | WorkerAckResponse
  | WorkerErrorResponse

// ── Helpers for zero-copy transfer lists & runtime guards ────────────────────

/** Collect unique ArrayBuffer transferables from a `WorkerRequest` for `worker.postMessage(req, transfer)`. */
export function collectRequestTransferables(req: WorkerRequest): Transferable[] {
  const seen = new Set<ArrayBuffer>()
  const add = (buf: ArrayBuffer | undefined): void => {
    if (buf instanceof ArrayBuffer) seen.add(buf)
  }

  switch (req.type) {
    case 'model:load':
      if (Array.isArray(req.files)) {
        for (const file of req.files) {
          if (file) add(file.buffer)
        }
      }
      break
    case 'vad:process':
    case 'asr:stream-push':
    case 'asr:transcribe':
      add(req.pcm)
      break
    case 'asr:stream-finish':
      add(req.fullPcm)
      break
    default:
      break
  }

  return Array.from(seen)
}

/** Collect unique ArrayBuffer transferables from a `WorkerResponse` for `self.postMessage(res, transfer)`. */
export function collectResponseTransferables(res: WorkerResponse): Transferable[] {
  if (res.type === 'tts:result' && res.audio instanceof ArrayBuffer) {
    return [res.audio]
  }
  return []
}

const REQUEST_TYPES = new Set<WorkerRequest['type']>([
  'model:load',
  'vad:process',
  'vad:reset',
  'asr:stream-start',
  'asr:stream-push',
  'asr:stream-finish',
  'asr:transcribe',
  'tts:synthesize',
  'worker:cancel',
  'worker:dispose',
])

const RESPONSE_TYPES = new Set<WorkerResponse['type']>([
  'model:loaded',
  'vad:result',
  'asr:partial',
  'asr:final',
  'tts:result',
  'worker:ack',
  'worker:error',
])

export function isWorkerRequest(msg: unknown): msg is WorkerRequest {
  if (typeof msg !== 'object' || msg === null) return false
  const rec = msg as { id?: unknown; type?: unknown }
  return (
    typeof rec.id === 'number' &&
    Number.isInteger(rec.id) &&
    rec.id >= 0 &&
    typeof rec.type === 'string' &&
    REQUEST_TYPES.has(rec.type as WorkerRequest['type'])
  )
}

export function isWorkerResponse(msg: unknown): msg is WorkerResponse {
  if (typeof msg !== 'object' || msg === null) return false
  const rec = msg as { id?: unknown; type?: unknown }
  return (
    typeof rec.id === 'number' &&
    Number.isInteger(rec.id) &&
    rec.id >= 0 &&
    typeof rec.type === 'string' &&
    RESPONSE_TYPES.has(rec.type as WorkerResponse['type'])
  )
}

export function createWorkerError(
  id: number,
  code: WorkerErrorCode,
  message: string,
  retryable = false,
): WorkerErrorResponse {
  return { id, type: 'worker:error', code, message, retryable }
}
