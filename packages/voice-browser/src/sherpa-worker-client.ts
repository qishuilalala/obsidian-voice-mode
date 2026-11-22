/**
 * Main-thread client for the sherpa-onnx WASM Web Worker with lazy spawning,
 * concurrent `ensure*Loaded()` deduplication, idle auto-unload (`idleUnloadMs`),
 * `setKeepAlive` lock for active microphone sessions, and crash recovery.
 */

import { TARGET_SAMPLE_RATE } from './resample.ts'
import {
  collectRequestTransferables,
  isWorkerResponse,
  type WorkerAsrFinalResponse,
  type WorkerErrorCode,
  type WorkerModelBinary,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerTtsResultResponse,
  type WorkerVadResultResponse,
} from './worker-protocol.ts'

function scheduleTimer(callback: () => void, ms?: number): ReturnType<typeof setTimeout> {
  const fn = typeof setTimeout === 'function' ? setTimeout : undefined
  if (!fn) {
    throw new Error('Timer API is unavailable in this runtime')
  }
  return fn(callback, ms)
}

function cancelTimer(id: ReturnType<typeof setTimeout> | undefined): void {
  const fn = typeof clearTimeout === 'function' ? clearTimeout : undefined
  if (fn && id !== undefined) {
    fn(id)
  }
}

export type SherpaLoadableTarget = 'vad' | 'asr-offline' | 'tts-vits'

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: { message?: string }) => void) | null
}

export interface SherpaWorkerClientOptions {
  createWorkerSource: () => Promise<string> | string
  loadModelBinaries: (
    target: 'vad' | 'asr-offline' | 'tts-vits',
    includeWasm: boolean,
  ) => Promise<WorkerModelBinary[]>
  workerFactory?: (scriptSource: string) => { worker: WorkerLike; revoke?: () => void }
  modelConfigs?: Partial<
    Record<'vad' | 'asr-offline' | 'tts-vits', Record<string, string | number | boolean>>
  >
  /** Per-request timeout in ms (default: 45000). */
  requestTimeoutMs?: number
  /** Idle auto-unload timeout in ms (default: 300000 = 5 min; <= 0 disables auto-unload). */
  idleUnloadMs?: number
  /** Invoked after the idle timer unloads and terminates the Worker. */
  onIdleUnload?: () => void
}

export class SherpaWorkerError extends Error {
  readonly code: WorkerErrorCode
  readonly retryable: boolean

  constructor(code: WorkerErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'SherpaWorkerError'
    this.code = code
    this.retryable = retryable
  }
}

interface PendingRequest {
  resolve: (res: WorkerResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000
const DEFAULT_IDLE_UNLOAD_MS = 300_000
const DISPOSE_GRACE_TIMEOUT_MS = 2_000

function defaultWorkerFactory(scriptSource: string): { worker: WorkerLike; revoke: () => void } {
  const blob = new Blob([scriptSource], { type: 'application/javascript;charset=utf-8' })
  const blobUrl = URL.createObjectURL(blob)
  let revoked = false
  const revoke = (): void => {
    if (revoked) return
    revoked = true
    URL.revokeObjectURL(blobUrl)
  }
  try {
    const worker = new Worker(blobUrl) as unknown as WorkerLike
    return { worker, revoke }
  } catch (err) {
    revoke()
    throw err
  }
}

export class SherpaWorkerClient {
  private readonly createWorkerSource: () => Promise<string> | string
  private readonly loadModelBinaries: (
    target: SherpaLoadableTarget,
    includeWasm: boolean,
  ) => Promise<WorkerModelBinary[]>
  private readonly workerFactory: (scriptSource: string) => {
    worker: WorkerLike
    revoke?: () => void
  }
  private readonly modelConfigs: Partial<
    Record<SherpaLoadableTarget, Record<string, string | number | boolean>>
  >
  private readonly requestTimeoutMs: number
  private idleUnloadMs: number
  private readonly onIdleUnload?: () => void

  private worker: WorkerLike | null = null
  private revokeWorkerUrl: (() => void) | undefined = undefined
  private spawningWorker: Promise<WorkerLike> | null = null
  private workerGeneration = 0

  private wasmInitialized = false
  private readonly loadedTargets = new Set<SherpaLoadableTarget>()
  private readonly inFlightLoads = new Map<SherpaLoadableTarget, Promise<void>>()
  private loadSerializeChain: Promise<void> = Promise.resolve()

  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private activeRequests = 0
  private keepAlive = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(options: SherpaWorkerClientOptions) {
    this.createWorkerSource = options.createWorkerSource
    this.loadModelBinaries = options.loadModelBinaries
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory
    this.modelConfigs = options.modelConfigs ?? {}
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    this.idleUnloadMs = options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS
    this.onIdleUnload = options.onIdleUnload
  }

  /** Lock/unlock idle auto-unload (e.g. while microphone capture is active). */
  setKeepAlive(active: boolean): void {
    this.keepAlive = active
    if (active) {
      this.clearIdleTimer()
    } else if (this.activeRequests === 0 && this.worker !== null && !this.disposed) {
      this.scheduleIdleTimer()
    }
  }

  /** Dynamically reconfigure the idle auto-unload delay (`<= 0` disables auto-unload). */
  updateIdleUnloadMs(ms: number): void {
    this.idleUnloadMs = ms
    this.clearIdleTimer()
    if (!this.disposed && !this.keepAlive && this.activeRequests === 0 && this.worker !== null) {
      this.scheduleIdleTimer()
    }
  }

  /**
   * Update model initialization parameters for a target (`vad`, `asr-offline`, `tts-vits`).
   * If the target is currently loaded with different parameters, marks it stale so the next
   * inference call reloads it cleanly in place (`freeInstance` + fresh config).
   */
  updateModelConfig(
    target: SherpaLoadableTarget,
    config: Record<string, string | number | boolean>,
  ): void {
    const prevJson = JSON.stringify(this.modelConfigs[target] ?? {})
    const nextConfig = { ...config }
    const nextJson = JSON.stringify(nextConfig)
    this.modelConfigs[target] = nextConfig
    if (prevJson !== nextJson) {
      this.loadedTargets.delete(target)
    }
  }

  isLoaded(target: SherpaLoadableTarget): boolean {
    return this.loadedTargets.has(target) && this.worker !== null
  }

  ensureVadLoaded(): Promise<void> {
    return this.ensureTargetLoaded('vad')
  }

  ensureAsrLoaded(): Promise<void> {
    return this.ensureTargetLoaded('asr-offline')
  }

  ensureTtsLoaded(): Promise<void> {
    return this.ensureTargetLoaded('tts-vits')
  }

  async processVad(pcm16k: Float32Array): Promise<WorkerVadResultResponse> {
    this.assertNotDisposed()
    await this.ensureVadLoaded()
    // Copy into a tight owned buffer so caller views/ring buffers are never detached.
    const owned = pcm16k.slice()
    const res = await this.sendRequest({
      id: this.allocId(),
      type: 'vad:process',
      pcm: owned.buffer,
      sampleRate: TARGET_SAMPLE_RATE,
    })
    if (res.type !== 'vad:result') {
      throw new Error(`Unexpected worker response for vad:process: ${res.type}`)
    }
    return res
  }

  async resetVad(): Promise<void> {
    this.assertNotDisposed()
    if (!this.isLoaded('vad')) return
    const res = await this.sendRequest({
      id: this.allocId(),
      type: 'vad:reset',
    })
    if (res.type !== 'worker:ack') {
      throw new Error(`Unexpected worker response for vad:reset: ${res.type}`)
    }
  }

  async transcribe(
    pcm16k: Float32Array,
    options?: { sampleRate?: number; language?: string },
  ): Promise<WorkerAsrFinalResponse> {
    this.assertNotDisposed()
    if (options?.language) {
      const currentAsrCfg = this.modelConfigs['asr-offline'] ?? {}
      if (currentAsrCfg.language !== options.language) {
        this.updateModelConfig('asr-offline', {
          ...currentAsrCfg,
          language: options.language,
        })
      }
    }
    await this.ensureAsrLoaded()
    const owned = pcm16k.slice()
    const res = await this.sendRequest({
      id: this.allocId(),
      type: 'asr:transcribe',
      pcm: owned.buffer,
      sampleRate: options?.sampleRate ?? TARGET_SAMPLE_RATE,
      language: options?.language,
    })
    if (res.type !== 'asr:final') {
      throw new Error(`Unexpected worker response for asr:transcribe: ${res.type}`)
    }
    return res
  }

  async synthesizeTts(
    text: string,
    options?: { speakerId?: number; speed?: number },
  ): Promise<WorkerTtsResultResponse> {
    this.assertNotDisposed()
    await this.ensureTtsLoaded()
    const res = await this.sendRequest({
      id: this.allocId(),
      type: 'tts:synthesize',
      text,
      speakerId: options?.speakerId,
      speed: options?.speed,
    })
    if (res.type !== 'tts:result') {
      throw new Error(`Unexpected worker response for tts:synthesize: ${res.type}`)
    }
    return res
  }

  async unload(): Promise<void> {
    this.clearIdleTimer()
    // Detach worker, pending requests, and loaded state synchronously BEFORE awaiting
    // best-effort disposal so any concurrent `ensure*Loaded()` / `start()` spawns a fresh
    // generation Worker without racing against teardown.
    this.workerGeneration++
    const spawning = this.spawningWorker
    let workerToClose = this.worker
    const revokeToCall = this.revokeWorkerUrl

    this.worker = null
    this.revokeWorkerUrl = undefined
    this.spawningWorker = null
    this.resetWorkerState()

    const unloadReason = new Error('Worker unloaded')
    const pendingEntries = Array.from(this.pending.values())
    this.pending.clear()
    for (const entry of pendingEntries) {
      cancelTimer(entry.timer)
      entry.reject(unloadReason)
    }

    if (!workerToClose && spawning) {
      try {
        workerToClose = await spawning
      } catch {
        // Spawn cancelled or failed; nothing to dispose.
      }
    }

    if (workerToClose) {
      workerToClose.onerror = null
      try {
        await this.sendDetachedDisposeBestEffort(workerToClose)
      } catch {
        // Proceed with hard terminate regardless.
      }
      workerToClose.onmessage = null
      try {
        workerToClose.terminate()
      } catch {
        // Ignore terminate errors.
      }
    }

    if (revokeToCall) {
      try {
        revokeToCall()
      } catch {
        // Ignore revoke errors.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.keepAlive = false
    await this.unload()
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('SherpaWorkerClient is disposed')
    }
  }

  private allocId(): number {
    return this.nextRequestId++
  }

  private beginActivity(): void {
    this.activeRequests++
    this.clearIdleTimer()
  }

  private endActivity(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1)
    if (this.activeRequests === 0 && !this.keepAlive && !this.disposed && this.worker !== null) {
      this.scheduleIdleTimer()
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      cancelTimer(this.idleTimer)
      this.idleTimer = null
    }
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer()
    if (this.idleUnloadMs <= 0 || this.keepAlive || this.disposed || this.worker === null) {
      return
    }
    this.idleTimer = scheduleTimer(() => {
      this.idleTimer = null
      if (this.activeRequests > 0 || this.keepAlive || this.disposed || this.worker === null) {
        return
      }
      void this.handleIdleTimeout()
    }, this.idleUnloadMs)
  }

  private async handleIdleTimeout(): Promise<void> {
    if (this.activeRequests > 0 || this.keepAlive || this.disposed || this.worker === null) {
      return
    }
    await this.unload()
    try {
      this.onIdleUnload?.()
    } catch {
      // Observer errors must not escape timer callback.
    }
  }

  private ensureWorker(): Promise<WorkerLike> {
    if (this.worker) return Promise.resolve(this.worker)
    if (this.spawningWorker) return this.spawningWorker

    const gen = ++this.workerGeneration
    const promise = (async (): Promise<WorkerLike> => {
      const source = await this.createWorkerSource()
      if (this.disposed || gen !== this.workerGeneration) {
        throw new Error('Worker spawn cancelled')
      }
      const { worker, revoke } = this.workerFactory(source)
      worker.onmessage = (ev: { data: unknown }) => {
        if (gen !== this.workerGeneration) return
        this.handleWorkerMessage(ev.data)
      }
      worker.onerror = (ev: { message?: string }) => {
        if (gen !== this.workerGeneration) return
        const reason = ev?.message ? `Sherpa worker crashed: ${ev.message}` : 'Sherpa worker crashed'
        this.teardownWorkerSync(new Error(reason))
      }
      this.worker = worker
      this.revokeWorkerUrl = revoke
      return worker
    })()

    this.spawningWorker = promise
    void promise.then(
      () => {
        if (this.spawningWorker === promise) this.spawningWorker = null
      },
      () => {
        if (this.spawningWorker === promise) this.spawningWorker = null
      },
    )
    return promise
  }

  private ensureTargetLoaded(target: SherpaLoadableTarget): Promise<void> {
    this.assertNotDisposed()
    const conflictingTarget: SherpaLoadableTarget | null =
      target === 'asr-offline' ? 'tts-vits' : target === 'tts-vits' ? 'asr-offline' : null
    if (this.isLoaded(target) && (!conflictingTarget || !this.inFlightLoads.has(conflictingTarget))) {
      return Promise.resolve()
    }

    const existing = this.inFlightLoads.get(target)
    if (existing) return existing

    // Serialize actual `model:load` execution across targets so concurrent cold-start
    // `ensureVadLoaded()` + `ensureAsrLoaded()` never fetch/transfer `sherpa-onnx.wasm` twice.
    const loadPromise = new Promise<void>((resolve, reject) => {
      this.loadSerializeChain = this.loadSerializeChain.then(async () => {
        this.beginActivity()
        try {
          this.assertNotDisposed()
          if (this.isLoaded(target)) {
            resolve()
            return
          }
          await this.ensureWorker()
          const gen = this.workerGeneration
          const includeWasm = !this.wasmInitialized
          const files = await this.loadModelBinaries(target, includeWasm)
          if (this.disposed || gen !== this.workerGeneration) {
            throw new Error(`Model load (${target}) aborted due to worker reset`)
          }

          const res = await this.sendRequestRaw(
            {
              id: this.allocId(),
              type: 'model:load',
              target,
              files,
              config: this.modelConfigs[target],
            },
            this.requestTimeoutMs,
          )
          if (res.type !== 'model:loaded') {
            throw new Error(`Unexpected worker response for model:load: ${res.type}`)
          }
          if (gen === this.workerGeneration) {
            this.wasmInitialized = true
            // Single-heavy-model mutual exclusion (ADR-0002): SenseVoice and VITS evict each other,
            // while Silero VAD remains co-resident for live barge-in monitoring.
            if (target === 'asr-offline') {
              this.loadedTargets.delete('tts-vits')
            } else if (target === 'tts-vits') {
              this.loadedTargets.delete('asr-offline')
            }
            this.loadedTargets.add(target)
          }
          resolve()
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        } finally {
          if (this.inFlightLoads.get(target) === loadPromise) {
            this.inFlightLoads.delete(target)
          }
          this.endActivity()
        }
      })
    })

    this.inFlightLoads.set(target, loadPromise)
    return loadPromise
  }

  private async sendRequest(req: WorkerRequest): Promise<WorkerResponse> {
    this.beginActivity()
    try {
      await this.ensureWorker()
      return await this.sendRequestRaw(req, this.requestTimeoutMs)
    } finally {
      this.endActivity()
    }
  }

  private sendRequestRaw(req: WorkerRequest, timeoutMs: number): Promise<WorkerResponse> {
    const worker = this.worker
    if (!worker) {
      return Promise.reject(new Error('Sherpa worker is not running'))
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = scheduleTimer(() => {
        this.pending.delete(req.id)
        const err = new Error(`Sherpa worker request ${req.type} (#${req.id}) timed out after ${timeoutMs}ms`)
        this.teardownWorkerSync(err)
        reject(err)
      }, timeoutMs)

      this.pending.set(req.id, { resolve, reject, timer })

      try {
        const transfer = collectRequestTransferables(req)
        if (transfer.length > 0) {
          worker.postMessage(req, transfer)
        } else {
          worker.postMessage(req)
        }
      } catch (err) {
        cancelTimer(timer)
        this.pending.delete(req.id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private sendDetachedDisposeBestEffort(worker: WorkerLike): Promise<void> {
    const req: WorkerRequest = { id: this.allocId(), type: 'worker:dispose' }
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        cancelTimer(timer)
        worker.onmessage = null
        resolve()
      }
      const timer = scheduleTimer(finish, Math.min(this.requestTimeoutMs, DISPOSE_GRACE_TIMEOUT_MS))
      worker.onmessage = (ev: { data: unknown }) => {
        if (isWorkerResponse(ev?.data) && ev.data.id === req.id) {
          finish()
        }
      }
      try {
        worker.postMessage(req)
      } catch {
        finish()
      }
    })
  }

  private handleWorkerMessage(data: unknown): void {
    if (!isWorkerResponse(data)) return
    const entry = this.pending.get(data.id)
    if (!entry) return
    cancelTimer(entry.timer)
    this.pending.delete(data.id)

    if (data.type === 'worker:error') {
      entry.reject(new SherpaWorkerError(data.code, data.message, data.retryable))
      return
    }
    entry.resolve(data)
  }

  private resetWorkerState(): void {
    this.wasmInitialized = false
    this.loadedTargets.clear()
    this.inFlightLoads.clear()
  }

  private teardownWorkerSync(reason: Error): void {
    this.workerGeneration++
    this.clearIdleTimer()

    const pendingEntries = Array.from(this.pending.values())
    this.pending.clear()
    for (const entry of pendingEntries) {
      cancelTimer(entry.timer)
      entry.reject(reason)
    }

    const worker = this.worker
    const revoke = this.revokeWorkerUrl
    this.worker = null
    this.revokeWorkerUrl = undefined
    this.spawningWorker = null
    this.resetWorkerState()

    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      try {
        worker.terminate()
      } catch {
        // Ignore terminate errors.
      }
    }
    if (revoke) {
      try {
        revoke()
      } catch {
        // Ignore revoke errors.
      }
    }
  }
}
